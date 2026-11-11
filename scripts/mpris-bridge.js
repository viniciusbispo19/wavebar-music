#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Vinicius Bispo
//
// PONTE MPRIS: espelha os players da sua sessão real (Spotify, Deezer,
// navegadores…) dentro do D-Bus da sessão aninhada de testes.
//
// Por quê: a sessão aninhada tem um D-Bus só dela, então a Wavebar Music de teste
// não enxerga seus players. A ponte publica, para cada player real, um objeto
// com o MESMO nome no barramento aninhado e repassa tudo "cru":
//   - leitura de propriedades (Get/GetAll) → lidas na hora do player real;
//   - métodos (PlayPause, SetPosition…) → executados no player real;
//   - sinais PropertiesChanged e Seeked → reenviados para o aninhado.
// Assim os testes veem exatamente as esquisitices de cada app.
//
// Uso (com scripts/dev-nested.sh rodando; roda na SUA sessão, não no nested-run):
//   gjs -m scripts/mpris-bridge.js

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

const PREFIX = 'org.mpris.MediaPlayer2.';
const PATH = '/org/mpris/MediaPlayer2';

const XML = `<node>
  <interface name="org.mpris.MediaPlayer2">
    <method name="Raise"/><method name="Quit"/>
    <property name="CanQuit" type="b" access="read"/>
    <property name="Fullscreen" type="b" access="readwrite"/>
    <property name="CanSetFullscreen" type="b" access="read"/>
    <property name="CanRaise" type="b" access="read"/>
    <property name="HasTrackList" type="b" access="read"/>
    <property name="Identity" type="s" access="read"/>
    <property name="DesktopEntry" type="s" access="read"/>
    <property name="SupportedUriSchemes" type="as" access="read"/>
    <property name="SupportedMimeTypes" type="as" access="read"/>
  </interface>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="Next"/><method name="Previous"/><method name="Pause"/>
    <method name="PlayPause"/><method name="Stop"/><method name="Play"/>
    <method name="Seek"><arg direction="in" name="Offset" type="x"/></method>
    <method name="SetPosition"><arg direction="in" name="TrackId" type="o"/><arg direction="in" name="Position" type="x"/></method>
    <method name="OpenUri"><arg direction="in" name="Uri" type="s"/></method>
    <signal name="Seeked"><arg name="Position" type="x"/></signal>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="LoopStatus" type="s" access="readwrite"/>
    <property name="Rate" type="d" access="readwrite"/>
    <property name="Shuffle" type="b" access="readwrite"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="Volume" type="d" access="readwrite"/>
    <property name="Position" type="x" access="read"/>
    <property name="MinimumRate" type="d" access="read"/>
    <property name="MaximumRate" type="d" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
    <property name="CanControl" type="b" access="read"/>
  </interface>
</node>`;
const NODE = Gio.DBusNodeInfo.new_for_xml(XML);

const stateDir = GLib.build_filenamev([GLib.get_user_state_dir(), 'wavebar-music']);
const [, busBytes] = GLib.file_get_contents(GLib.build_filenamev([stateDir, 'nested-bus']));
const nestedAddress = new TextDecoder().decode(busBytes).trim().split('#')[0];

const real = Gio.DBus.session;
const bridges = new Map(); // nome → {conn, ids, signalId, nameId}

function log(msg) {
    print(`[ponte] ${msg}`);
}

function bridge(name) {
    if (bridges.has(name))
        return;
    const conn = Gio.DBusConnection.new_for_address_sync(nestedAddress,
        Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT |
        Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, null, null);

    const ids = NODE.interfaces.map(iface => conn.register_object(PATH, iface,
        // Método: executa no player real e devolve a resposta original.
        (_c, _sender, _path, ifaceName, method, params, invocation) => {
            real.call(name, PATH, ifaceName, method, params, null,
                Gio.DBusCallFlags.NONE, 5000, null, (_r, res) => {
                    try {
                        invocation.return_value(real.call_finish(res));
                    } catch (e) {
                        invocation.return_gerror(e);
                    }
                });
        },
        // Propriedade: lida na hora (Position muda o tempo todo).
        (_c, _sender, _path, ifaceName, prop) => {
            try {
                const reply = real.call_sync(name, PATH, 'org.freedesktop.DBus.Properties',
                    'Get', new GLib.Variant('(ss)', [ifaceName, prop]),
                    new GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, 2000, null);
                return reply.get_child_value(0).get_variant();
            } catch {
                return null; // o player não tem essa propriedade
            }
        },
        (_c, _sender, _path, ifaceName, prop, value) => {
            real.call_sync(name, PATH, 'org.freedesktop.DBus.Properties', 'Set',
                new GLib.Variant('(ssv)', [ifaceName, prop, value]), null,
                Gio.DBusCallFlags.NONE, 2000, null);
            return true;
        }));

    // Sinais do player real → reemitidos no aninhado, sem alteração.
    const signalId = real.signal_subscribe(name, null, null, PATH, null,
        Gio.DBusSignalFlags.NONE,
        (_c, _sender, _path, iface, signal, params) => {
            if (iface === 'org.freedesktop.DBus.Properties' || signal === 'Seeked')
                conn.emit_signal(null, PATH, iface, signal, params);
        });

    const nameId = Gio.bus_own_name_on_connection(conn, name,
        Gio.BusNameOwnerFlags.NONE, () => log(`+ ${name}`), () => log(`! não consegui ${name}`));

    bridges.set(name, {conn, ids, signalId, nameId});
}

function unbridge(name) {
    const b = bridges.get(name);
    if (!b)
        return;
    real.signal_unsubscribe(b.signalId);
    Gio.bus_unown_name(b.nameId);
    b.ids.forEach(id => b.conn.unregister_object(id));
    b.conn.close_sync(null);
    bridges.delete(name);
    log(`- ${name}`);
}

real.signal_subscribe('org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
    '/org/freedesktop/DBus', 'org.mpris.MediaPlayer2', Gio.DBusSignalFlags.MATCH_ARG0_NAMESPACE,
    (_c, _s, _p, _i, _sig, params) => {
        const [name, oldOwner, newOwner] = params.deepUnpack();
        if (oldOwner)
            unbridge(name);
        if (newOwner)
            bridge(name);
    });

const [names] = real.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus',
    'org.freedesktop.DBus', 'ListNames', null, null, Gio.DBusCallFlags.NONE, -1, null)
    .deepUnpack();
names.filter(n => n.startsWith(PREFIX)).forEach(bridge);

log(`espelhando para ${nestedAddress} (Ctrl+C encerra)`);
const loop = new GLib.MainLoop(null, false);
loop.run();
System.exit(0);
