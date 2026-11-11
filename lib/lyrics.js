// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Vinicius Bispo
// Busca letras no LRCLIB (https://lrclib.net) com Soup 3, sem travar o Shell.
//
// Ordem: /api/get (busca exata) → /api/search (título + artista)
//        → /api/search?q= (texto livre com o título "limpo").
// Cache: memória (por sessão) + disco em ~/.cache/wavebar/lyrics/.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {DiskCache, LruMap} from './cache.js';
import {forceSplitArtistTitle, pickBestResult, splitArtistTitle, toLyrics} from './lrc.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');
Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');

const API = 'https://lrclib.net/api';
const MAX_MEMORY_ENTRIES = 100;
const MAX_DISK_FILES = 1000; // ~3 KB cada
const NOT_FOUND = {kind: 'not-found'};

/** Erro de rede/servidor (diferente de "não encontrada"). */
export class LyricsNetworkError extends Error {}

export class LyricsClient {
    constructor(session, cacheDir) {
        this._session = session;
        this._disk = new DiskCache(GLib.build_filenamev([cacheDir, 'lyrics']), MAX_DISK_FILES);
        this._memory = new LruMap(MAX_MEMORY_ENTRIES); // chave → resultado
    }

    static keyFor({title, artists, album, length}) {
        const seconds = Math.round((length ?? 0) / 1e6);
        return [title, (artists ?? []).join(', '), album, seconds].join('␟').toLowerCase();
    }

    /**
     * @param {object} track - {title, artists, album, length (µs)}
     * @param {Gio.Cancellable} cancellable - cancelado ao trocar de faixa
     * @returns {Promise<object>} {kind: 'synced'|'plain'|'instrumental'|'not-found', …}
     * @throws {LyricsNetworkError} sem rede / servidor fora; Gio CANCELLED se cancelado
     */
    async fetch(track, cancellable) {
        if (!track.title)
            return NOT_FOUND;

        const key = LyricsClient.keyFor(track);
        if (this._memory.has(key))
            return this._memory.get(key);

        const cacheFile = this._disk.fileFor(key, '.json');
        let result = await this._readDisk(cacheFile, cancellable);

        if (!result) {
            const found = await this._lookup(track, cancellable);
            result = toLyrics(found?.record, {allowSynced: found?.durationMatch}) ?? NOT_FOUND;
            // "Não encontrada" fica só na memória: a letra pode ser cadastrada depois.
            if (result.kind !== 'not-found')
                this._writeDisk(cacheFile, result);
        }

        this._memory.set(key, result);
        return result;
    }

    // Devolve {record, durationMatch} ou null.
    async _lookup({title, artists, album, length}, cancellable) {
        const artist = artists?.[0] ?? '';
        const durationS = Math.round((length ?? 0) / 1e6);

        // 1) Busca exata. O LRCLIB aceita sem álbum; a duração ajuda a achar a versão certa.
        if (artist) {
            const params = {track_name: title, artist_name: artist};
            if (album)
                params.album_name = album;
            if (durationS > 0)
                params.duration = String(durationS);
            const exact = await this._request('/get', params, cancellable);
            if (exact && toLyrics(exact))
                return {record: exact, durationMatch: true};
        }

        // 2) Busca por campos com título limpo e, em vídeos, "Artista - Música"
        //    separado ("a-ha - Take On Me (Vídeo oficial)" → a-ha / Take On Me).
        const guess = splitArtistTitle(title, artist);
        const want = {...guess, durationS};
        const params = {track_name: guess.title};
        if (guess.artist)
            params.artist_name = guess.artist;
        const byFields = pickBestResult(await this._request('/search', params, cancellable), want);
        if (byFields?.durationMatch)
            return byFields;

        // 3) Texto livre: pega grafias diferentes do artista.
        const byText = pickBestResult(await this._request('/search',
            {q: `${guess.artist} ${guess.title}`.trim()}, cancellable), want);
        if (byText?.durationMatch)
            return byText;

        // 4) Vídeo de canal de terceiros ("LoopMusic"): "X - Y" à força, sem parênteses.
        const forced = forceSplitArtistTitle(title);
        let byForced = null;
        if (forced && (forced.artist !== guess.artist || forced.title !== guess.title)) {
            byForced = pickBestResult(await this._request('/search',
                {q: `${forced.artist} ${forced.title}`}, cancellable), {...forced, durationS});
            if (byForced?.durationMatch)
                return byForced;
        }

        // Só versões com duração diferente: serve como letra sem sincronia.
        return byFields ?? byText ?? byForced;
    }

    // Devolve o JSON, ou null em 404. Lança LyricsNetworkError nos outros erros.
    async _request(path, params, cancellable) {
        const message = Soup.Message.new_from_encoded_form('GET', `${API}${path}`,
            Soup.form_encode_hash(params));

        let bytes;
        try {
            bytes = await this._session.send_and_read_async(
                message, GLib.PRIORITY_DEFAULT, cancellable);
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw e;
            throw new LyricsNetworkError(e.message);
        }

        const status = message.get_status();
        if (status === Soup.Status.NOT_FOUND)
            return null;
        if (status !== Soup.Status.OK)
            throw new LyricsNetworkError(`HTTP ${status}`);

        try {
            return JSON.parse(new TextDecoder().decode(bytes.get_data()));
        } catch {
            throw new LyricsNetworkError('resposta inválida do servidor');
        }
    }

    async _readDisk(file, cancellable) {
        try {
            const [contents] = await file.load_contents_async(cancellable);
            const data = JSON.parse(new TextDecoder().decode(contents));
            return ['synced', 'plain', 'instrumental'].includes(data?.kind) ? data : null;
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw e;
            return null; // não existe ou está corrompido: busca de novo
        }
    }

    // Grava em segundo plano; falhar aqui não pode atrapalhar a exibição.
    async _writeDisk(file, result) {
        try {
            await this._disk.ensure();
            const bytes = new GLib.Bytes(new TextEncoder().encode(JSON.stringify(result)));
            await file.replace_contents_bytes_async(bytes, null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            console.log(`[Wavebar] Não consegui salvar a letra no cache: ${e.message}`);
        }
    }

    destroy() {
        this._memory.clear();
        this._session = null;
    }
}
