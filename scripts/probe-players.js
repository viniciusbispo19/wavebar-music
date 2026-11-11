#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Vinicius Bispo
//
// Diagnóstico dos players MPRIS da SUA sessão, usando as mesmas classes da
// extensão (sem precisar do Shell). Só lê: não envia comandos aos players.
//
// Uso (na raiz do projeto):  gjs -m scripts/probe-players.js
//
// Para cada player mostra: identidade, metadados normalizados, se a posição
// estimada bate com a real, se a capa carrega e o resultado da busca de letra.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import System from 'system';

import './lib/shellShim.js';
import {CoverArtLoader} from '../lib/coverArt.js';
import {LyricsClient} from '../lib/lyrics.js';
import {MprisManager} from '../lib/mpris.js';

Gio._promisify(Gio.DBusConnection.prototype, 'call');

const loop = new GLib.MainLoop(null, false);
const wait = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    r();
    return GLib.SOURCE_REMOVE;
}));

// Cache temporário: o diagnóstico não suja ~/.cache/wavebar-music.
const tmpCache = GLib.dir_make_tmp('wavebar-music-probe-XXXXXX');
const session = new Soup.Session({user_agent: 'WavebarMusic/0.3 (GNOME Shell extension)', timeout: 15});
const covers = new CoverArtLoader(session, tmpCache);
const lyrics = new LyricsClient(session, tmpCache);
const manager = new MprisManager();

async function realPosition(busName) {
    const reply = await Gio.DBus.session.call(busName, '/org/mpris/MediaPlayer2',
        'org.freedesktop.DBus.Properties', 'Get',
        new GLib.Variant('(ss)', ['org.mpris.MediaPlayer2.Player', 'Position']),
        new GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, 2000, null);
    return Number(reply.deepUnpack()[0].deepUnpack());
}

async function main() {
    manager.start();
    await wait(1500); // proxies assíncronos ficam prontos

    const all = [...manager._players.values()];
    print(`Players no barramento: ${all.length} (ativos: ${manager.players.length})`);
    print(`Atual pela regra de prioridade: ${manager.current?.busName ?? '(nenhum)'}\n`);

    for (const p of all) {
        const md = p.metadata;
        print(`■ ${p.busName}`);
        print(`  identidade: ${p.identity || '?'} | pid: ${p.pid} | ativo: ${p.isActive} | status: ${p.status}`);
        print(`  título: ${md.title || '—'} | artistas: ${md.artists.join(', ') || '—'} | álbum: ${md.album || '—'}`);
        print(`  duração: ${(md.length / 1e6).toFixed(1)} s | trackId: ${md.trackId || '—'}`);
        print(`  pode: play=${p.canPlay} pause=${p.canPause} seek=${p.canSeek} next=${p.canGoNext} prev=${p.canGoPrevious}`);
        if (!p.isActive) {
            print('  (inativo: a Wavebar Music ignora)\n');
            continue;
        }

        try {
            await wait(2000);
            const estimated = p.position;
            const real = await realPosition(p.busName);
            const drift = (estimated - real) / 1e6;
            print(`  posição: estimada ${(estimated / 1e6).toFixed(2)} s, real ${(real / 1e6).toFixed(2)} s → diferença ${drift.toFixed(2)} s ${Math.abs(drift) < 0.5 ? '✓' : '✗'}`);
        } catch (e) {
            print(`  posição: o player não informa Position (${e.message})`);
        }

        const cover = await covers.load(md.artUrl, null).catch(e => `erro: ${e.message}`);
        print(`  capa: ${md.artUrl ? md.artUrl.slice(0, 70) : '(sem artUrl)'} → ${cover ?? 'falhou'}`);

        const t0 = GLib.get_monotonic_time();
        const result = await lyrics.fetch(md, null).catch(e => ({kind: `erro (${e.message})`}));
        const ms = Math.round((GLib.get_monotonic_time() - t0) / 1000);
        const extra = result.kind === 'synced' ? ` (${result.lines.length} linhas)` : '';
        print(`  letra: ${result.kind}${extra} em ${ms} ms\n`);
    }
}

main().catch(e => logError(e)).finally(() => {
    try {
        manager.destroy();
        session.abort();
        GLib.spawn_command_line_sync(`rm -rf ${GLib.shell_quote(tmpCache)}`);
    } finally {
        loop.quit();
    }
});
loop.run();
System.exit(0);
