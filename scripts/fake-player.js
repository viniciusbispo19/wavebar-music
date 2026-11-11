#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: GPL-3.0-or-later
// Player MPRIS FALSO, só para testes. Na sessão aninhada (D-Bus separado)
// os players da sua sessão real não aparecem, então simulamos um.
//
// Uso (com a sessão aninhada rodando):
//   ./scripts/nested-run.sh gjs -m scripts/fake-player.js
//   ./scripts/nested-run.sh gjs -m scripts/fake-player.js --name vlc --identity VLC \
//       --desktop-entry vlc --paused --track 2
//
// Controle pelo terminal (exemplos):
//   ./scripts/nested-run.sh gdbus call --session -d org.mpris.MediaPlayer2.wavebar_fake \
//       -o /org/mpris/MediaPlayer2 -m org.mpris.MediaPlayer2.Player.PlayPause

import Cairo from 'cairo';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

// ---------- argumentos ----------
const opts = {name: 'wavebar_fake', identity: 'Fake Player', desktopEntry: '', paused: false, track: 0};
for (let i = 0; i < System.programArgs.length; i++) {
    const arg = System.programArgs[i];
    const next = () => System.programArgs[++i];
    if (arg === '--name') opts.name = next();
    else if (arg === '--identity') opts.identity = next();
    else if (arg === '--desktop-entry') opts.desktopEntry = next();
    else if (arg === '--paused') opts.paused = true;
    else if (arg === '--track') opts.track = Number(next());
}

// ---------- capas geradas (file:// e data:) ----------
function makeCover(path, [r1, g1, b1], [r2, g2, b2]) {
    const surface = new Cairo.ImageSurface(Cairo.Format.RGB24, 400, 400);
    const cr = new Cairo.Context(surface);
    const grad = new Cairo.LinearGradient(0, 0, 400, 400);
    grad.addColorStopRGB(0, r1, g1, b1);
    grad.addColorStopRGB(1, r2, g2, b2);
    cr.setSource(grad);
    cr.paint();
    cr.setSourceRGBA(1, 1, 1, 0.85);
    cr.arc(200, 200, 90, 0, 2 * Math.PI);
    cr.setLineWidth(18);
    cr.stroke();
    cr.$dispose();
    surface.writeToPNG(path);
}

const tmpDir = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'wavebar-fake']);
GLib.mkdir_with_parents(tmpDir, 0o700);
const filePng = GLib.build_filenamev([tmpDir, `cover-${opts.name}.png`]);
const dataPng = GLib.build_filenamev([tmpDir, `data-${opts.name}.png`]);
makeCover(filePng, [0.45, 0.1, 0.6], [0.95, 0.4, 0.3]);
makeCover(dataPng, [0.05, 0.4, 0.5], [0.2, 0.9, 0.6]);
const [, dataBytes] = GLib.file_get_contents(dataPng);
const dataUri = `data:image/png;base64,${GLib.base64_encode(dataBytes)}`;

const TRACKS = [
    {title: 'Bohemian Rhapsody', artist: ['Queen'], album: 'A Night at the Opera',
        length: 354, art: GLib.filename_to_uri(filePng, null)},
    {title: 'Never Gonna Give You Up', artist: ['Rick Astley'], album: 'Whenever You Need Somebody',
        length: 213, art: 'https://picsum.photos/seed/wavebar/400'},
    {title: 'Faixa Que Não Existe', artist: ['Wavebar Teste'], album: 'Sem Letra',
        length: 95, art: dataUri},
    // Instrumental no LRCLIB e sem capa (testa o placeholder).
    {title: 'Time', artist: ['Hans Zimmer'], album: 'Inception', length: 276, art: ''},
];

// ---------- estado ----------
let index = Math.min(Math.max(opts.track, 0), TRACKS.length - 1);
let status = opts.paused ? 'Paused' : 'Playing';
let basePos = 0; // µs
let baseTime = GLib.get_monotonic_time();

const position = () => {
    let p = basePos + (status === 'Playing' ? GLib.get_monotonic_time() - baseTime : 0);
    const len = TRACKS[index].length * 1e6;
    return len > 0 ? Math.min(p, len) : p;
};
const setPos = p => {
    basePos = p;
    baseTime = GLib.get_monotonic_time();
};
const trackId = () => `/org/wavebar/fake/track${index}`;

function metadata() {
    const t = TRACKS[index];
    const md = {
        'mpris:trackid': new GLib.Variant('o', trackId()),
        'xesam:title': new GLib.Variant('s', t.title),
        'xesam:artist': new GLib.Variant('as', t.artist),
        'xesam:album': new GLib.Variant('s', t.album),
    };
    if (t.length)
        md['mpris:length'] = new GLib.Variant('x', t.length * 1e6);
    if (t.art)
        md['mpris:artUrl'] = new GLib.Variant('s', t.art);
    return md;
}

