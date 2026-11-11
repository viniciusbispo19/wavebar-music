// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Vinicius Bispo
//
// Janela de preferências da Wavebar Music (GTK 4 + libadwaita).
//
// Este arquivo NÃO roda dentro do GNOME Shell: roda num processo separado
// (o app "Extensões"). Por isso usa Gtk/Adw, e não St/Clutter. As opções vão
// para o GSettings; a extensão escuta "changed" e aplica na hora.
//
// Páginas: "Geral" (aparência, Blur my Shell, cache) e "Sobre mim".

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// ---------- Sobre mim (edite à vontade) ----------
const AUTHOR = {
    name: 'Vinicius Bispo',
    bio: 'Estudante de desenvolvimento web e criador de extensões para o GNOME. ' +
        'Gosto de deixar o desktop Linux bonito, rápido e em português.',
    github: 'https://github.com/viniciusbispo19',
};

const PROJECTS = [
    ['Luma Dock', 'Dock leve e bonita para o GNOME, com prévias de janela e Music Pill',
        'https://github.com/viniciusbispo19/luma-dock'],
    ['Luma Menu', 'Barra de menus global no estilo do macOS para o GNOME Shell',
        'https://github.com/viniciusbispo19/luma-menu'],
    ['Hiragana Clock', 'Widget de área de trabalho com o dia da semana em hiragana',
        'https://github.com/viniciusbispo19/hiragana-clock'],
    ['Nautilus Vitrine', 'Modo Colunas e painel de pré-visualização para o Arquivos (Nautilus)',
        'https://github.com/viniciusbispo19/nautilus-vitrine'],
];

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

// Abre um link no navegador padrão (Gtk.UriLauncher é a API atual do GTK 4).
function openUri(widget, uri) {
    new Gtk.UriLauncher({uri}).launch(widget.get_root(), null, null);
}

// Linha clicável com ícone de "link externo".
function linkRow(title, subtitle, uri) {
    const row = new Adw.ActionRow({title, subtitle, activatable: true});
    row.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
    row.connect('activated', () => openUri(row, uri));
    return row;
}

export default class WavebarMusicPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(580, 700);

        const general = new Adw.PreferencesPage({
            title: 'Geral',
            icon_name: 'preferences-system-symbolic',
        });
        general.add(this._appearanceGroup(settings));
        general.add(this._blurGroup(settings));
        general.add(this._cacheGroup());
        window.add(general);

        window.add(this._aboutMePage());
    }

    // ---------- Geral ----------

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
            description: 'Capas e letras ficam salvas em ~/.cache/wavebar-music para abrir mais rápido.',
        });
        const row = new Adw.ActionRow({title: 'Limpar capas e letras salvas'});
        const button = new Gtk.Button({
            label: 'Limpar',
            valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
        });
        button.connect('clicked', () => {
            const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'wavebar-music']);
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

    // ---------- Sobre mim ----------

    _aboutMePage() {
        const page = new Adw.PreferencesPage({
            title: 'Sobre mim',
            icon_name: 'avatar-default-symbolic',
        });

        // Cabeçalho: avatar com iniciais (sem baixar foto nenhuma da internet),
        // nome, bio e botão para o GitHub.
        const header = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 10,
            halign: Gtk.Align.CENTER,
            margin_top: 12,
            margin_bottom: 6,
        });
        header.append(new Adw.Avatar({size: 96, text: AUTHOR.name, show_initials: true}));
        header.append(new Gtk.Label({label: AUTHOR.name, css_classes: ['title-1']}));
        header.append(new Gtk.Label({
            label: AUTHOR.bio,
            wrap: true,
            justify: Gtk.Justification.CENTER,
            max_width_chars: 48,
            css_classes: ['dim-label'],
        }));
        const github = new Gtk.Button({
            label: 'Meu GitHub',
            halign: Gtk.Align.CENTER,
            margin_top: 4,
            css_classes: ['pill', 'suggested-action'],
        });
        github.connect('clicked', () => openUri(github, AUTHOR.github));
        header.append(github);

        const headerGroup = new Adw.PreferencesGroup();
        headerGroup.add(header);
        page.add(headerGroup);

        const projects = new Adw.PreferencesGroup({
            title: 'Meus outros projetos para o GNOME',
        });
        for (const [title, subtitle, uri] of PROJECTS)
            projects.add(linkRow(title, subtitle, uri));
        page.add(projects);

        const version = this.metadata['version-name'] ?? String(this.metadata.version ?? '');
        const about = new Adw.PreferencesGroup({title: 'Sobre a Wavebar Music'});
        about.add(new Adw.ActionRow({
            title: 'Versão',
            subtitle: version,
        }));
        about.add(linkRow('Código-fonte', this.metadata.url, this.metadata.url));
        about.add(linkRow('Relatar um problema ou sugerir algo',
            'Abra uma issue no GitHub', `${this.metadata.url}/issues`));
        about.add(linkRow('Licença', 'GNU GPL 3.0 ou posterior — software livre',
            `${this.metadata.url}/blob/main/LICENSE`));
        about.add(linkRow('Letras', 'Fornecidas pelo LRCLIB (lrclib.net)', 'https://lrclib.net'));
        page.add(about);

        return page;
    }
}
