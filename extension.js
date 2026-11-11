// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Vinicius Bispo
// Wavebar Music — controle de mídia universal (MPRIS) para o painel do GNOME Shell.
//
// Este arquivo só monta e desmonta as peças. Toda a lógica vive em lib/:
//   mpris.js          → descobre players no D-Bus e lê metadados
//   panelIndicator.js → botão do painel (pílula com barrinhas)
//   playerCard.js     → card vertical aberto pelo botão
//   coverArt.js       → capas (file://, data:, http) com cache em disco
//   lyrics.js / lrc.js → letras do LRCLIB (sincronizadas ou não)
//   appearance.js     → tema claro/escuro e integração com o Blur my Shell

import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Appearance} from './lib/appearance.js';
import {lookupPlayerApp} from './lib/appLookup.js';
import {CoverArtLoader} from './lib/coverArt.js';
import {LyricsClient} from './lib/lyrics.js';
import {MprisManager} from './lib/mpris.js';
import {WavebarMusicIndicator} from './lib/panelIndicator.js';

// User-Agent genérico: identifica o app sem expor dados do usuário.
const USER_AGENT = 'WavebarMusic/0.4 (GNOME Shell extension)';

export default class WavebarMusicExtension extends Extension {
    enable() {
        // Nada é criado no construtor: as regras do extensions.gnome.org
        // exigem que tudo nasça no enable() e morra no disable().
        const cacheDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'wavebar-music']);

        // Uma única sessão HTTP para capas e letras (reaproveita conexões).
        this._session = new Soup.Session({user_agent: USER_AGENT, timeout: 15});
        this._settings = this.getSettings();
        this._services = {
            covers: new CoverArtLoader(this._session, cacheDir),
            lyrics: new LyricsClient(this._session, cacheDir),
            appearance: new Appearance(this._settings),
        };

        this._manager = new MprisManager(lookupPlayerApp);
        this._indicator = new WavebarMusicIndicator(this._manager, this._services);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._manager.start();
    }

    disable() {
        // destroy() no indicador também destrói o menu, o card e cancela
        // as requisições que o card tiver em andamento.
        this._indicator?.destroy();
        this._indicator = null;

        // Depois do indicador: ele desconecta seus sinais do manager.
        this._manager?.destroy();
        this._manager = null;

        this._services?.covers.destroy();
        this._services?.lyrics.destroy();
        this._services?.appearance.destroy();
        this._services = null;
        this._settings = null;

        // Corta qualquer requisição HTTP que ainda esteja no ar.
        this._session?.abort();
        this._session = null;
    }
}
