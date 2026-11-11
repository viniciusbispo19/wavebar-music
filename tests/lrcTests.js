// SPDX-License-Identifier: GPL-3.0-or-later
import {cleanTitle, findLineIndex, parseLrc, pickBestResult, toLyrics} from '../lib/lrc.js';

export function register({test, assert, assertEqual}) {
    test('parseLrc: formatos de tempo e ordenação', () => {
        const lines = parseLrc('[ar:Queen]\n[00:12.50]B\n[00:01]A\n[01:02.123]C\n[00:20:30]D');
        assertEqual(lines.map(l => l.text), ['A', 'B', 'D', 'C']);
        assertEqual(lines.map(l => l.time), [1e6, 12.5e6, 20.3e6, 62.123e6]);
    });

    test('parseLrc: vários tempos na mesma linha e linhas vazias', () => {
        const lines = parseLrc('[00:10.00][00:30.00]refrão\n[00:20.00]\n');
        assertEqual(lines.map(l => [l.time / 1e6, l.text]), [[10, 'refrão'], [20, ''], [30, 'refrão']]);
    });

    test('parseLrc: [offset:] adianta/atrasa', () => {
        assertEqual(parseLrc('[offset:+500]\n[00:10.00]x')[0].time, 9.5e6);
        assertEqual(parseLrc('[offset:-500]\n[00:10.00]x')[0].time, 10.5e6);
    });

    test('parseLrc: entrada vazia/inválida', () => {
        assertEqual(parseLrc(''), []);
        assertEqual(parseLrc(null), []);
        assertEqual(parseLrc('texto sem tempo'), []);
    });

    test('findLineIndex', () => {
        const lines = parseLrc('[00:05.00]a\n[00:10.00]b\n[00:15.00]c');
        assertEqual(findLineIndex(lines, 0), -1);
        assertEqual(findLineIndex(lines, 5e6), 0);
        assertEqual(findLineIndex(lines, 12e6), 1);
        assertEqual(findLineIndex(lines, 99e6), 2);
        assertEqual(findLineIndex([], 1), -1);
    });

    test('cleanTitle', () => {
        assertEqual(cleanTitle('Song (Official Video) [HD]'), 'Song');
        assertEqual(cleanTitle('Song - Remastered 2011'), 'Song');
        assertEqual(cleanTitle('Song - 2011 Remaster'), 'Song');
        assertEqual(cleanTitle('Song (Live at Wembley)'), 'Song (Live at Wembley)');
        assertEqual(cleanTitle('Canção (Clipe Oficial)'), 'Canção');
    });

    test('pickBestResult: respeita duração e prefere sincronizada', () => {
        const results = [
            {trackName: 'Song', artistName: 'Band', duration: 300, plainLyrics: 'x'},
            {trackName: 'Song', artistName: 'Band', duration: 201, plainLyrics: 'x'},
            {trackName: 'Song', artistName: 'Band', duration: 200, syncedLyrics: '[00:01]x', plainLyrics: 'x'},
        ];
        assertEqual(pickBestResult(results, {title: 'Song', artist: 'Band', durationS: 200}).duration, 200);
        assertEqual(pickBestResult(results, {title: 'Song', artist: 'Band', durationS: 500}), null);
        assertEqual(pickBestResult([], {title: 'x'}), null);
        assertEqual(pickBestResult(null, {title: 'x'}), null);
    });

    test('toLyrics', () => {
        assertEqual(toLyrics({syncedLyrics: '[00:01]a'}).kind, 'synced');
        assertEqual(toLyrics({syncedLyrics: '', plainLyrics: ' a '}), {kind: 'plain', text: 'a'});
        assertEqual(toLyrics({instrumental: true}), {kind: 'instrumental'});
        assertEqual(toLyrics({}), null);
        assert(toLyrics(null) === null, 'null');
    });
}
