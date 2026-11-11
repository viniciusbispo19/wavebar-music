// SPDX-License-Identifier: GPL-3.0-or-later
// Wavebar — controle de mídia universal (MPRIS) para o painel do GNOME Shell.
//
// Este arquivo só monta e desmonta as peças. Toda a lógica vive em lib/:
//   mpris.js          → descobre players no D-Bus e lê metadados
//   panelIndicator.js → botão do painel (pílula com barrinhas)
//   playerCard.js     → card vertical aberto pelo botão
//   coverArt.js       → capas (file://, data:, http) com cache em disco

import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {CoverArtLoader} from './lib/coverArt.js';
import {MprisManager} from './lib/mpris.js';
import {WavebarIndicator} from './lib/panelIndicator.js';

// User-Agent genérico: identifica o app sem expor dados do usuário.
const USER_AGENT = 'Wavebar/0.1 (GNOME Shell extension)';

export default class WavebarExtension extends Extension {
    enable() {
        // Nada é criado no construtor: as regras do extensions.gnome.org
        // exigem que tudo nasça no enable() e morra no disable().
        const cacheDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'wavebar']);

        // Uma única sessão HTTP para capas e letras (reaproveita conexões).
        this._session = new Soup.Session({user_agent: USER_AGENT, timeout: 15});
        this._services = {
            covers: new CoverArtLoader(this._session, cacheDir),
        };

        this._manager = new MprisManager();
        this._indicator = new WavebarIndicator(this._manager, this._services);
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
        this._services = null;

        // Corta qualquer requisição HTTP que ainda esteja no ar.
        this._session?.abort();
        this._session = null;
    }
}
