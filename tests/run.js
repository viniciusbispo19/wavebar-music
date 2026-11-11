// SPDX-License-Identifier: GPL-3.0-or-later
// Testes das partes puras (sem Shell). Rodar a partir da raiz do projeto:
//   gjs -m tests/run.js

import System from 'system';

import {formatTime, generateWaveform, hashString} from '../lib/util.js';
import {LruMap} from '../lib/cache.js';
import * as lrcTests from './lrcTests.js';

let failures = 0, passed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
    } catch (e) {
        failures++;
        print(`✗ ${name}\n    ${e.message}`);
    }
}

function assertEqual(actual, expected, msg = '') {
    const a = JSON.stringify(actual), b = JSON.stringify(expected);
    if (a !== b)
        throw new Error(`${msg} esperado ${b}, obtido ${a}`);
}

function assert(cond, msg) {
    if (!cond)
        throw new Error(msg);
}

// ---------- util.js ----------
test('hashString é determinístico e diferencia textos', () => {
    assertEqual(hashString('Queen|Bohemian Rhapsody'), hashString('Queen|Bohemian Rhapsody'));
    assert(hashString('a') !== hashString('b'), 'hash igual para textos diferentes');
});

test('generateWaveform: estável, tamanho certo e alturas em [0.12, 1]', () => {
    const a = generateWaveform('Bohemian Rhapsody', 60);
    const b = generateWaveform('Bohemian Rhapsody', 60);
    assertEqual(a, b, 'mesma semente');
    assertEqual(a.length, 60);
    assert(a.every(h => h >= 0.12 && h <= 1), 'altura fora do intervalo');
    assert(JSON.stringify(a) !== JSON.stringify(generateWaveform('Outra', 60)), 'músicas diferentes, onda igual');
});

test('generateWaveform aceita 0 e 1 barra', () => {
    assertEqual(generateWaveform('x', 0), []);
    assertEqual(generateWaveform('x', 1).length, 1);
});

test('formatTime', () => {
    assertEqual(formatTime(0), '0:00');
    assertEqual(formatTime(5e6), '0:05');
    assertEqual(formatTime(354e6), '5:54');
    assertEqual(formatTime(3725e6), '1:02:05');
    assertEqual(formatTime(-1), '0:00');
    assertEqual(formatTime(NaN), '0:00');
});

test('LruMap descarta o item usado há mais tempo', () => {
    const m = new LruMap(2);
    m.set('a', 1);
    m.set('b', 2);
    m.get('a');      // 'a' vira o mais recente
    m.set('c', 3);   // estoura o limite: sai 'b'
    assert(m.has('a') && m.has('c') && !m.has('b'), 'item errado descartado');
    assertEqual(m.size, 2);
});

lrcTests.register({test, assert, assertEqual});

print(`${passed} ok, ${failures} falha(s)`);
System.exit(failures ? 1 : 0);
