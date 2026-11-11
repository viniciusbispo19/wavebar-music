// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Vinicius Bispo
// Camada MPRIS: descobre players no D-Bus da sessão e expõe seus metadados.
// Não sabe nada de interface gráfica — só emite sinais.
//
// Especificação: https://specifications.freedesktop.org/mpris-spec/latest/

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';

// O playerctld é um "espelho" do player ativo: se o listássemos, a mesma
// música apareceria duas vezes.
const IGNORED_NAMES = new Set([`${MPRIS_PREFIX}playerctld`]);

// Alguns players (o Spotify, por exemplo) demoram 1–2 s para atualizar o que
// informam no D-Bus depois de um comando. Nesses intervalos confiamos no que
// a própria Wavebar fez (atualização otimista) em vez do valor velho.
const STATUS_HOLD_US = 2000000;
const POSITION_HOLD_US = 2500000;

// O XML que vem com o GNOME Shell não tem Position/SetPosition/Seeked,
// por isso declaramos as interfaces completas aqui.
const MprisRootProxy = Gio.DBusProxy.makeProxyWrapper(`
<node>
  <interface name="org.mpris.MediaPlayer2">
    <method name="Raise"/>
    <property name="CanRaise" type="b" access="read"/>
    <property name="Identity" type="s" access="read"/>
    <property name="DesktopEntry" type="s" access="read"/>
  </interface>
</node>`);

const MprisPlayerProxy = Gio.DBusProxy.makeProxyWrapper(`
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="Next"/>
    <method name="Previous"/>
    <method name="PlayPause"/>
    <method name="Seek">
      <arg direction="in" name="Offset" type="x"/>
    </method>
    <method name="SetPosition">
      <arg direction="in" name="TrackId" type="o"/>
      <arg direction="in" name="Position" type="x"/>
    </method>
    <signal name="Seeked">
      <arg name="Position" type="x"/>
    </signal>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Rate" type="d" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="Position" type="x" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
  </interface>
</node>`);

/** Nome "base" do player a partir do barramento: org.mpris.MediaPlayer2.brave.instance7106 → brave */
export function busBaseName(busName) {
    return busName.slice(MPRIS_PREFIX.length).split('.')[0];
}

// Metadados MPRIS vêm "embrulhados" em GLib.Variant; alguns players mandam
// tipos errados (artista como string, duração como double…). Normalizamos tudo.
export function parseMetadata(variantDict) {
    const md = {};
    for (const [key, value] of Object.entries(variantDict ?? {})) {
        try {
            md[key] = value instanceof GLib.Variant ? value.deepUnpack() : value;
        } catch (e) {
            console.log(`[Wavebar] Metadado inválido ${key}: ${e.message}`);
        }
    }

    const str = v => (typeof v === 'string' ? v : '');
    let artists = md['xesam:artist'];
    if (typeof artists === 'string')
        artists = [artists];
    if (!Array.isArray(artists))
        artists = [];

    const length = Number(md['mpris:length'] ?? 0);

    return {
        trackId: str(md['mpris:trackid']),
        title: str(md['xesam:title']),
        artists: artists.filter(a => typeof a === 'string' && a.length > 0),
        album: str(md['xesam:album']),
        artUrl: str(md['mpris:artUrl']),
        length: Number.isFinite(length) && length > 0 ? length : 0, // µs
    };
}

/**
 * Um player MPRIS. Mantém cópias "limpas" dos metadados e estima a posição
 * localmente: pela especificação, Position NÃO é avisada via
 * PropertiesChanged, então guardamos (posição, instante) e extrapolamos.
 */
