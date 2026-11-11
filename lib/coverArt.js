// SPDX-License-Identifier: GPL-3.0-or-later
// Carrega capas de álbum e devolve sempre um arquivo LOCAL, para o CSS
// (background-image + border-radius) desenhar com cantos arredondados.
//
//   file://   → usa o arquivo direto
//   data:     → decodifica e grava em ~/.cache/wavebar/covers/
//   http(s):// → baixa com Soup 3 (assíncrono) e grava no mesmo cache

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gio.File.prototype, 'make_directory_async');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.File.prototype, 'delete_async');

const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024; // capa maior que isso é suspeita
const MAX_CACHED_FILES = 300;               // limpeza simples do cache em disco

export function isCancelled(e) {
    return e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) ?? false;
}

export class CoverArtLoader {
    constructor(session, cacheDir) {
        this._session = session;
        this._dir = Gio.File.new_for_path(GLib.build_filenamev([cacheDir, 'covers']));
        this._memory = new Map(); // url → caminho local (ou null se falhou)
        this._dirReady = null;
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
                console.log(`[Wavebar] Esquema de capa não suportado: ${url.slice(0, 40)}`);
        } catch (e) {
            if (isCancelled(e))
                throw e;
            console.log(`[Wavebar] Não consegui carregar a capa (${url.slice(0, 60)}): ${e.message}`);
        }

        // Arquivos locais podem mudar de conteúdo (players reutilizam nomes),
        // então só guardamos na memória o que veio da rede ou de data:.
        if (!url.startsWith('file://'))
            this._memory.set(url, path);
        return path;
    }

    _fromFile(url) {
        const file = Gio.File.new_for_uri(url);
        return file.query_exists(null) ? file.get_path() : null;
    }

    _cacheFile(url) {
        const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, url, -1);
        return this._dir.get_child(hash);
    }

    async _ensureDir() {
        this._dirReady ??= this._dir.make_directory_async(GLib.PRIORITY_DEFAULT, null)
            .catch(e => {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) {
                    // Pastas intermediárias (~/.cache/wavebar) ainda não existem.
                    this._dir.make_directory_with_parents(null);
                }
            })
            .then(() => this._prune())
            .catch(e => console.log(`[Wavebar] Cache de capas: ${e.message}`));
        await this._dirReady;
    }

    async _write(file, bytes, cancellable) {
        await this._ensureDir();
        await file.replace_contents_bytes_async(bytes, null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, cancellable);
        return file.get_path();
    }

    async _fromData(url, cancellable) {
        const file = this._cacheFile(url);
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
        const file = this._cacheFile(url);
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

    // Mantém no máximo MAX_CACHED_FILES capas (apaga as mais antigas).
    async _prune() {
        const attrs = 'standard::name,time::modified';
        const enumerator = await this._dir.enumerate_children_async(attrs,
            Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, null);
        const infos = [];
        for (;;) {
            // eslint-disable-next-line no-await-in-loop
            const batch = await enumerator.next_files_async(100, GLib.PRIORITY_LOW, null);
            if (batch.length === 0)
                break;
            infos.push(...batch);
        }
        enumerator.close(null);

        if (infos.length <= MAX_CACHED_FILES)
            return;
        infos.sort((a, b) => b.get_modification_date_time().to_unix() -
            a.get_modification_date_time().to_unix());
        for (const info of infos.slice(MAX_CACHED_FILES)) {
            // eslint-disable-next-line no-await-in-loop
            await this._dir.get_child(info.get_name()).delete_async(GLib.PRIORITY_LOW, null)
                .catch(() => {});
        }
    }

    destroy() {
        this._memory.clear();
        this._session = null;
    }
}
