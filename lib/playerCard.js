// SPDX-License-Identifier: GPL-3.0-or-later
// Card vertical aberto pelo botão do painel:
//   capa → título/artista → player → letra → onda de progresso → controles

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {isCancelled} from './coverArt.js';
import {findLineIndex} from './lrc.js';
import {LyricsNetworkError} from './lyrics.js';
import {formatTime} from './util.js';
import {WaveformBar} from './waveform.js';

const TICK_MS = 250;        // atualização da onda/tempo com o card aberto
const RESYNC_EVERY = 12;    // a cada 12 ticks (~3 s) relê Position do player
const LYRICS_DELAY_MS = 300; // espera os metadados "assentarem" antes de buscar
const LYRICS_LEAD_US = 150000; // destaca a linha um pouco antes (compensa o atraso visual)

const LYRICS_MESSAGES = {
    'loading': 'Carregando letra…',
    'not-found': 'Letra não encontrada',
    'error': 'Não foi possível buscar a letra. Verifique sua conexão.',
    'instrumental': '♪  Instrumental  ♪',
};

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
        this._lyrics = services.lyrics;
        this._open = false;
        this._player = null;
        this._trackKey = null;
        this._artUrl = null;
        this._coverCancellable = null;
        this._tickId = 0;
        this._ticks = 0;
        this._lyricsCancellable = null;
        this._lyricsDelayId = 0;
        this._lyricsLaterId = 0;
        this._lyricLines = null; // [{time, text}] quando sincronizada
        this._lyricLabels = [];
        this._activeLine = -1;

        this._buildCover();
        this._buildInfo();
        this._buildPlayerRow();
        this._buildLyrics();
        this._buildProgress();
        this._buildControls();

        this._manager.connectObject(
            'changed', () => this._sync(),
            'seeked', () => this._updateProgress(), this);
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

    _buildLyrics() {
        this._lyricsStatus = new St.Label({
            style_class: 'wavebar-lyrics-status',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._lyricsStatus.clutter_text.line_wrap = true;
        this._lyricsStatus.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;

        this._lyricsBox = new St.BoxLayout({
            style_class: 'wavebar-lyrics-box',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this._lyricsView = new St.ScrollView({
            style_class: 'wavebar-lyrics',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.NEVER, // o fade já indica que rola
            overlay_scrollbars: true,
            child: this._lyricsBox,
        });

        this.add_child(this._lyricsStatus);
        this.add_child(this._lyricsView);
        this._showLyrics({kind: 'loading'});
    }

    _buildProgress() {
        const box = new St.BoxLayout({
            style_class: 'wavebar-progress',
            orientation: Clutter.Orientation.VERTICAL,
        });

        this._waveform = new WaveformBar();
        // Arrastando: só o rótulo de tempo acompanha. Soltou: seek de verdade.
        this._waveform.connect('scrub', (_w, fraction) => {
            this._elapsed.text = formatTime(fraction * (this._player?.metadata.length ?? 0));
        });
        this._waveform.connect('seek', (_w, fraction) => {
            const player = this._player;
            if (!player)
                return;
            player.setPosition(fraction * player.metadata.length);
            this._updateProgress();
        });

        const times = new St.BoxLayout({style_class: 'wavebar-times'});
        this._elapsed = new St.Label({style_class: 'wavebar-time', text: '0:00'});
        this._total = new St.Label({
            style_class: 'wavebar-time',
            text: '0:00',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
        });
        times.add_child(this._elapsed);
        times.add_child(this._total);

        box.add_child(this._waveform);
        box.add_child(times);
        this.add_child(box);
    }

    _buildControls() {
        const box = new St.BoxLayout({
            style_class: 'wavebar-controls',
            x_align: Clutter.ActorAlign.CENTER,
        });

        this._prevButton = iconButton('media-skip-backward-symbolic',
            'wavebar-control', 'Faixa anterior');
        this._prevButton.connect('clicked', () => this._player?.previous());

        this._playButton = iconButton('media-playback-start-symbolic',
            'wavebar-control wavebar-play', 'Tocar ou pausar');
        this._playButton.connect('clicked', () => this._player?.playPause());

        this._nextButton = iconButton('media-skip-forward-symbolic',
            'wavebar-control', 'Próxima faixa');
        this._nextButton.connect('clicked', () => this._player?.next());

        box.add_child(this._prevButton);
        box.add_child(this._playButton);
        box.add_child(this._nextButton);
        this.add_child(box);
    }

    // ---------- estado ----------

    /** Chamado pelo indicador quando o menu abre/fecha. */
    setOpen(open) {
        this._open = open;
        if (open) {
            this._sync();
            // Ao abrir, pergunta a posição real (pode ter mudado com o card fechado).
            this._player?.refreshPosition().then(() => this._updateProgress());
        } else {
            this._updateTimer();
        }
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
            this._loadLyrics();
        }

        if (md.artUrl !== this._artUrl) {
            this._artUrl = md.artUrl;
            this._loadCover(md.artUrl);
        }

        // Onda: estável por música (semente = título + artista).
        this._waveform.setSeed(`${md.title}|${md.artists.join(',')}`);
        this._waveform.setSeekable(player.canSeek && md.length > 0);

        // Controles
        const playing = player.status === 'Playing';
        this._playButton.child.icon_name = playing
            ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._playButton.reactive = playing ? player.canPause : player.canPlay;
        this._prevButton.reactive = player.canGoPrevious;
        this._nextButton.reactive = player.canGoNext;

        this._updateProgress();
        this._updateTimer();
    }

    _updateProgress() {
        const player = this._player;
        if (!this._open || !player)
            return;
        const length = player.metadata.length;
        const position = player.position;

        this._total.text = length > 0 ? formatTime(length) : '--:--';
        if (!this._waveform.isDragging) {
            this._elapsed.text = formatTime(position);
            this._waveform.setProgress(length > 0 ? position / length : 0);
        }

        if (this._lyricLines)
            this._setActiveLine(findLineIndex(this._lyricLines, position + LYRICS_LEAD_US));
    }

    // ---------- letras ----------

    _cancelLyrics() {
        this._lyricsCancellable?.cancel();
        this._lyricsCancellable = null;
        if (this._lyricsDelayId) {
            GLib.source_remove(this._lyricsDelayId);
            this._lyricsDelayId = 0;
        }
    }

    _loadLyrics() {
        this._cancelLyrics();
        this._showLyrics({kind: 'loading'});

        this._lyricsDelayId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LYRICS_DELAY_MS, () => {
            this._lyricsDelayId = 0;
            const md = this._player?.metadata;
            if (!md)
                return GLib.SOURCE_REMOVE;

            const cancellable = new Gio.Cancellable();
            this._lyricsCancellable = cancellable;
            this._lyrics.fetch(md, cancellable).then(result => {
                if (!cancellable.is_cancelled())
                    this._showLyrics(result);
            }).catch(e => {
                if (isCancelled(e) || cancellable.is_cancelled())
                    return;
                if (e instanceof LyricsNetworkError)
                    console.log(`[Wavebar] Letra: erro de rede (${e.message})`);
                else
                    console.error('[Wavebar] Erro ao buscar letra:', e);
                this._showLyrics({kind: 'error'});
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    _showLyrics(result) {
        this._lyricsBox.destroy_all_children();
        this._lyricLabels = [];
        this._lyricLines = null;
        this._activeLine = -1;
        this._lyricsView.vadjustment.value = 0;

        const message = LYRICS_MESSAGES[result.kind];
        this._lyricsStatus.visible = !!message;
        this._lyricsStatus.text = message ?? '';
        this._lyricsView.visible = !message;

        if (result.kind === 'plain') {
            this._lyricsBox.add_child(this._makeLyricLabel(result.text, 'wavebar-lyric-plain'));
        } else if (result.kind === 'synced') {
            this._lyricLines = result.lines;
            for (const line of result.lines) {
                const label = this._makeLyricLabel(line.text || '♪', 'wavebar-lyric-line');
                this._lyricsBox.add_child(label);
                this._lyricLabels.push(label);
            }
            // As linhas ainda não têm posição: destaca/rola depois do layout.
            this._scheduleLyricsSync();
        }
    }

    _makeLyricLabel(text, styleClass) {
        const label = new St.Label({style_class: styleClass, text});
        label.clutter_text.line_wrap = true;
        label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        return label;
    }

    _scheduleLyricsSync() {
        if (this._lyricsLaterId)
            return;
        const laters = global.compositor.get_laters();
        this._lyricsLaterId = laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._lyricsLaterId = 0;
            this._activeLine = -2; // força recalcular e rolar
            this._updateProgress();
            return GLib.SOURCE_REMOVE;
        });
    }

    _setActiveLine(index) {
        if (index === this._activeLine)
            return;
        this._lyricLabels[this._activeLine]?.remove_style_class_name('wavebar-active');
        this._activeLine = index;

        const label = this._lyricLabels[index];
        label?.add_style_class_name('wavebar-active');

        // Centraliza a linha atual (ou volta ao topo antes da primeira).
        const adj = this._lyricsView.vadjustment;
        let target = 0;
        if (label) {
            const box = label.get_allocation_box();
            target = (box.y1 + box.y2) / 2 - adj.page_size / 2;
        }
        target = Math.max(adj.lower, Math.min(target, adj.upper - adj.page_size));
        adj.ease(target, {duration: 350, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    // Timer leve: só existe com o card aberto E algo tocando.
    _updateTimer() {
        const needed = this._open && this._player?.status === 'Playing';
        if (needed && !this._tickId) {
            this._ticks = 0;
            this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_MS, () => {
                if (++this._ticks % RESYNC_EVERY === 0)
                    this._player?.refreshPosition();
                this._updateProgress();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!needed && this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
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
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
        this._coverCancellable?.cancel();
        this._coverCancellable = null;
        this._cancelLyrics();
        if (this._lyricsLaterId) {
            global.compositor.get_laters().remove(this._lyricsLaterId);
            this._lyricsLaterId = 0;
        }
        this._lyricsView.vadjustment.remove_transition('value');
        this._manager.disconnectObject(this);
        this._manager = null;
        this._player = null;
    }
});
