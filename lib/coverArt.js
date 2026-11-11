// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Vinicius Bispo
// Carrega capas de álbum e devolve sempre um arquivo LOCAL, para o CSS
// (background-image + border-radius) desenhar com cantos arredondados.
//
//   file://   → usa o arquivo direto
//   data:     → decodifica e grava em ~/.cache/wavebar-music/covers/
//   http(s):// → baixa com Soup 3 (assíncrono) e grava no mesmo cache

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {DiskCache, LruMap} from './cache.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');

const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024; // capa maior que isso é suspeita
const MAX_DISK_FILES = 300;
const MAX_MEMORY_ENTRIES = 200;

export function isCancelled(e) {
    return e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) ?? false;
}

export class CoverArtLoader {
    constructor(session, cacheDir) {
        this._session = session;
        this._disk = new DiskCache(GLib.build_filenamev([cacheDir, 'covers']), MAX_DISK_FILES);
        this._memory = new LruMap(MAX_MEMORY_ENTRIES); // url → caminho local (ou null)
    }

    /**
     * Devolve o caminho local da capa, ou null se não houver/der erro.
     * @param {string} url - mpris:artUrl
     * @param {Gio.Cancellable} cancellable - cancelado quando a faixa muda
     */
    async load(url, cancellable) {
        if (!url)
            return null;
        if (this._memory.has(url))
            return this._memory.get(url);

        let path = null;
        try {
            if (url.startsWith('file://'))
                path = this._fromFile(url);
            else if (url.startsWith('data:'))
                path = await this._fromData(url, cancellable);
            else if (/^https?:\/\//i.test(url))
                path = await this._fromHttp(url, cancellable);
            else
                console.log(`[Wavebar Music] Esquema de capa não suportado: ${url.slice(0, 40)}`);
        } catch (e) {
            if (isCancelled(e))
                throw e;
            console.log(`[Wavebar Music] Não consegui carregar a capa (${url.slice(0, 60)}): ${e.message}`);
        }

        // Só memoriza sucessos vindos da rede/data: — um arquivo local pode
        // sumir/mudar, e uma falha de rede pode ser passageira.
        if (path && !url.startsWith('file://'))
            this._memory.set(url, path);
        return path;
    }

    _fromFile(url) {
        const file = Gio.File.new_for_uri(url);
        return file.query_exists(null) ? file.get_path() : null;
    }

    async _write(file, bytes, cancellable) {
        await this._disk.ensure();
        await file.replace_contents_bytes_async(bytes, null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, cancellable);
        return file.get_path();
    }

    async _fromData(url, cancellable) {
        const file = this._disk.fileFor(url);
        if (file.query_exists(null))
            return file.get_path();

        // data:[<mime>][;base64],<dados>
        const comma = url.indexOf(',');
        if (comma < 0)
            throw new Error('URI data: malformada');
        const header = url.slice(5, comma);
        const payload = url.slice(comma + 1);
        const bytes = header.endsWith(';base64')
            ? GLib.base64_decode(decodeURIComponent(payload))
            : new TextEncoder().encode(decodeURIComponent(payload));
        return this._write(file, new GLib.Bytes(bytes), cancellable);
    }

    async _fromHttp(url, cancellable) {
        const file = this._disk.fileFor(url);
        if (file.query_exists(null))
            return file.get_path();

        const message = Soup.Message.new('GET', url);
        if (!message)
            throw new Error('URL inválida');
        const bytes = await this._session.send_and_read_async(
            message, GLib.PRIORITY_LOW, cancellable);

        if (message.get_status() !== Soup.Status.OK)
            throw new Error(`HTTP ${message.get_status()}`);
        const type = message.get_response_headers().get_content_type()[0] ?? '';
        if (!type.startsWith('image/'))
            throw new Error(`tipo inesperado: ${type}`);
        if (bytes.get_size() > MAX_DOWNLOAD_BYTES)
            throw new Error('imagem grande demais');

        return this._write(file, bytes, cancellable);
    }

    destroy() {
        this._memory.clear();
        this._session = null;
    }
}
