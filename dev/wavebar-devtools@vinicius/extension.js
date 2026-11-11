// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Vinicius Bispo
// Extensão auxiliar, SÓ para desenvolvimento (não é publicada).
//
// O "modo inseguro" (unsafe mode) libera por D-Bus:
//   - org.gnome.Shell.Eval: executar JavaScript dentro do Shell;
//   - org.gnome.Shell.Screenshot: tirar print sem ser um app autorizado.
// Assim dá para inspecionar a sessão aninhada pelo terminal
// (scripts/nested-eval.sh e scripts/nested-screenshot.sh).
//
// Segurança: só liga se WAVEBAR_DEV=1, que apenas o scripts/dev-nested.sh
// define. O dconf da sessão aninhada é uma cópia, então esta extensão nem
// fica ativada na sessão normal.

import GLib from 'gi://GLib';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class WavebarDevTools extends Extension {
    enable() {
        if (GLib.getenv('WAVEBAR_DEV') !== '1')
            return;

        this._previousUnsafeMode = global.context.unsafe_mode;
        global.context.unsafe_mode = true;
    }

    disable() {
        if (this._previousUnsafeMode === undefined)
            return;

        global.context.unsafe_mode = this._previousUnsafeMode;
        this._previousUnsafeMode = undefined;
    }
}
