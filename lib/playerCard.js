// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Vinicius Bispo
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
import {findLineIndex, splitArtistTitle} from './lrc.js';
import {LyricsNetworkError} from './lyrics.js';
import {formatTime} from './util.js';
import {WaveformBar} from './waveform.js';

const TICK_MS = 250;        // atualização da onda/tempo com o card aberto
const RESYNC_EVERY = 12;    // a cada 12 ticks (~3 s) relê Position do player
const LYRICS_DELAY_MS = 300; // espera os metadados "assentarem" antes de buscar
const MAX_TITLE_CHARS = 70;
const LYRICS_LEAD_US = 150000; // destaca a linha um pouco antes (compensa o atraso visual)
const MANUAL_SCROLL_HOLD_US = 3000000; // rolou com o mouse? a rolagem automática volta em 3 s
const LYRICS_SCROLL_MS = 350;
const DEFAULT_COVER_RADIUS = 12;

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
        this._lyricsPlain = false;   // letra sem sincronia (rola proporcionalmente)
        this._manualScrollUntil = 0; // até quando respeitar a rolagem do usuário
        this._wasManual = false;
        this._snapLyrics = true;     // próxima rolagem sem animação (ao abrir/carregar)
        this._coverRadius = DEFAULT_COVER_RADIUS;
        this._coverPath = null;
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

        // Rolagem manual (roda, touchpad, arrastar): qualquer mudança no valor
        // que NÃO venha de uma animação nossa nem seja o alvo que definimos.
        // Observar o valor funciona seja qual for o jeito como o St trata o evento.
        this._scrollTarget = 0;
        this._lyricsView.vadjustment.connectObject('notify::value', adj => {
            if (adj.get_transition('value') || Math.abs(adj.value - this._scrollTarget) < 1)
                return;
            this._manualScrollUntil = GLib.get_monotonic_time() + MANUAL_SCROLL_HOLD_US;
        }, this);

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
            // Ao abrir, a letra já aparece na linha certa (sem animação).
            this._snapLyrics = true;
            this._manualScrollUntil = 0;
            this._activeLine = -2;
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
            // O último player fechou com o card aberto.
            this._player = null;
            this._updateTimer();
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
        {
            // Vídeos de navegador chegam como "Artista - Música (Official Video)"
            // com artista "ArtistaVEVO": mostramos a versão limpa.
            const shown = splitArtistTitle(md.title, md.artists.join(', '));
            // O Clutter não limita linhas: cortamos títulos enormes.
            const title = shown.title || md.title || 'Título desconhecido';
            this._title.text = title.length > MAX_TITLE_CHARS
                ? `${title.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…` : title;
            this._artist.text = [shown.artist, md.album]
                .filter(Boolean).join(' — ') || 'Artista desconhecido';
        }
        // Players mandam metadados em partes (álbum/capa depois): o texto é
        // refeito sempre, mas a letra só é buscada de novo se a faixa mudou.
        if (player.trackKey !== this._trackKey) {
            this._trackKey = player.trackKey;
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
        else if (this._lyricsPlain && length > 0)
            this._scrollPlainLyrics(position / length);
    }

    // ---------- rolagem automática ----------

    _manualScrollActive() {
        return GLib.get_monotonic_time() < this._manualScrollUntil;
    }

    // Leva a rolagem até `target` (px), com animação curta — ou na hora, se
    // acabou de abrir/carregar. `duration` maior deixa o movimento contínuo.
    _scrollLyricsTo(target, duration = LYRICS_SCROLL_MS, mode = Clutter.AnimationMode.EASE_OUT_QUAD) {
        const adj = this._lyricsView.vadjustment;
        target = Math.max(adj.lower, Math.min(target, adj.upper - adj.page_size));
        this._scrollTarget = target;
        if (this._snapLyrics) {
            this._snapLyrics = false;
            adj.remove_transition('value');
            adj.value = target;
        } else if (Math.abs(adj.value - target) >= 1) {
            adj.ease(target, {duration, mode});
        }
    }

    // Letra sem sincronia: rola na proporção do tempo tocado, com o trecho
    // "atual" um pouco acima do meio (é estimativa: não há tempos por linha).
    _scrollPlainLyrics(fraction) {
        if (this._manualScrollActive())
            return;
        const adj = this._lyricsView.vadjustment;
        const scrollable = adj.upper - adj.page_size;
        if (scrollable <= 0)
            return;
        // Movimento linear e da mesma duração do tick: parece rolagem contínua.
        this._scrollLyricsTo(fraction * scrollable, TICK_MS, Clutter.AnimationMode.LINEAR);
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
        this._lyricsPlain = false;
        this._activeLine = -1;
        this._lyricsView.vadjustment.remove_transition('value');
        this._scrollTarget = 0;
        this._lyricsView.vadjustment.value = 0;
        this._snapLyrics = true;
        this._manualScrollUntil = 0;

        const message = LYRICS_MESSAGES[result.kind];
        this._lyricsStatus.visible = !!message;
        this._lyricsStatus.text = message ?? '';
        this._lyricsView.visible = !message;

        if (result.kind === 'plain') {
            this._lyricsPlain = true;
            this._lyricsBox.add_child(this._makeLyricLabel(result.text, 'wavebar-lyric-plain'));
            this._scheduleLyricsSync();
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
            this._snapLyrics = true;
            this._updateProgress();
            return GLib.SOURCE_REMOVE;
        });
    }

    _setActiveLine(index) {
        const manual = this._manualScrollActive();
        // Terminou a pausa da rolagem manual: força recentralizar.
        if (!manual && this._wasManual)
            this._activeLine = -2;
        this._wasManual = manual;

        if (index === this._activeLine)
            return;
        this._lyricLabels[this._activeLine]?.remove_style_class_name('wavebar-active');
        this._activeLine = index;

        const label = this._lyricLabels[index];
        label?.add_style_class_name('wavebar-active');

        if (manual)
            return; // o usuário está lendo outro trecho; o destaque continua andando

        // Centraliza a linha atual (ou volta ao topo antes da primeira).
        let target = 0;
        if (label) {
            const box = label.get_allocation_box();
            target = (box.y1 + box.y2) / 2 - this._lyricsView.vadjustment.page_size / 2;
        }
        this._scrollLyricsTo(target);
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

    /**
     * Formato do contêiner (raio e padding do fundo do menu). Com cantos
     * concêntricos o card fica "certinho" — inclusive quando o Blur my Shell
     * troca o raio do menu.
     */
    setContainerShape(radius, padding) {
        const coverRadius = Math.round(Math.max(8, Math.min(24, radius - padding)));
        if (coverRadius === this._coverRadius)
            return;
        this._coverRadius = coverRadius;
        this._setCover(this._coverPath);
    }

    _setCover(path) {
        this._coverPath = path;
        let style = `border-radius: ${this._coverRadius}px;`;
        if (path) {
            // filename_to_uri escapa espaços e aspas: seguro dentro de url("…").
            const uri = GLib.filename_to_uri(path, null);
            style += ` background-image: url("${uri}");`;
            this._cover.remove_style_class_name('wavebar-no-cover');
            this._cover.child.visible = false;
        } else {
            this._cover.add_style_class_name('wavebar-no-cover');
            this._cover.child.visible = true;
        }
        this._cover.style = style;
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
        this._lyricsView.vadjustment.disconnectObject(this);
        this._manager.disconnectObject(this);
        this._manager = null;
        this._player = null;
    }
});
