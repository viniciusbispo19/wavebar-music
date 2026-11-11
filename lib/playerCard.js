// SPDX-License-Identifier: GPL-3.0-or-later
// Card vertical aberto pelo botão do painel:
//   capa → título/artista → player → letra → onda de progresso → controles

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {isCancelled} from './coverArt.js';

function makeLabel(styleClass, lines = 1) {
    const label = new St.Label({style_class: styleClass, x_expand: true});
    label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    if (lines > 1) {
        label.clutter_text.line_wrap = true;
        label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    }
    return label;
}

function iconButton(iconName, styleClass, accessibleName) {
    return new St.Button({
        style_class: `wavebar-icon-button ${styleClass}`,
        can_focus: true,
        accessible_name: accessibleName,
        child: new St.Icon({icon_name: iconName}),
    });
}

export const PlayerCard = GObject.registerClass({
    GTypeName: 'WavebarPlayerCard',
    Signals: {'close-request': {}},
}, class PlayerCard extends St.BoxLayout {
    _init(manager, services) {
        super._init({
            style_class: 'wavebar-card',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });

        this._manager = manager;
        this._covers = services.covers;
        this._open = false;
        this._player = null;
        this._trackKey = null;
        this._artUrl = null;
        this._coverCancellable = null;

        this._buildCover();
        this._buildInfo();
        this._buildPlayerRow();

        this._manager.connectObject('changed', () => this._sync(), this);
        this.connect('destroy', () => this._onDestroy());
    }

    // ---------- construção ----------

    _buildCover() {
        this._cover = new St.Bin({
            style_class: 'wavebar-cover wavebar-no-cover',
            x_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({
                style_class: 'wavebar-cover-placeholder',
                icon_name: 'audio-x-generic-symbolic',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            }),
        });
        this.add_child(this._cover);
    }

    _buildInfo() {
        const box = new St.BoxLayout({
            style_class: 'wavebar-info',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this._title = makeLabel('wavebar-title', 2);
        this._artist = makeLabel('wavebar-artist');
        box.add_child(this._title);
        box.add_child(this._artist);
        this.add_child(box);
    }

    _buildPlayerRow() {
        const row = new St.BoxLayout({style_class: 'wavebar-player-row'});

        this._prevPlayer = iconButton('go-previous-symbolic', 'wavebar-switch',
            'Player anterior');
        this._prevPlayer.connect('clicked', () => this._manager.cyclePlayer(-1));

        this._nextPlayer = iconButton('go-next-symbolic', 'wavebar-switch',
            'Próximo player');
        this._nextPlayer.connect('clicked', () => this._manager.cyclePlayer(1));

        // Clicar no nome do player traz a janela dele para frente.
        this._appIcon = new St.Icon({
            style_class: 'wavebar-app-icon',
            fallback_icon_name: 'multimedia-player-symbolic',
        });
        this._appName = makeLabel('wavebar-app-name');
        const appBox = new St.BoxLayout({x_align: Clutter.ActorAlign.CENTER});
        appBox.add_child(this._appIcon);
        appBox.add_child(this._appName);
        this._appButton = new St.Button({
            style_class: 'wavebar-app-button',
            x_expand: true,
            can_focus: true,
            child: appBox,
        });
        this._appButton.connect('clicked', () => {
            this._player?.raise();
            this.emit('close-request');
        });

        this._playerCount = new St.Label({
            style_class: 'wavebar-player-count',
            y_align: Clutter.ActorAlign.CENTER,
        });

        row.add_child(this._prevPlayer);
        row.add_child(this._appButton);
        row.add_child(this._playerCount);
        row.add_child(this._nextPlayer);
        this.add_child(row);
    }

    // ---------- estado ----------

    /** Chamado pelo indicador quando o menu abre/fecha. */
    setOpen(open) {
        this._open = open;
        if (open)
            this._sync();
    }

    // Só atualiza o conteúdo com o card aberto: fechado, nada de baixar capas.
    _sync() {
        if (!this._open)
            return;

        const player = this._manager.current;
        if (!player) {
            this.emit('close-request');
            return;
        }
        this._player = player;

        // Seletor de players: setas só aparecem com mais de um.
        const players = this._manager.players;
        const multiple = players.length > 1;
        this._prevPlayer.visible = this._nextPlayer.visible = multiple;
        this._playerCount.visible = multiple;
        this._playerCount.text = `${players.indexOf(player) + 1}/${players.length}`;

        this._appIcon.gicon = player.app?.get_icon() ?? null;
        this._appName.text = player.displayName;

        const md = player.metadata;
        if (player.trackKey !== this._trackKey) {
            this._trackKey = player.trackKey;
            this._title.text = md.title || 'Título desconhecido';
            this._artist.text = [md.artists.join(', '), md.album]
                .filter(Boolean).join(' — ') || 'Artista desconhecido';
        }

        if (md.artUrl !== this._artUrl) {
            this._artUrl = md.artUrl;
            this._loadCover(md.artUrl);
        }
    }

    async _loadCover(url) {
        this._coverCancellable?.cancel();
        const cancellable = new Gio.Cancellable();
        this._coverCancellable = cancellable;

        let path = null;
        try {
            path = await this._covers.load(url, cancellable);
        } catch (e) {
            if (isCancelled(e))
                return;
        }
        if (cancellable.is_cancelled())
            return;
        this._setCover(path);
    }

    _setCover(path) {
        if (path) {
            // filename_to_uri escapa espaços e aspas: seguro dentro de url("…").
            const uri = GLib.filename_to_uri(path, null);
            this._cover.style = `background-image: url("${uri}");`;
            this._cover.remove_style_class_name('wavebar-no-cover');
            this._cover.child.visible = false;
        } else {
            this._cover.style = null;
            this._cover.add_style_class_name('wavebar-no-cover');
            this._cover.child.visible = true;
        }
    }

    _onDestroy() {
        this._coverCancellable?.cancel();
        this._coverCancellable = null;
        this._manager.disconnectObject(this);
        this._manager = null;
        this._player = null;
    }
});