export const MprisPlayer = GObject.registerClass({
    GTypeName: 'WavebarMprisPlayer',
    Signals: {
        'ready': {},
        'changed': {},
        'seeked': {},
    },
}, class MprisPlayer extends GObject.Object {
    // appLookup({desktopEntry, busName, identity, pid}) → Shell.App | null. É injetado para que
    // este módulo não dependa do Shell (dá para rodá-lo com gjs puro).
    constructor(busName, appLookup = null) {
        super();

        this.busName = busName;
        this._appLookup = appLookup;
        this.ready = false;
        this.pid = 0;
        this.lastActive = 0; // GLib.get_monotonic_time() da última atividade

        this.identity = '';
        this.app = null;
        this.status = 'Stopped';
        this.rate = 1;
        this.metadata = parseMetadata(null);
        this.canGoNext = false;
        this.canGoPrevious = false;
        this.canPlay = false;
        this.canPause = false;
        this.canSeek = false;

        this._position = 0;
        this._positionTime = GLib.get_monotonic_time();
        this._positionHoldUntil = 0;
        this._statusHoldUntil = 0;
        this._statusBeforeToggle = null;
        this._resyncId = 0;

        this._cancellable = new Gio.Cancellable();
        this._seekedId = 0;
        this._initProxies().catch(e => {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.error(`[Wavebar] Falha ao conectar em ${busName}:`, e);
        });
    }

    async _initProxies() {
        const flags = Gio.DBusProxyFlags.GET_INVALIDATED_PROPERTIES;
        const [root, player] = await Promise.all([
            MprisRootProxy.newAsync(Gio.DBus.session, this.busName, MPRIS_PATH,
                this._cancellable, flags),
            MprisPlayerProxy.newAsync(Gio.DBus.session, this.busName, MPRIS_PATH,
                this._cancellable, flags),
        ]);
        if (this._cancellable.is_cancelled())
            return;

        this._rootProxy = root;
        this._playerProxy = player;
        this.pid = await this._getOwnerPid();

        root.connectObject('g-properties-changed', () => this._update(), this);
        player.connectObject('g-properties-changed', () => this._update(), this);
        this._seekedId = player.connectSignal('Seeked', (_p, _sender, [position]) => {
            this._setPosition(Number(position));
            this.emit('seeked');
        });

        this._update();
        await this.refreshPosition();

        this.ready = true;
        this.emit('ready');
    }

    // PID do processo dono do nome no barramento (para achar o app pela janela).
    async _getOwnerPid() {
        try {
            const reply = await Gio.DBus.session.call(
                'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
                'GetConnectionUnixProcessID', new GLib.Variant('(s)', [this.busName]),
                new GLib.VariantType('(u)'), Gio.DBusCallFlags.NONE, 2000, this._cancellable);
            return reply.deepUnpack()[0];
        } catch {
            return 0;
        }
    }

    get ownerName() {
        return this._playerProxy?.g_name_owner ?? null;
    }

    get trackKey() {
        const md = this.metadata;
        return `${this.busName}|${md.trackId}|${md.title}|${md.artists.join(',')}`;
    }

    // Um player "conta" se está tocando/pausado ou tem uma faixa carregada.
    get isActive() {
        return this.status === 'Playing' || this.status === 'Paused' ||
            this.metadata.title !== '';
    }

    get displayName() {
        return this.app?.get_name() ?? (this.identity || this.busName.slice(MPRIS_PREFIX.length));
    }

    /** Posição estimada agora, em microssegundos. */
    get position() {
        let pos = this._position;
        if (this.status === 'Playing')
            pos += (GLib.get_monotonic_time() - this._positionTime) * this.rate;
        const length = this.metadata.length;
        return Math.max(0, length > 0 ? Math.min(pos, length) : pos);
    }

    _setPosition(position) {
        this._position = Number.isFinite(position) ? position : 0;
        this._positionTime = GLib.get_monotonic_time();
    }

    _update() {
        const root = this._rootProxy, player = this._playerProxy;
        if (!root || !player)
            return;

        // Congela a posição estimada antes de o estado mudar (ex.: pausa).
        this._setPosition(this.position);

        const oldStatus = this.status;
        const oldKey = this.trackKey;

        this.identity = root.Identity ?? '';
        const desktopEntry = root.DesktopEntry ?? '';
        // Sem app achado, tenta de novo no máximo a cada 5 s (a janela do
        // player pode aparecer depois), sem varrer os apps a cada atualização.
        const retryApp = !this.app && GLib.get_monotonic_time() - (this._appLookupTime ?? 0) > 5e6;
        if (desktopEntry !== this._desktopEntry || retryApp) {
            this._desktopEntry = desktopEntry;
            this._appLookupTime = GLib.get_monotonic_time();
            this.app = this._appLookup?.({
                desktopEntry, busName: this.busName, identity: this.identity, pid: this.pid,
            }) ?? null;
        }

        const now = GLib.get_monotonic_time();
        const reportedStatus = player.PlaybackStatus ?? 'Stopped';
        // Logo após um play/pause nosso, um status igual ao de ANTES do clique
        // é só o player atrasado: mantemos o otimista.
        if (now > this._statusHoldUntil || reportedStatus !== this._statusBeforeToggle) {
            this.status = reportedStatus;
            this._statusHoldUntil = 0;
        }
        this.rate = Number(player.Rate ?? 1) || 1;

        // O Spotify às vezes manda um Metadata VAZIO entre uma faixa e outra
        // (logo em seguida vem o completo). Ignoramos esse "buraco" para o card
        // não piscar "Título desconhecido" e a capa genérica.
        const metadata = parseMetadata(player.Metadata);
        const emptyGlitch = !metadata.title && !metadata.trackId &&
            this.metadata.title && this.status !== 'Stopped';
        if (!emptyGlitch)
            this.metadata = metadata;
        this.canGoNext = !!player.CanGoNext;
        this.canGoPrevious = !!player.CanGoPrevious;
        this.canPlay = !!player.CanPlay;
        this.canPause = !!player.CanPause;
        this.canSeek = !!player.CanSeek;

        if (this.status === 'Playing' || this.trackKey !== oldKey)
            this.lastActive = now;

        // Faixa nova: a posição recomeça; confirmamos com o player.
        if (this.trackKey !== oldKey) {
            this._setPosition(0);
            this.refreshPosition().catch(() => {});
        } else if (this.status !== oldStatus) {
            this.refreshPosition().catch(() => {});
        }

        this.emit('changed');
    }

    /** Lê Position direto do player (o cache do proxy fica velho). */
    async refreshPosition() {
        // Logo após um seek nosso o player pode ainda informar a posição antiga.
        if (!this._playerProxy || GLib.get_monotonic_time() < this._positionHoldUntil)
            return;
        try {
            const reply = await Gio.DBus.session.call(
                this.busName, MPRIS_PATH, 'org.freedesktop.DBus.Properties', 'Get',
                new GLib.Variant('(ss)', [PLAYER_IFACE, 'Position']),
                new GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, 2000,
                this._cancellable);
            const [value] = reply.deepUnpack();
            this._setPosition(Number(value.deepUnpack()));
        } catch (e) {
            // Alguns players (ex.: navegadores sem mídia) não implementam Position.
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                this._positionUnsupported = true;
        }
    }

    _call(method, ...args) {
        if (!this._playerProxy)
            return;
        this._playerProxy[`${method}Async`](...args).catch(e => {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.error(`[Wavebar] ${method} falhou em ${this.busName}:`, e.message);
        });
    }

    playPause() {
        // Otimista: o ícone/equalizador respondem na hora do clique.
        this._statusBeforeToggle = this.status;
        this._statusHoldUntil = GLib.get_monotonic_time() + STATUS_HOLD_US;
        this._setPosition(this.position);
        this.status = this.status === 'Playing' ? 'Paused' : 'Playing';
        this._call('PlayPause');
        this.emit('changed');
    }

    next() {
        this._call('Next');
        this._scheduleResync();
    }

    previous() {
        this._call('Previous');
        this._scheduleResync();
    }

    // "Anterior" no meio da música costuma só reiniciar a faixa, e players
    // como o Spotify não avisam (sem Seeked). Relemos a posição logo depois.
    _scheduleResync() {
        this._positionHoldUntil = 0;
        if (this._resyncId)
            GLib.source_remove(this._resyncId);
        let step = 0;
        // O Spotify leva ~1 s para informar a posição nova; relemos em
        // 0,6 / 1,2 / 1,8 / 2,4 s para cobrir players ainda mais lentos.
        this._resyncId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => {
            this.refreshPosition().then(() => this.emit('seeked')).catch(() => {});
            if (++step < 4)
                return GLib.SOURCE_CONTINUE;
            this._resyncId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Pula para `position` (µs). Usa SetPosition; sem trackId, cai para Seek. */
    setPosition(position) {
        if (!this.canSeek)
            return;
        const length = this.metadata.length;
        position = Math.round(Math.max(0, length > 0 ? Math.min(position, length) : position));
        const trackId = this.metadata.trackId;

        if (trackId && GLib.Variant.is_object_path(trackId))
            this._call('SetPosition', trackId, position);
        else
            this._call('Seek', Math.round(position - this.position));

        // Atualização otimista: a UI não "volta" enquanto o player responde.
        this._setPosition(position);
        this._positionHoldUntil = GLib.get_monotonic_time() + POSITION_HOLD_US;
    }

    raise() {
        if (this.app)
            this.app.activate();
        else if (this._rootProxy?.CanRaise)
            this._rootProxy.RaiseAsync().catch(() => {});
    }

    destroy() {
        if (this._resyncId) {
            GLib.source_remove(this._resyncId);
            this._resyncId = 0;
        }
        this._cancellable.cancel();
        this._rootProxy?.disconnectObject(this);
        this._playerProxy?.disconnectObject(this);
        if (this._seekedId)
            this._playerProxy?.disconnectSignal(this._seekedId);
        this._seekedId = 0;
        this._rootProxy = null;
        this._playerProxy = null;
        this.app = null;
    }
});

/**
 * Observa o D-Bus (NameOwnerChanged) e mantém a lista de players.
 * Emite 'changed' quando a lista, o player atual ou o estado dele mudam.
 *
 * Regra do "player atual":
 *   1. o que começou a tocar por último;
 *   2. senão, o escolhido manualmente pelo usuário (setas do card);
 *   3. senão, o último que esteve ativo.
 */
export const MprisManager = GObject.registerClass({
    GTypeName: 'WavebarMprisManager',
    Signals: {
        'changed': {},
        'seeked': {},
    },
}, class MprisManager extends GObject.Object {
    constructor(appLookup = null) {
        super();
        this._appLookup = appLookup;
        this._players = new Map(); // busName → MprisPlayer
        this._current = null;
        this._manual = false;
        this._listKey = '';
        this._nameOwnerId = 0;
        this._cancellable = null;
    }

    start() {
        this._cancellable = new Gio.Cancellable();

        // MATCH_ARG0_NAMESPACE: o próprio D-Bus filtra só nomes org.mpris.MediaPlayer2.*
        this._nameOwnerId = Gio.DBus.session.signal_subscribe(
            'org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
            '/org/freedesktop/DBus', 'org.mpris.MediaPlayer2',
            Gio.DBusSignalFlags.MATCH_ARG0_NAMESPACE,
            (_conn, _sender, _path, _iface, _signal, params) => {
                const [name, oldOwner, newOwner] = params.deepUnpack();
                if (oldOwner)
                    this._removePlayer(name);
                if (newOwner)
                    this._addPlayer(name);
            });

        this._listExisting().catch(e => {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.error('[Wavebar] Falha ao listar players:', e);
        });
    }

    async _listExisting() {
        const reply = await Gio.DBus.session.call(
            'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
            'ListNames', null, new GLib.VariantType('(as)'),
            Gio.DBusCallFlags.NONE, -1, this._cancellable);
        const [names] = reply.deepUnpack();
        names.filter(n => n.startsWith(MPRIS_PREFIX)).forEach(n => this._addPlayer(n));
    }

    /** Players prontos e ativos, na ordem em que apareceram. */
    get players() {
        return [...this._players.values()].filter(p => p.ready && p.isActive);
    }

    get current() {
        return this._current;
    }

    get anyPlaying() {
        return this.players.some(p => p.status === 'Playing');
    }

    /** Escolha manual (setas do card). Vale até outro player começar a tocar. */
    selectPlayer(player) {
        if (!this.players.includes(player))
            return;
        this._manual = true;
        this._setCurrent(player);
    }

    /** Alterna para o próximo (+1) ou anterior (-1) player da lista. */
    cyclePlayer(step) {
        const list = this.players;
        if (list.length < 2)
            return;
        const index = list.indexOf(this._current);
        this.selectPlayer(list[(index + step + list.length) % list.length]);
    }

    _addPlayer(busName) {
        if (IGNORED_NAMES.has(busName) || this._players.has(busName))
            return;

        const player = new MprisPlayer(busName, this._appLookup);
        this._players.set(busName, player);

        let lastStatus = player.status;
        player.connectObject(
            'ready', () => {
                // Mesmo processo com dois nomes no barramento? Fica só o primeiro.
                const dup = [...this._players.values()].find(p =>
                    p !== player && p.ready && p.ownerName && p.ownerName === player.ownerName);
                if (dup) {
                    this._removePlayer(busName);
                    return;
                }
                lastStatus = player.status;
                if (player.status === 'Playing')
                    this._onStartedPlaying(player);
                else
                    this._updateCurrent();
            },
            'changed', () => {
                if (!player.ready)
                    return;
                const started = player.status === 'Playing' && lastStatus !== 'Playing';
                lastStatus = player.status;
                if (started)
                    this._onStartedPlaying(player);
                else
                    this._updateCurrent(player);
            },
            'seeked', () => {
                if (player === this._current)
                    this.emit('seeked');
            }, this);
    }

    _removePlayer(busName) {
        const player = this._players.get(busName);
        if (!player)
            return;
        this._players.delete(busName);
        player.disconnectObject(this);
        player.destroy();
        if (this._current === player)
            this._current = null;
        this._updateCurrent(null, true);
    }

    _onStartedPlaying(player) {
        this._manual = false;
        this._setCurrent(player);
    }

    _setCurrent(player) {
        this._current = player;
        this._updateCurrent(null, true);
    }

    // `source`: player que mudou (se só ele mudou, avisamos apenas se for o atual).
    _updateCurrent(source = null, force = false) {
        const candidates = this.players;
        let current = candidates.includes(this._current) ? this._current : null;
        if (!current)
            this._manual = false;

        if (!this._manual && current?.status !== 'Playing') {
            const byRecent = (a, b) => b.lastActive - a.lastActive;
            const playing = candidates.filter(p => p.status === 'Playing').sort(byRecent);
            current = playing[0] ?? current ?? [...candidates].sort(byRecent)[0] ?? null;
        }

        const switched = current !== this._current;
        this._current = current;

        // Lista + status de cada um: importa para o seletor do card e para o
        // ícone, que anima se QUALQUER player estiver tocando.
        const listKey = candidates.map(p => `${p.busName}:${p.status}`).join('\n');
        const listChanged = listKey !== this._listKey;
        this._listKey = listKey;

        if (switched || force || listChanged || !source || source === current)
            this.emit('changed');
    }

    destroy() {
        if (this._nameOwnerId) {
            Gio.DBus.session.signal_unsubscribe(this._nameOwnerId);
            this._nameOwnerId = 0;
        }
        this._cancellable?.cancel();
        this._cancellable = null;
        for (const player of this._players.values()) {
            player.disconnectObject(this);
            player.destroy();
        }
        this._players.clear();
        this._current = null;
    }
});
