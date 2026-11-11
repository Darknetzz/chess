// PGN / JSON conversion for game records (see store.js for the record shape).
import { Chess, DEFAULT_POSITION } from 'https://cdn.jsdelivr.net/npm/chess.js@1.4.0/dist/esm/chess.js';

export const toUci = (m) => m.from + m.to + (m.promotion || '');
export const fromUci = (u) => ({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || undefined });

const pgnDate = (sec) => {
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
};

/** Replay a record's moves; throws on an illegal move. Returns the chess.js instance. */
export function replay(rec, upto = Infinity) {
  const g = new Chess(rec.startFen || DEFAULT_POSITION);
  rec.moves.slice(0, upto).forEach((u) => g.move(fromUci(u)));
  return g;
}

export function recordToPgn(rec) {
  const g = replay(rec);
  g.setHeader('Event', rec.title || (rec.mode === 'bot' ? 'Game vs bot' : rec.mode === 'import' ? 'Imported game' : 'Casual game'));
  g.setHeader('Site', location.host || 'local');
  g.setHeader('Date', rec.createdAt ? pgnDate(rec.createdAt) : '????.??.??');
  g.setHeader('White', rec.white || '?');
  g.setHeader('Black', rec.black || '?');
  g.setHeader('Result', rec.result || '*');
  if (rec.termination) g.setHeader('Termination', rec.termination);
  return g.pgn();
}

/** Split a PGN file into single-game chunks. */
export function splitPgn(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/^﻿/, '')
    .split(/\n\s*\n(?=\s*\[)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseDate(d) {
  const m = /^(\d{4})\.(\d{2})\.(\d{2})$/.exec(d || '');
  if (!m) return undefined;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], 12) / 1000;
  return Number.isFinite(t) && t > 0 ? t : undefined;
}

/** Parse one PGN game into a record (without id). */
export function pgnToRecord(text) {
  const g = new Chess();
  g.loadPgn(text);
  const h = g.getHeaders();
  const verbose = g.history({ verbose: true });
  const startFen = verbose.length ? verbose[0].before : g.fen();
  let result = ['1-0', '0-1', '1/2-1/2'].includes(h.Result) ? h.Result : '*';
  if (result === '*') {
    if (g.isCheckmate()) result = g.turn() === 'w' ? '0-1' : '1-0';
    else if (g.isDraw()) result = '1/2-1/2';
  }
  const title = h.Event && !['?', 'Casual game', 'Game vs bot', 'Imported game'].includes(h.Event) ? h.Event : '';
  return {
    startFen,
    moves: verbose.map(toUci),
    result,
    termination: (h.Termination || '').slice(0, 64),
    mode: 'import',
    humanColor: 'w',
    botLevel: null,
    white: h.White && h.White !== '?' ? h.White.slice(0, 64) : '',
    black: h.Black && h.Black !== '?' ? h.Black.slice(0, 64) : '',
    title: title.slice(0, 128),
    createdAt: parseDate(h.Date),
  };
}

/** Parse a .pgn (one or many games) or a JSON backup. Returns { games, errors }. */
export function parseImport(text) {
  const trimmed = text.trim();
  const games = [];
  const errors = [];
  if (trimmed.startsWith('{') || /^\[\s*[{\]]/.test(trimmed)) {
    let data;
    try {
      data = JSON.parse(trimmed);
    } catch (e) {
      return { games, errors: [`Invalid JSON: ${e.message}`] };
    }
    const list = Array.isArray(data) ? data : data.games;
    if (!Array.isArray(list)) return { games, errors: ['JSON has no "games" array'] };
    list.forEach((r, i) => {
      try {
        const rec = {
          startFen: typeof r.startFen === 'string' ? r.startFen : DEFAULT_POSITION,
          moves: Array.isArray(r.moves) ? r.moves : String(r.moves || '').split(' ').filter(Boolean),
          result: ['1-0', '0-1', '1/2-1/2'].includes(r.result) ? r.result : '*',
          termination: String(r.termination || '').slice(0, 64),
          mode: ['free', 'bot', 'import'].includes(r.mode) ? r.mode : 'import',
          humanColor: r.humanColor === 'b' ? 'b' : 'w',
          botLevel: Number.isInteger(r.botLevel) ? r.botLevel : null,
          white: String(r.white || '').slice(0, 64),
          black: String(r.black || '').slice(0, 64),
          title: String(r.title || '').slice(0, 128),
          createdAt: Number.isInteger(r.createdAt) ? r.createdAt : undefined,
        };
        rec.startFen = new Chess(rec.startFen).fen(); // validates FEN
        replay(rec); // validates moves
        games.push(rec);
      } catch (e) {
        errors.push(`Game ${i + 1}: ${e.message || e}`);
      }
    });
    return { games, errors };
  }
  splitPgn(trimmed).forEach((chunk, i) => {
    try {
      games.push(pgnToRecord(chunk));
    } catch (e) {
      errors.push(`Game ${i + 1}: ${e.message || e}`);
    }
  });
  return { games, errors };
}

export function exportJson(records) {
  const games = records.map(({ id, updatedAt, ...r }) => r);
  return JSON.stringify({ format: 'chess-games', version: 1, exported: new Date().toISOString(), games }, null, 1);
}

export function download(text, filename, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export const today = () => new Date().toISOString().slice(0, 10);
