// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Vinicius Bispo
// Botão do painel: uma "pílula" com 3 barrinhas de equalizador desenhadas em Cairo.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {PlayerCard} from './playerCard.js';

const BAR_COUNT = 3;
// Alturas (0–1) das barrinhas quando pausado.
const STATIC_LEVELS = [0.45, 0.85, 0.6];
// Limita a ~30 quadros/s: o painel não precisa de 144 Hz para 3 barrinhas.
const MIN_REPAINT_INTERVAL_US = 33000;
// Tempo para as barrinhas "acordarem"/"adormecerem" ao dar play/pause.
const RAMP_MS = 300;

/**
 * Ícone de equalizador. A animação usa uma Clutter.Timeline presa ao próprio
 * ator: ela anda no ritmo do relógio de quadros do compositor e para sozinha
 * quando o ator não está visível — mais barato que um GLib.timeout.
 */
export const EqualizerIcon = GObject.registerClass({
    GTypeName: 'WavebarMusicEqualizerIcon',
}, class EqualizerIcon extends St.DrawingArea {
    _init() {
        super._init({
            style_class: 'wavebar-music-equalizer',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._playing = false;
        this._amplitude = 0; // 0 = barras estáticas, 1 = animação plena
        this._lastFrameUs = 0;
        this._lastRepaintUs = 0;

        this._timeline = new Clutter.Timeline({
            actor: this,
            duration: 1000,
            repeat_count: -1,
        });
        this._timeline.connectObject('new-frame', () => this._onNewFrame(), this);

        // Respeita "Animações" desligadas nas configurações de acessibilidade.
        this._stSettings = St.Settings.get();
        this._stSettings.connectObject('notify::enable-animations',
            () => this._sync(), this);

        this.connect('destroy', () => this._onDestroy());
    }

    get playing() {
        return this._playing;
    }

    set playing(playing) {
        if (this._playing === playing)
            return;
        this._playing = playing;
        this._sync();
    }

    _sync() {
        if (!this._stSettings.enable_animations) {
            this._timeline.stop();
            this._amplitude = 0;
            this.queue_repaint();
            return;
        }

        // Ao pausar, a timeline continua rodando até a amplitude chegar a 0
        // (transição suave); quem para é o _onNewFrame().
        if (this._playing && !this._timeline.is_playing()) {
            this._lastFrameUs = GLib.get_monotonic_time();
            this._timeline.start();
        }
    }

    _onNewFrame() {
        const now = GLib.get_monotonic_time();
        const step = (now - this._lastFrameUs) / 1000 / RAMP_MS;
        this._lastFrameUs = now;

        this._amplitude = this._playing
            ? Math.min(1, this._amplitude + step)
            : Math.max(0, this._amplitude - step);

        if (!this._playing && this._amplitude === 0) {
            this._timeline.stop();
            this.queue_repaint();
            return;
        }

        if (now - this._lastRepaintUs < MIN_REPAINT_INTERVAL_US)
            return;
        this._lastRepaintUs = now;
        this.queue_repaint();
    }

    // Duas senoides de frequências diferentes por barra: movimento "orgânico"
    // sem precisar de números aleatórios.
    _animatedLevel(index, seconds) {
        const a = Math.sin(seconds * (5.3 + index * 1.7) + index * 1.3);
        const b = Math.sin(seconds * (2.9 + index * 0.8) + index * 2.1);
        return 0.25 + 0.75 * Math.abs(a * 0.6 + b * 0.4);
    }

    vfunc_repaint() {
        const cr = this.get_context();
        try {
            const [width, height] = this.get_surface_size();
            const color = this.get_theme_node().get_foreground_color();
            const seconds = GLib.get_monotonic_time() / 1e6;

            // Barras e espaços com a mesma largura: 3 barras + 2 espaços.
            const barWidth = width / (BAR_COUNT * 2 - 1);
            const radius = barWidth / 2;

            cr.setSourceColor(color);
            cr.setLineCap(Cairo.LineCap.ROUND);
            cr.setLineWidth(barWidth);

            for (let i = 0; i < BAR_COUNT; i++) {
                const level = STATIC_LEVELS[i] * (1 - this._amplitude) +
                    this._animatedLevel(i, seconds) * this._amplitude;
                const barHeight = Math.max(barWidth, level * height);
                const x = radius + i * barWidth * 2;

                // Com a ponta arredondada, a linha "cresce" radius em cada lado.
                cr.moveTo(x, (height - barHeight) / 2 + radius);
                cr.lineTo(x, (height + barHeight) / 2 - radius);
                cr.stroke();
            }
        } catch (e) {
            console.error('[Wavebar Music] Erro ao desenhar o equalizador:', e);
        } finally {
            cr.$dispose();
        }
    }

    _onDestroy() {
        this._timeline.stop();
        this._timeline.disconnectObject(this);
        this._stSettings.disconnectObject(this);
        this._timeline = null;
        this._stSettings = null;
    }
});

/**
 * Botão do painel. Herda de PanelMenu.Button, que já cria o menu (popup)
 * ancorado e trata clique/teclado com Clutter.ClickGesture (GNOME 51).
 */
export const WavebarMusicIndicator = GObject.registerClass({
    GTypeName: 'WavebarMusicIndicator',
}, class WavebarMusicIndicator extends PanelMenu.Button {
    _init(manager, services) {
        super._init(0.5, 'Wavebar Music', false);
        this.add_style_class_name('wavebar-music-button');
        this._manager = manager;

        // Cliques (GNOME 51 usa gestos do Clutter, não mais eventos):
        //  - DIREITO: abre o card. O PanelMenu.Button cria um ClickGesture que
        //    abre o menu com qualquer botão; restringimos ao botão direito.
        //  - ESQUERDO: pausa o que estiver tocando (qualquer player) ou retoma.
        // Enter/Espaço no ícone focado continuam abrindo o card (teclado).
        this._clickGesture?.set_required_button(Clutter.BUTTON_SECONDARY);
        this._playbackGesture = new Clutter.ClickGesture({
            required_button: Clutter.BUTTON_PRIMARY,
        });
        this._playbackGesture.connect('recognize', () => this._manager?.togglePlayback());
        this.add_action(this._playbackGesture);

        this._pill = new St.Bin({
            style_class: 'wavebar-music-pill',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._equalizer = new EqualizerIcon();
        this._pill.set_child(this._equalizer);
        this.add_child(this._pill);

        // O card mora dentro do menu (popup) que o PanelMenu.Button já criou.
        this.menu.actor.add_style_class_name('wavebar-music-menu');
        this.menu.box.add_style_class_name('wavebar-music-menu-content');
        this._card = new PlayerCard(manager, services);
        this.menu.box.add_child(this._card);
        this._card.connect('close-request', () => this.menu.close());
        this.menu.connectObject('open-state-changed',
            (_menu, open) => this._card.setOpen(open), this);

        // Aparência: tema e integração com o Blur my Shell.
        this._appearance = services.appearance;
        this._appearance.connectObject('changed', () => this._applyAppearance(), this);
        this._applyAppearance();

        // O BMS troca o raio dos cantos do contêiner (estilo inline); a capa
        // acompanha para os cantos ficarem concêntricos.
        this.menu.box.connectObject('style-changed', () => {
            const node = this.menu.box.get_theme_node();
            this._card.setContainerShape(
                node.get_border_radius(St.Corner.TOPLEFT),
                node.get_padding(St.Side.LEFT));
        }, this);

        this._manager.connectObject('changed', () => this._sync(), this);
        this._sync();
    }

    _applyAppearance() {
        const box = this.menu.box;
        const {variant, blurActive, bmsActive} = this._appearance;
        const toggle = (name, on) => (on ? box.add_style_class_name(name)
            : box.remove_style_class_name(name));

        toggle('wavebar-music-theme-dark', variant === 'dark');
        toggle('wavebar-music-theme-light', variant === 'light');
        // Fundo próprio, a menos que o BMS esteja cuidando dele (tema automático).
        toggle('wavebar-music-bg-dark', !blurActive && variant === 'dark');
        toggle('wavebar-music-bg-light', !blurActive && variant === 'light');
        // Com desfoque por trás, o nosso fundo fica mais translúcido.
        toggle('wavebar-music-over-blur', bmsActive);
    }

    // Só aparece com pelo menos um player ativo; anima só se estiver tocando.
    _sync() {
        this.visible = this._manager.players.length > 0;
        this.setPlaying(this._manager.anyPlaying);
    }

    setPlaying(playing) {
        this._equalizer.playing = playing;
        if (playing)
            this._pill.remove_style_class_name('wavebar-music-paused');
        else
            this._pill.add_style_class_name('wavebar-music-paused');
    }

    _onDestroy() {
        // Desconecta do menu ANTES de tudo: ao ser destruído (super._onDestroy)
        // o menu ainda se fecha e emite "open-state-changed" — e o card já
        // não existiria mais (erro "this._card is null" ao desativar com o
        // card aberto).
        this.menu.disconnectObject(this);
        this.menu.box.disconnectObject(this);
        this._appearance.disconnectObject(this);
        this._appearance = null;
        this._manager.disconnectObject(this);
        this._manager = null;
        super._onDestroy(); // destrói o menu e, junto, o card
        this._card = null;
    }
});
