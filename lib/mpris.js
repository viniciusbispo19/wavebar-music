// SPDX-License-Identifier: GPL-3.0-or-later
// Camada MPRIS: descobre players no D-Bus da sessão e expõe seus metadados.
// Não sabe nada de interface gráfica — só emite sinais.
//
// Especificação: https://specifications.freedesktop.org/mpris-spec/latest/

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';

// O playerctld é um "espelho" do player ativo: se o listássemos, a mesma
// música apareceria duas vezes.
const IGNORED_NAMES = new Set([`${MPRIS_PREFIX}playerctld`]);

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

// Busca o .desktop a partir do DesktopEntry (ou do nome no barramento).
// Vários players não informam o nome exato do arquivo: o Firefox diz
// "firefox", mas no Fedora o arquivo é org.mozilla.firefox.desktop.
function lookupApp(desktopEntry, busName) {
    const appSystem = Shell.AppSystem.get_default();
    const guesses = [desktopEntry, busName.slice(MPRIS_PREFIX.length).split('.')[0]]
        .filter(Boolean);

    for (const name of guesses) {
        const app = appSystem.lookup_app(`${name}.desktop`) ??
            appSystem.lookup_desktop_wmclass(name) ??
            appSystem.lookup_startup_wmclass(name) ??
            appSystem.lookup_heuristic_basename(name);
        if (app)
            return app;
    }
    return null;
}

// Metadados MPRIS vêm "embrulhados" em GLib.Variant; alguns players mandam
// tipos errados (artista como string, duração como double…). Normalizamos tudo.
function parseMetadata(variantDict) {
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
    constructor(busName) {
        super();

        this.busName = busName;
        this.ready = false;
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
        if (desktopEntry !== this._desktopEntry || !this.app) {
            this._desktopEntry = desktopEntry;
            this.app = lookupApp(desktopEntry, this.busName);
        }

        this.status = player.PlaybackStatus ?? 'Stopped';
        this.rate = Number(player.Rate ?? 1) || 1;
        this.metadata = parseMetadata(player.Metadata);
        this.canGoNext = !!player.CanGoNext;
        this.canGoPrevious = !!player.CanGoPrevious;
        this.canPlay = !!player.CanPlay;
        this.canPause = !!player.CanPause;
        this.canSeek = !!player.CanSeek;

        if (this.status === 'Playing' || this.trackKey !== oldKey)
            this.lastActive = GLib.get_monotonic_time();

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
        if (!this._playerProxy)
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
        this._call('PlayPause');
    }

    next() {
        this._call('Next');
    }

    previous() {
        this._call('Previous');
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
    }

    raise() {
        if (this.app)
            this.app.activate();
        else if (this._rootProxy?.CanRaise)
            this._rootProxy.RaiseAsync().catch(() => {});
    }

    destroy() {
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
    constructor() {
        super();
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

        const player = new MprisPlayer(busName);
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
