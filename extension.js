// SPDX-License-Identifier: GPL-3.0-or-later
// Wavebar — controle de mídia universal (MPRIS) para o painel do GNOME Shell.
//
// Este arquivo só monta e desmonta as peças. Toda a lógica vive em lib/:
//   mpris.js          → descobre players no D-Bus e lê metadados
//   panelIndicator.js → botão do painel (pílula com barrinhas)
//   playerCard.js     → card vertical aberto pelo botão

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {MprisManager} from './lib/mpris.js';
import {WavebarIndicator} from './lib/panelIndicator.js';

export default class WavebarExtension extends Extension {
    enable() {
        // Nada é criado no construtor: as regras do extensions.gnome.org
        // exigem que tudo nasça no enable() e morra no disable().
        this._manager = new MprisManager();
        this._indicator = new WavebarIndicator(this._manager);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._manager.start();
    }

    disable() {
        // destroy() no indicador também destrói o menu e remove do painel.
        this._indicator?.destroy();
        this._indicator = null;

        // Depois do indicador: ele desconecta seus sinais do manager.
        this._manager?.destroy();
        this._manager = null;
    }
}
