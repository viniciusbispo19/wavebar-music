// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Vinicius Bispo
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

// Palavras que marcam "lixo" entre parênteses/colchetes em títulos de vídeo.
// Sem \b: ele não entende acentos ("vídeo"); usamos "não é letra" (\p{L}) ao redor.
const NOISE_WORDS = 'official|oficial|v[ií]deo|[aá]udio|lyrics?|letra|legendad[oa]|' +
    'visuali[sz]er|remaster(?:ed|izad[oa])?|hd|hq|4k|mv|m/v|clipe';
const NOISE = new RegExp(
    `\\s*[([](?:[^)\\]]*(?<!\\p{L})(?:${NOISE_WORDS})(?!\\p{L})[^)\\]]*)[)\\]]`, 'giu');
const REMASTER_SUFFIX = /\s+[-–—]\s+(?:\d{4}\s+)?(?:remaster(?:ed)?|mono|stereo|radio edit|single version)\b.*$/i;
const DASH = /\s+[-–—]\s+/;
const CHANNEL_SUFFIX = /\s*(?:-\s*topic|vevo|official(?:\s+channel)?|oficial)\s*$/i;

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

/** "QueenVEVO" → "Queen"; "Queen - Topic" → "Queen"; "a-ha Official" → "a-ha". */
export function cleanArtist(artist) {
    return String(artist ?? '').replace(CHANNEL_SUFFIX, '').trim();
}

/**
 * Vídeos costumam vir como título "Artista - Música" e artista = nome do canal.
 * Se a parte antes do traço "parece" o artista (ou não há artista), separa.
 * Senão devolve como veio (ex.: "Música - Ao Vivo" de um player de verdade).
 */
export function splitArtistTitle(title, artist) {
    const cleanT = cleanTitle(title);
    const cleanA = cleanArtist(artist);
    const parts = cleanT.split(DASH);
    if (parts.length < 2)
        return {title: cleanT, artist: cleanA};

    const left = parts[0].trim();
    const right = parts.slice(1).join(' - ').trim();
    const l = normalize(left), a = normalize(cleanA);
    if (!a || l === a || l.includes(a) || a.includes(l) || l.replace(/ /g, '') === a.replace(/ /g, ''))
        return {title: right, artist: left};
    return {title: cleanT, artist: cleanA};
}

/**
 * Último recurso para vídeos: separa "X - Y" mesmo sem o X bater com o
 * artista (canais de terceiros, ex.: "LoopMusic") e tira QUALQUER parêntese.
 * Devolve null se o título não tem traço.
 */
export function forceSplitArtistTitle(title) {
    const parts = cleanTitle(title).split(DASH);
    if (parts.length < 2)
        return null;
    const strip = t => t.replace(/\s*[([][^)\]]*[)\]]/g, '').trim();
    const artist = strip(parts[0]);
    const song = strip(parts.slice(1).join(' - '));
    return artist && song ? {artist, title: song} : null;
}

const normalize = s => String(s ?? '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Escolhe o melhor item de /api/search. Pontua título/artista parecidos,
 * duração próxima e letra sincronizada.
 * Devolve {record, durationMatch} ou null. durationMatch = false quando só
 * havia versões com duração diferente (ex.: clipe com introdução): aí a
 * sincronia ficaria errada e a interface deve mostrar a letra sem sincronia.
 */
export function pickBestResult(results, {title, artist, durationS}) {
    if (!Array.isArray(results))
        return null;
    const wantTitle = normalize(cleanTitle(title));
    const wantArtist = normalize(cleanArtist(artist));

    let best = null;
    for (const r of results) {
        if (!r || (!r.syncedLyrics && !r.plainLyrics && !r.instrumental))
            continue;

        const gotTitle = normalize(r.trackName);
        let score = 0;
        if (gotTitle === wantTitle)
            score += 4;
        else if (wantTitle && gotTitle && (gotTitle.includes(wantTitle) || wantTitle.includes(gotTitle)))
            score += 2;
        else
            continue; // título diferente: é outra música

        const gotArtist = normalize(r.artistName);
        if (wantArtist && (gotArtist.includes(wantArtist) || wantArtist.includes(gotArtist)))
            score += 2;

        let durationMatch = true;
        if (durationS > 0 && r.duration > 0) {
            const diff = Math.abs(r.duration - durationS);
            durationMatch = diff <= 3;
            score += durationMatch ? 3 - diff : -Math.min(diff, 60) / 20;
        }
        if (r.syncedLyrics)
            score += 1.5;
        // Versão com a duração certa sempre ganha de uma com duração errada.
        if (durationMatch)
            score += 10;

        if (!best || score > best.score)
            best = {record: r, durationMatch, score};
    }
    return best && {record: best.record, durationMatch: best.durationMatch};
}

/**
 * Converte uma resposta do LRCLIB no formato usado pela interface
 * (allowSynced = false força a versão sem sincronia):
 *   {kind: 'synced', lines} | {kind: 'plain', text} | {kind: 'instrumental'} | null
 */
export function toLyrics(record, {allowSynced = true} = {}) {
    if (!record)
        return null;
    if (record.syncedLyrics && allowSynced) {
        const lines = parseLrc(record.syncedLyrics);
        if (lines.length > 0)
            return {kind: 'synced', lines};
    }
    if (record.plainLyrics?.trim())
        return {kind: 'plain', text: record.plainLyrics.trim()};
    if (record.syncedLyrics) {
        // Sem plainLyrics: tira os tempos da sincronizada.
        const text = parseLrc(record.syncedLyrics).map(l => l.text).join('\n').trim();
        if (text)
            return {kind: 'plain', text};
    }
    if (record.instrumental)
        return {kind: 'instrumental'};
    return null;
}
