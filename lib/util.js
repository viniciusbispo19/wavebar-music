// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Vinicius Bispo
// Funções puras (sem St/Clutter/Shell): podem ser testadas com `gjs -m tests/run.js`.

/** Hash FNV-1a de 32 bits: mesma string → mesmo número, sempre. */
export function hashString(str) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

/** Gerador pseudoaleatório "mulberry32": determinístico a partir da semente. */
export function seededRandom(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Alturas (0.12–1) das barras da onda decorativa. O MPRIS não entrega o áudio,
 * então inventamos uma forma estável por música: três senoides lentas
 * ("partes" da música) + ruído, com início e fim suavizados.
 */
export function generateWaveform(seedText, count) {
    const rand = seededRandom(hashString(seedText));
    const waves = [1, 3, 8].map(base => ({
        freq: base + rand() * base,
        phase: rand() * Math.PI * 2,
    }));

    const heights = [];
    for (let i = 0; i < count; i++) {
        const x = count > 1 ? i / (count - 1) : 0;
        const shape = 0.5 +
            0.22 * Math.sin(waves[0].freq * x * Math.PI * 2 + waves[0].phase) +
            0.14 * Math.sin(waves[1].freq * x * Math.PI * 2 + waves[1].phase) +
            0.08 * Math.sin(waves[2].freq * x * Math.PI * 2 + waves[2].phase);
        let h = shape * 0.75 + rand() * 0.4;

        // Fade-in/fade-out nas pontas, como uma música de verdade.
        const edge = Math.min(x, 1 - x);
        if (edge < 0.06)
            h *= 0.45 + 0.55 * (edge / 0.06);

        heights.push(Math.min(1, Math.max(0.12, h)));
    }
    return heights;
}

/** Microssegundos → "m:ss" (ou "h:mm:ss"). */
export function formatTime(us) {
    const total = Math.max(0, Math.floor((Number(us) || 0) / 1e6));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
