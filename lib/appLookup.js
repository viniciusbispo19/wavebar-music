// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Vinicius Bispo
//
// Descobre o app (.desktop) de um player MPRIS. É o único ponto da camada de
// players que depende do Shell — por isso fica separado de mpris.js.

import Shell from 'gi://Shell';

import {busBaseName} from './mpris.js';

const GENERIC_WORDS = new Set([
    'desktop', 'music', 'player', 'media', 'video', 'audio', 'browser', 'chromium',
    'instance', 'stable', 'beta', 'flatpak', 'mozilla', 'google', 'electron',
]);

/**
 * @param {object} info - {desktopEntry, busName, identity, pid}
 * @returns {Shell.App|null}
 */
export function lookupPlayerApp({desktopEntry, busName, identity, pid}) {
    const appSystem = Shell.AppSystem.get_default();

    // 1) Pelo processo: o app aberto cujas janelas pertencem ao mesmo PID que
    //    publicou o MPRIS. É o mais confiável (Brave não informa DesktopEntry,
    //    Flatpaks usam IDs diferentes do nome no barramento…).
    if (pid > 0) {
        const app = appSystem.get_running().find(a => a.get_pids().includes(pid));
        if (app)
            return app;
    }

    // 2) Pelos nomes, do mais confiável ao menos: DesktopEntry ("spotify"),
    //    Identity exata (apps Electron como o YouTube Music usam o nome como
    //    StartupWMClass), Identity simplificada ("Brave Origin" → brave-origin)
    //    e, por último, o barramento — que em apps Electron é sempre
    //    "chromium.instanceN" e apontaria para o app errado se viesse antes.
    const rawId = (identity ?? '').trim();
    const id = rawId.toLowerCase();
    const guesses = [...new Set([
        (desktopEntry ?? '').replace(/\.desktop$/, ''),
        rawId,
        id.replace(/\s+/g, '-'),
        id.split(/\s+/)[0],
        busBaseName(busName),
    ].filter(Boolean))];

    for (const name of guesses) {
        const app = appSystem.lookup_app(`${name}.desktop`) ??
            appSystem.lookup_desktop_wmclass(name) ??
            appSystem.lookup_startup_wmclass(name) ??
            appSystem.lookup_heuristic_basename(name);
        if (app)
            return app;
    }

    // 3) Último recurso: app instalado cujo ID termine no nome do DesktopEntry
    //    ou do barramento. Ex.: o Deezer em Flatpak informa "deezer-desktop",
    //    mas o app é dev.aunetx.deezer.desktop. Palavras genéricas ficam de fora
    //    para não casar "music" com o GNOME Música, por exemplo.
    const tokens = [desktopEntry ?? '', busBaseName(busName)]
        .flatMap(g => g.toLowerCase().split(/[-_.\s]+/))
        .filter(t => t.length >= 4 && !GENERIC_WORDS.has(t));
    if (tokens.length > 0) {
        for (const info of appSystem.get_installed()) {
            const appId = info.get_id()?.toLowerCase() ?? '';
            const base = appId.replace(/\.desktop$/, '').split('.').pop();
            if (tokens.includes(base))
                return appSystem.lookup_app(info.get_id());
        }
    }
    return null;
}
