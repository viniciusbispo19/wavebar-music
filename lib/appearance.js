// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Vinicius Bispo
//
// Decide a aparência do card: tema claro/escuro e integração com o
// Blur my Shell (BMS).
//
// Como o BMS funciona (versão 77): ele desfoca o fundo de todo ator com a
// classe "popup-menu-content" — o nosso card tem — e aplica nele o raio de
// "menu-corner-radius" (como estilo inline) e um fundo translúcido pelo
// estilo "style-popup" (0 transparente, 1 claro, 2 escuro, 3 automático).
// Aqui só LEMOS as configurações dele (pelo schema na pasta da extensão) para
// escolher cores de texto que combinem; nada no BMS é alterado.

import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const BMS_UUID = 'blur-my-shell@aunetx';
const BMS_POPUP_SCHEMA = 'org.gnome.shell.extensions.blur-my-shell.popup';
const EXTENSION_ACTIVE = 1; // ExtensionState.ACTIVE

export const Appearance = GObject.registerClass({
    GTypeName: 'WavebarMusicAppearance',
    Signals: {'changed': {}},
}, class Appearance extends GObject.Object {
    constructor(settings) {
        super();
        this._settings = settings;
        this._bmsSettings = null;
        this._bmsSchemaDir = null;

        this._settings.connectObject('changed', () => this._refresh(), this);
        St.Settings.get().connectObject('notify::color-scheme', () => this._refresh(), this);
        Main.extensionManager.connectObject('extension-state-changed', (_m, ext) => {
            if (ext.uuid === BMS_UUID)
                this._refresh();
        }, this);

        this._refresh();
    }

    /** 'dark' ou 'light': cor do texto/fundo do card. */
    get variant() {
        return this._variant;
    }

    /** true quando o BMS está desfocando o fundo do card (e devemos deixar o fundo dele). */
    get blurActive() {
        return this._blurActive;
    }

    /** true quando o BMS desfoca menus (mesmo com tema forçado o desfoque fica por trás). */
    get bmsActive() {
        return this._bmsActive;
    }

    _systemVariant() {
        // Main.getStyleVariant() considera o modo da sessão e o esquema do sistema.
        return Main.getStyleVariant() === 'light' ? 'light' : 'dark';
    }

    // Abre (uma vez) as configurações de popup do BMS, se ele estiver ativo.
    _ensureBmsSettings() {
        const ext = Main.extensionManager.lookup(BMS_UUID);
        if (!ext || ext.state !== EXTENSION_ACTIVE) {
            this._dropBmsSettings();
            return null;
        }

        const dir = ext.dir.get_child('schemas').get_path();
        if (this._bmsSettings && this._bmsSchemaDir === dir)
            return this._bmsSettings;

        this._dropBmsSettings();
        try {
            const source = Gio.SettingsSchemaSource.new_from_directory(
                dir, Gio.SettingsSchemaSource.get_default(), false);
            const schema = source.lookup(BMS_POPUP_SCHEMA, false);
            // Versões antigas do BMS não têm o componente de popups.
            if (!schema?.has_key('blur') || !schema.has_key('style-popup'))
                return null;
            this._bmsSettings = new Gio.Settings({settings_schema: schema});
            this._bmsSchemaDir = dir;
            this._bmsSettings.connectObject('changed', () => this._refresh(), this);
        } catch (e) {
            console.log(`[Wavebar Music] Não consegui ler as configurações do Blur my Shell: ${e.message}`);
        }
        return this._bmsSettings;
    }

    _dropBmsSettings() {
        this._bmsSettings?.disconnectObject(this);
        this._bmsSettings = null;
        this._bmsSchemaDir = null;
    }

    _refresh() {
        const theme = this._settings.get_string('theme');
        const bms = this._settings.get_boolean('follow-blur-my-shell')
            ? this._ensureBmsSettings() : null;

        // O BMS só mexe no fundo se "blur" e "override-background" estiverem ligados.
        const bmsActive = !!bms && bms.get_boolean('blur');
        const bmsBackground = bmsActive && (!bms.settings_schema.has_key('override-background') ||
            bms.get_boolean('override-background'));

        let variant;
        if (theme === 'dark' || theme === 'light') {
            variant = theme;
        } else if (bmsBackground) {
            // 1 = claro, 2 = escuro; 0 (transparente) e 3 (auto) seguem o sistema.
            const style = bms.get_int('style-popup');
            variant = style === 1 ? 'light' : style === 2 ? 'dark' : this._systemVariant();
        } else {
            variant = this._systemVariant();
        }

        // Com tema forçado, pintamos o nosso fundo por cima do do BMS (o
        // desfoque continua por trás); no automático, o fundo é o do BMS.
        const blurActive = bmsActive && theme === 'auto' && bmsBackground;

        if (variant !== this._variant || blurActive !== this._blurActive ||
            bmsActive !== this._bmsActive) {
            this._variant = variant;
            this._blurActive = blurActive;
            this._bmsActive = bmsActive;
            this.emit('changed');
        }
    }

    destroy() {
        this._settings.disconnectObject(this);
        St.Settings.get().disconnectObject(this);
        Main.extensionManager.disconnectObject(this);
        this._dropBmsSettings();
        this._settings = null;
    }
});
