// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Vinicius Bispo
// Utilitários de cache: memória com limite (LRU) e pasta em disco com limite de arquivos.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'close_async');
Gio._promisify(Gio.File.prototype, 'delete_async');

/** Map com tamanho máximo: ao passar do limite, descarta o item usado há mais tempo. */
export class LruMap {
    constructor(limit) {
        this._limit = limit;
        this._map = new Map();
    }

    has(key) {
        return this._map.has(key);
    }

    get(key) {
        if (!this._map.has(key))
            return undefined;
        const value = this._map.get(key);
        // Reinsere para marcar como "usado agora" (Map mantém ordem de inserção).
        this._map.delete(key);
        this._map.set(key, value);
        return value;
    }

    set(key, value) {
        this._map.delete(key);
        this._map.set(key, value);
        if (this._map.size > this._limit)
            this._map.delete(this._map.keys().next().value);
    }

    clear() {
        this._map.clear();
    }

    get size() {
        return this._map.size;
    }
}

/** Pasta de cache em disco: cria sob demanda e mantém no máximo `maxFiles` arquivos. */
export class DiskCache {
    constructor(dirPath, maxFiles) {
        this._dir = Gio.File.new_for_path(dirPath);
        this._maxFiles = maxFiles;
        this._ready = null;
    }

    /** Arquivo de cache para uma chave qualquer (nome = SHA-256 da chave). */
    fileFor(key, extension = '') {
        const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, key, -1);
        return this._dir.get_child(`${hash}${extension}`);
    }

    /** Garante que a pasta existe; na primeira vez, também faz a limpeza. */
    ensure() {
        this._ready ??= (async () => {
            try {
                this._dir.make_directory_with_parents(null);
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                    throw e;
            }
            await this._prune().catch(e =>
                console.log(`[Wavebar] Limpeza do cache falhou: ${e.message}`));
        })();
        return this._ready;
    }

    // Apaga os arquivos mais antigos além do limite (roda uma vez por sessão).
    async _prune() {
        const enumerator = await this._dir.enumerate_children_async(
            'standard::name,time::modified', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_LOW, null);
        const infos = [];
        for (;;) {
            // eslint-disable-next-line no-await-in-loop
            const batch = await enumerator.next_files_async(100, GLib.PRIORITY_LOW, null);
            if (batch.length === 0)
                break;
            infos.push(...batch);
        }
        await enumerator.close_async(GLib.PRIORITY_LOW, null);

        if (infos.length <= this._maxFiles)
            return;
        const mtime = i => i.get_modification_date_time()?.to_unix() ?? 0;
        infos.sort((a, b) => mtime(b) - mtime(a));
        for (const info of infos.slice(this._maxFiles)) {
            // eslint-disable-next-line no-await-in-loop
            await this._dir.get_child(info.get_name())
                .delete_async(GLib.PRIORITY_LOW, null).catch(() => {});
        }
    }
}