// ---------- interfaces D-Bus ----------
const ROOT_XML = `<node><interface name="org.mpris.MediaPlayer2">
  <method name="Raise"/><method name="Quit"/>
  <property name="CanQuit" type="b" access="read"/>
  <property name="CanRaise" type="b" access="read"/>
  <property name="HasTrackList" type="b" access="read"/>
  <property name="Identity" type="s" access="read"/>
  <property name="DesktopEntry" type="s" access="read"/>
  <property name="SupportedUriSchemes" type="as" access="read"/>
  <property name="SupportedMimeTypes" type="as" access="read"/>
</interface></node>`;

const PLAYER_XML = `<node><interface name="org.mpris.MediaPlayer2.Player">
  <method name="Next"/><method name="Previous"/><method name="Pause"/>
  <method name="PlayPause"/><method name="Stop"/><method name="Play"/>
  <method name="Seek"><arg direction="in" name="Offset" type="x"/></method>
  <method name="SetPosition"><arg direction="in" name="TrackId" type="o"/><arg direction="in" name="Position" type="x"/></method>
  <method name="OpenUri"><arg direction="in" name="Uri" type="s"/></method>
  <signal name="Seeked"><arg name="Position" type="x"/></signal>
  <property name="PlaybackStatus" type="s" access="read"/>
  <property name="Rate" type="d" access="read"/>
  <property name="Metadata" type="a{sv}" access="read"/>
  <property name="Volume" type="d" access="read"/>
  <property name="Position" type="x" access="read"/>
  <property name="MinimumRate" type="d" access="read"/>
  <property name="MaximumRate" type="d" access="read"/>
  <property name="CanGoNext" type="b" access="read"/>
  <property name="CanGoPrevious" type="b" access="read"/>
  <property name="CanPlay" type="b" access="read"/>
  <property name="CanPause" type="b" access="read"/>
  <property name="CanSeek" type="b" access="read"/>
  <property name="CanControl" type="b" access="read"/>
</interface></node>`;

const loop = new GLib.MainLoop(null, false);

const root = {
    CanQuit: true, CanRaise: false, HasTrackList: false,
    Identity: opts.identity, DesktopEntry: opts.desktopEntry,
    SupportedUriSchemes: [], SupportedMimeTypes: [],
    Raise() {},
    Quit() {
        loop.quit();
    },
};

let playerExport;
function notify(...props) {
    for (const p of props) {
        const value = {
            PlaybackStatus: new GLib.Variant('s', status),
            Metadata: new GLib.Variant('a{sv}', metadata()),
        }[p];
        playerExport.emit_property_changed(p, value);
    }
    playerExport.flush();
}
function changeTrack(step) {
    index = (index + step + TRACKS.length) % TRACKS.length;
    setPos(0);
    status = 'Playing';
    notify('Metadata', 'PlaybackStatus');
    print(`▶ ${TRACKS[index].artist.join(', ')} — ${TRACKS[index].title}`);
}
function setStatus(s) {
    setPos(position());
    status = s;
    notify('PlaybackStatus');
    print(`● ${s}`);
}

const player = {
    get PlaybackStatus() {
        return status;
    },
    get Metadata() {
        return metadata();
    },
    get Position() {
        return position();
    },
    Rate: 1, Volume: 1, MinimumRate: 1, MaximumRate: 1,
    CanGoNext: true, CanGoPrevious: true, CanPlay: true, CanPause: true,
    CanSeek: true, CanControl: true,
    Next: () => changeTrack(1),
    Previous: () => changeTrack(-1),
    Play: () => setStatus('Playing'),
    Pause: () => setStatus('Paused'),
    Stop: () => setStatus('Stopped'),
    PlayPause: () => setStatus(status === 'Playing' ? 'Paused' : 'Playing'),
    OpenUri() {},
    Seek(offset) {
        setPos(Math.max(0, position() + offset));
        playerExport.emit_signal('Seeked', new GLib.Variant('(x)', [position()]));
    },
    SetPosition(id, pos) {
        if (id !== trackId())
            return; // a especificação manda ignorar trackId desatualizado
        setPos(pos);
        playerExport.emit_signal('Seeked', new GLib.Variant('(x)', [pos]));
        print(`⇥ seek ${(pos / 1e6).toFixed(1)} s`);
    },
};

const rootExport = Gio.DBusExportedObject.wrapJSObject(ROOT_XML, root);
playerExport = Gio.DBusExportedObject.wrapJSObject(PLAYER_XML, player);
rootExport.export(Gio.DBus.session, '/org/mpris/MediaPlayer2');
playerExport.export(Gio.DBus.session, '/org/mpris/MediaPlayer2');

// Fim da faixa → próxima (como um player de verdade).
GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
    const len = TRACKS[index].length * 1e6;
    if (status === 'Playing' && len > 0 && position() >= len)
        changeTrack(1);
    return GLib.SOURCE_CONTINUE;
});

Gio.bus_own_name_on_connection(Gio.DBus.session, `org.mpris.MediaPlayer2.${opts.name}`,
    Gio.BusNameOwnerFlags.NONE,
    () => print(`Fake player "${opts.identity}" no ar: org.mpris.MediaPlayer2.${opts.name}`),
    () => {
        print('Não consegui o nome no D-Bus (já existe?)');
        loop.quit();
    });

print(`▶ ${TRACKS[index].artist.join(', ')} — ${TRACKS[index].title} (${status})`);
loop.run();
