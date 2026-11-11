// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Vinicius Bispo
//
// Janela de preferências da Wavebar (GTK 4 + libadwaita).
//
// Este arquivo NÃO roda dentro do GNOME Shell: roda num processo separado
// (o app "Extensões"). Por isso usa Gtk/Adw, e não St/Clutter. As opções vão
// para o GSettings; a extensão escuta "changed" e aplica na hora.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const BMS_UUID = 'blur-my-shell@aunetx';
const THEMES = [
    ['auto', 'Automático'],
    ['dark', 'Escuro'],
    ['light', 'Claro'],
];

// Lê (sem alterar) as configurações de popup do Blur my Shell, se instalado.
function readBlurMyShell() {
    const dirs = [
        GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-shell', 'extensions', BMS_UUID]),
        ...GLib.get_system_data_dirs().map(d =>
            GLib.build_filenamev([d, 'gnome-shell', 'extensions', BMS_UUID])),
    ];
    for (const dir of dirs) {
        const schemas = GLib.build_filenamev([dir, 'schemas']);
        if (!GLib.file_test(schemas, GLib.FileTest.IS_DIR))
            continue;
        try {
            const source = Gio.SettingsSchemaSource.new_from_directory(
                schemas, Gio.SettingsSchemaSource.get_default(), false);
            const schema = source.lookup('org.gnome.shell.extensions.blur-my-shell.popup', false);
            if (!schema?.has_key('blur'))
                return {installed: true, popups: false};
            const settings = new Gio.Settings({settings_schema: schema});
            return {installed: true, popups: true, settings};
        } catch {
            return {installed: true, popups: false};
        }
    }
    return {installed: false};
}

export default class WavebarPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(560, 640);

        const page = new Adw.PreferencesPage({
            title: 'Wavebar',
            icon_name: 'audio-x-generic-symbolic',
        });
        page.add(this._appearanceGroup(settings));
        page.add(this._blurGroup(settings));
        page.add(this._cacheGroup());
        page.add(this._aboutGroup());
        window.add(page);
    }

    _appearanceGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Aparência',
            description: 'Automático segue o Blur my Shell (se ativo) ou o tema claro/escuro ' +
                'do GNOME. O ícone do painel sempre acompanha o painel.',
        });

        const row = new Adw.ComboRow({
            title: 'Tema do card',
            model: Gtk.StringList.new(THEMES.map(([, label]) => label)),
        });
        const sync = () => {
            const index = THEMES.findIndex(([id]) => id === settings.get_string('theme'));
            row.selected = Math.max(0, index);
        };
        sync();
        settings.connect('changed::theme', sync);
        row.connect('notify::selected', () => {
            const id = THEMES[row.selected]?.[0] ?? 'auto';
            if (settings.get_string('theme') !== id)
                settings.set_string('theme', id);
        });
        group.add(row);
        return group;
    }

    _blurGroup(settings) {
        const bms = readBlurMyShell();
        let status;
        if (!bms.installed)
            status = 'Blur my Shell não está instalado.';
        else if (!bms.popups)
            status = 'Esta versão do Blur my Shell não desfoca menus.';
        else if (bms.settings.get_boolean('blur'))
            status = 'Detectado: o desfoque de menus está ligado.';
        else
            status = 'Detectado, mas o desfoque de menus está desligado nele.';

        const group = new Adw.PreferencesGroup({
            title: 'Blur my Shell',
            description: status,
        });

        const row = new Adw.SwitchRow({
            title: 'Integrar com o Blur my Shell',
            subtitle: 'Usa o fundo desfocado, o estilo claro/escuro e o raio dos cantos ' +
                'configurados nele para menus',
        });
        settings.bind('follow-blur-my-shell', row, 'active', Gio.SettingsBindFlags.DEFAULT);
        row.sensitive = !!bms.popups;
        group.add(row);
        return group;
    }

    _cacheGroup() {
        const group = new Adw.PreferencesGroup({
            title: 'Cache',
            description: 'Capas e letras ficam salvas em ~/.cache/wavebar para abrir mais rápido.',
        });
        const row = new Adw.ActionRow({title: 'Limpar capas e letras salvas'});
        const button = new Gtk.Button({
            label: 'Limpar',
            valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
        });
        button.connect('clicked', () => {
            const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'wavebar']);
            for (const sub of ['covers', 'lyrics']) {
                const folder = Gio.File.new_for_path(GLib.build_filenamev([dir, sub]));
                try {
                    const en = folder.enumerate_children('standard::name',
                        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
                    let info;
                    while ((info = en.next_file(null)))
                        folder.get_child(info.get_name()).delete(null);
                } catch {
                    // pasta ainda não existe
                }
            }
            button.label = 'Limpo';
            button.sensitive = false;
        });
        row.add_suffix(button);
        group.add(row);
        return group;
    }

    _aboutGroup() {
        const group = new Adw.PreferencesGroup({title: 'Sobre'});
        const version = this.metadata['version-name'] ?? String(this.metadata.version ?? '');

        group.add(new Adw.ActionRow({
            title: 'Wavebar',
            subtitle: `Versão ${version} — por Vinicius Bispo`,
        }));

        const repo = new Adw.ActionRow({
            title: 'Código-fonte e problemas',
            subtitle: this.metadata.url,
            activatable: true,
        });
        repo.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
        repo.connect('activated', () =>
            Gtk.show_uri(repo.get_root(), this.metadata.url, 0));
        group.add(repo);

        group.add(new Adw.ActionRow({
            title: 'Letras',
            subtitle: 'Fornecidas pelo LRCLIB (lrclib.net)',
        }));
        return group;
    }
}
