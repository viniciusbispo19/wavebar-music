// SPDX-License-Identifier: GPL-3.0-or-later
// Letras: parser LRC e escolha do melhor resultado do LRCLIB.
// Funções puras (sem Shell): testadas em tests/lrcTests.js.

// [mm:ss], [mm:ss.x], [mm:ss.xx], [mm:ss.xxx] e a variante [mm:ss:xx]
const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const OFFSET_TAG = /^\[offset:\s*([+-]?\d+)\s*\]/i;

/**
 * Converte texto LRC em [{time (µs), text}], ordenado por tempo.
 * Uma linha pode ter vários tempos ("[00:10.00][01:20.00]refrão").
 * Linhas vazias viram pausas instrumentais (text = '').
 */
export function parseLrc(lrc) {
    const lines = [];
    let offsetMs = 0;

    for (const raw of String(lrc ?? '').split(/\r?\n/)) {
        const offset = raw.trim().match(OFFSET_TAG);
        if (offset) {
            offsetMs = Number(offset[1]);
            continue;
        }

        const times = [];
        let lastIndex = 0;
        TIME_TAG.lastIndex = 0;
        let m;
        while ((m = TIME_TAG.exec(raw)) !== null) {
            // Só tags no começo da linha (ou coladas umas nas outras) contam.
            if (m.index !== lastIndex)
                break;
            const frac = m[3] ? Number(m[3].padEnd(3, '0')) : 0;
            times.push((Number(m[1]) * 60 + Number(m[2])) * 1000 + frac);
            lastIndex = TIME_TAG.lastIndex;
        }
        if (times.length === 0)
            continue; // metadados ([ar:], [ti:]…) ou lixo

        const text = raw.slice(lastIndex).trim();
        for (const ms of times)
            lines.push({time: Math.max(0, ms - offsetMs) * 1000, text});
    }

    lines.sort((a, b) => a.time - b.time);
    return lines;
}

/** Índice da linha ativa em `positionUs` (-1 antes da primeira). Busca binária. */
export function findLineIndex(lines, positionUs) {
    let lo = 0, hi = lines.length - 1, found = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (lines[mid].time <= positionUs) {
            found = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return found;
}

const NOISE = /\s*[([](?:[^)\]]*\b(?:official|video|audio|lyrics?|letra|legendado|visuali[sz]er|remaster(?:ed)?|hd|4k|mv|clipe)\b[^)\]]*)[)\]]/gi;
const REMASTER_SUFFIX = /\s+-\s+(?:\d{4}\s+)?(?:remaster(?:ed)?|mono|stereo|radio edit|single version)\b.*$/i;

/**
 * Limpa títulos "sujos" (comuns em navegadores/YouTube):
 * "Song (Official Video) [HD]" → "Song"; "Song - Remastered 2011" → "Song".
 */
export function cleanTitle(title) {
    return String(title ?? '')
        .replace(NOISE, '')
        .replace(REMASTER_SUFFIX, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

const normalize = s => String(s ?? '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Escolhe o melhor item de /api/search. Critérios: duração próxima
 * (até ±3 s), título/artista parecidos e preferência por letra sincronizada.
 * Devolve null se nada servir.
 */
export function pickBestResult(results, {title, artist, durationS}) {
    if (!Array.isArray(results))
        return null;
    const wantTitle = normalize(cleanTitle(title));
    const wantArtist = normalize(artist);

    let best = null, bestScore = -Infinity;
    for (const r of results) {
        if (!r || (!r.syncedLyrics && !r.plainLyrics && !r.instrumental))
            continue;

        let score = 0;
        if (durationS > 0 && r.duration > 0) {
            const diff = Math.abs(r.duration - durationS);
            if (diff > 3)
                continue; // outra versão da música: a sincronia ficaria errada
            score += 3 - diff;
        }
        const gotTitle = normalize(r.trackName);
        if (gotTitle === wantTitle)
            score += 4;
        else if (wantTitle && (gotTitle.includes(wantTitle) || wantTitle.includes(gotTitle)))
            score += 2;
        if (wantArtist && normalize(r.artistName).includes(wantArtist))
            score += 2;
        if (r.syncedLyrics)
            score += 1.5;

        if (score > bestScore) {
            best = r;
            bestScore = score;
        }
    }
    return best;
}

/**
 * Converte uma resposta do LRCLIB no formato usado pela interface:
 *   {kind: 'synced', lines} | {kind: 'plain', text} | {kind: 'instrumental'} | null
 */
export function toLyrics(record) {
    if (!record)
        return null;
    if (record.syncedLyrics) {
        const lines = parseLrc(record.syncedLyrics);
        if (lines.length > 0)
            return {kind: 'synced', lines};
    }
    if (record.plainLyrics?.trim())
        return {kind: 'plain', text: record.plainLyrics.trim()};
    if (record.instrumental)
        return {kind: 'instrumental'};
    return null;
}
