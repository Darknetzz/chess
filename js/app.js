/* global $ */
import { Chess, DEFAULT_POSITION } from 'https://cdn.jsdelivr.net/npm/chess.js@1.4.0/dist/esm/chess.js';
import { Board, pieceUrl } from './board.js';
import { Engine } from './engine.js';

const STORAGE_KEY = 'chess.state.v1';
const COORD_MODES = ['off', 'edge', 'all'];
const COORD_LABELS = { off: 'Coordinates: off', edge: 'Coordinates: edges', all: 'Coordinates: every tile' };
const VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const START_COUNT = { p: 8, n: 2, b: 2, r: 2, q: 1 };
const COLOR_NAME = { w: 'White', b: 'Black' };

const engine = new Engine(new URL('../vendor/stockfish/stockfish-19-lite-single.js', import.meta.url));

// ---- State -----------------------------------------------------------------
const state = {
  startFen: DEFAULT_POSITION,
  history: [], // [{ from, to, promotion, san }]
  ply: 0, // number of history moves applied to the shown position
  humanColor: 'w',
  settings: { mode: 'free', side: 'w', level: 5, orientation: 'w', coordMode: 'edge' },
};
let game = new Chess();
let thinking = false;
let thinkToken = 0;
let engineError = null;

const opposite = (c) => (c === 'w' ? 'b' : 'w');
const isBot = () => state.settings.mode === 'bot';
const startTurn = () => state.startFen.split(' ')[1];
const turnAt = (ply) => (ply % 2 === 0 ? startTurn() : opposite(startTurn()));

function rebuild() {
  game = new Chess(state.startFen);
  for (let i = 0; i < state.ply; i++) {
    const { from, to, promotion } = state.history[i];
    game.move({ from, to, promotion });
  }
}

// ---- Persistence -----------------------------------------------------------
function save() {
  try {
    const data = {
      startFen: state.startFen,
      history: state.history.map(({ from, to, promotion }) => ({ from, to, promotion })),
      ply: state.ply,
      humanColor: state.humanColor,
      settings: state.settings,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    /* storage unavailable: ignore */
  }
}

function restore() {
  let data;
  try {
    data = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  } catch {
    data = null;
  }
  if (!data) return;
  Object.assign(state.settings, data.settings || {});
  try {
    const g = new Chess(data.startFen || DEFAULT_POSITION);
    const history = [];
    for (const m of data.history || []) {
      const r = g.move({ from: m.from, to: m.to, promotion: m.promotion });
      history.push({ from: r.from, to: r.to, promotion: r.promotion, san: r.san });
    }
    state.startFen = data.startFen || DEFAULT_POSITION;
    state.history = history;
    state.ply = Math.max(0, Math.min(history.length, data.ply ?? history.length));
    state.humanColor = data.humanColor === 'b' ? 'b' : 'w';
  } catch {
    /* corrupt saved game: start fresh, keep settings */
  }
}

// ---- Board -----------------------------------------------------------------
const board = new Board($('#board'), {
  getMoves: (square) => game.moves({ square, verbose: true }),
  onMove: (from, to, promotion) => {
    if (playMove({ from, to, promotion })) maybeBotMove();
  },
});

function piecesMap() {
  const map = {};
  for (const row of game.board()) for (const p of row) if (p) map[p.square] = { type: p.type, color: p.color };
  return map;
}

function kingSquare(color) {
  for (const row of game.board()) for (const p of row) if (p && p.type === 'k' && p.color === color) return p.square;
  return null;
}

function movableColor() {
  if (game.isGameOver()) return null;
  if (!isBot()) return 'both';
  if (thinking) return null;
  return game.turn() === state.humanColor ? state.humanColor : null;
}

// ---- Moves -----------------------------------------------------------------
function playMove(move) {
  let res;
  try {
    res = game.move(move);
  } catch {
    return false;
  }
  state.history.length = state.ply; // drop redo line when branching
  state.history.push({ from: res.from, to: res.to, promotion: res.promotion, san: res.san });
  state.ply++;
  update();
  return true;
}

function cancelBot() {
  thinkToken++;
  if (thinking) {
    thinking = false;
    engine.cancel();
  }
}

function maybeBotMove() {
  if (!isBot() || game.isGameOver() || game.turn() === state.humanColor) return;
  if (state.ply !== state.history.length) return; // don't overwrite a redo line
  const token = ++thinkToken;
  const fen = game.fen();
  thinking = true;
  update();
  engine
    .bestMove(fen, state.settings.level)
    .then((uci) => {
      if (token !== thinkToken) return;
      thinking = false;
      if (!uci) return update();
      playMove({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    })
    .catch((err) => {
      if (token !== thinkToken) return;
      thinking = false;
      engineError = 'Engine failed to load' + (location.protocol === 'file:' ? ' (serve over http, not file://)' : '');
      console.error(err);
      update();
    });
}

function goTo(ply) {
  cancelBot();
  state.ply = Math.max(0, Math.min(state.history.length, ply));
  rebuild();
  update();
}

function undo() {
  if (state.ply === 0) return;
  let p = state.ply - 1;
  if (isBot()) while (p > 0 && turnAt(p) !== state.humanColor) p--;
  goTo(p);
}

function redo() {
  if (state.ply >= state.history.length) return;
  let p = state.ply + 1;
  if (isBot()) while (p < state.history.length && turnAt(p) !== state.humanColor) p++;
  goTo(p);
  maybeBotMove();
}

function resolveHumanColor() {
  const s = state.settings.side;
  state.humanColor = s === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : s;
  if (isBot()) state.settings.orientation = state.humanColor;
}

function newGame(fen = DEFAULT_POSITION, history = []) {
  cancelBot();
  state.startFen = fen;
  state.history = history;
  state.ply = history.length;
  resolveHumanColor();
  rebuild();
  engine.newGame().catch(() => {});
  update();
  maybeBotMove();
}

// ---- Rendering -------------------------------------------------------------
function statusText() {
  if (engineError) return engineError;
  const t = COLOR_NAME[game.turn()];
  let s;
  if (game.isCheckmate()) s = `Checkmate — ${COLOR_NAME[opposite(game.turn())]} wins`;
  else if (game.isStalemate()) s = 'Draw — stalemate';
  else if (game.isInsufficientMaterial()) s = 'Draw — insufficient material';
  else if (game.isThreefoldRepetition()) s = 'Draw — threefold repetition';
  else if (game.isDrawByFiftyMoves()) s = 'Draw — 50-move rule';
  else if (thinking) s = `Bot (${t}) is thinking…`;
  else s = `${t} to move${game.inCheck() ? ' — check!' : ''}`;
  if (state.ply < state.history.length) s += ` · viewing move ${state.ply}/${state.history.length}`;
  return s;
}

function renderMoves() {
  const fullmove = parseInt(state.startFen.split(' ')[5], 10) || 1;
  const blackFirst = startTurn() === 'b';
  const rows = [];
  state.history.forEach((m, i) => {
    const ply = i + 1;
    const isWhite = turnAt(i) === 'w';
    const num = fullmove + Math.floor((i + (blackFirst ? 1 : 0)) / 2);
    if (isWhite || i === 0) rows.push({ num, w: null, b: null });
    const row = rows[rows.length - 1];
    row[isWhite ? 'w' : 'b'] = { san: m.san, ply };
  });
  const cell = (m) =>
    m ? `<button type="button" class="mv${m.ply === state.ply ? ' cur' : ''}" data-ply="${m.ply}">${m.san}</button>` : '<span class="mv empty">…</span>';
  $('#moves').html(rows.map((r) => `<li><span class="num">${r.num}.</span>${cell(r.w)}${cell(r.b)}</li>`).join(''));
  const cur = $('#moves .cur')[0];
  if (cur) cur.scrollIntoView({ block: 'nearest' });
  else $('#moves').scrollTop(0);
}

function renderCaptured(pieces) {
  const count = { w: { p: 0, n: 0, b: 0, r: 0, q: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0 } };
  let material = 0;
  for (const p of Object.values(pieces)) {
    if (p.type !== 'k') count[p.color][p.type]++;
    material += (p.color === 'w' ? 1 : -1) * VALUES[p.type];
  }
  // captured[c] = pieces of colour c that are missing from the board
  const html = (c) =>
    ['q', 'r', 'b', 'n', 'p']
      .flatMap((t) => Array(Math.max(0, START_COUNT[t] - count[c][t])).fill(t))
      .map((t) => `<img src="${pieceUrl(c, t)}" alt="${t}">`)
      .join('');
  const top = state.settings.orientation === 'w' ? 'b' : 'w';
  const bottom = opposite(top);
  // Show next to each player the enemy pieces they captured, plus their material lead.
  const lead = (c) => {
    const d = c === 'w' ? material : -material;
    return d > 0 ? `<span class="lead">+${d}</span>` : '';
  };
  $('#captured-top').html(html(bottom) + lead(top));
  $('#captured-bottom').html(html(top) + lead(bottom));
}

function update() {
  const pieces = piecesMap();
  board.render({
    pieces,
    orientation: state.settings.orientation,
    coordMode: state.settings.coordMode,
    lastMove: state.ply > 0 ? state.history[state.ply - 1] : null,
    checkSquare: game.inCheck() ? kingSquare(game.turn()) : null,
    movable: movableColor(),
  });
  const over = game.isGameOver();
  $('#status').text(statusText()).toggleClass('over', over).toggleClass('thinking', thinking);
  renderMoves();
  renderCaptured(pieces);

  const s = state.settings;
  $('#mode').val(s.mode);
  $('#side').val(s.side);
  $('#level').val(s.level);
  $('#level-out').text(s.level);
  $('.bot-only').prop('hidden', s.mode !== 'bot');
  $('#coords').text(COORD_LABELS[s.coordMode]);
  $('#undo, #first').prop('disabled', state.ply === 0);
  $('#redo, #last').prop('disabled', state.ply >= state.history.length);
  save();
}

// ---- Import / export modal -------------------------------------------------
function buildPgn() {
  const g = new Chess(state.startFen);
  for (const { from, to, promotion } of state.history) g.move({ from, to, promotion });
  const d = new Date();
  const bot = `Stockfish (level ${state.settings.level})`;
  g.setHeader('Event', isBot() ? 'Game vs bot' : 'Casual game');
  g.setHeader('Site', location.host || 'local');
  g.setHeader('Date', `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`);
  g.setHeader('White', isBot() && state.humanColor === 'b' ? bot : 'Player');
  g.setHeader('Black', isBot() && state.humanColor === 'w' ? bot : 'Player');
  let result = '*';
  if (g.isCheckmate()) result = g.turn() === 'w' ? '0-1' : '1-0';
  else if (g.isDraw() || g.isStalemate()) result = '1/2-1/2';
  g.setHeader('Result', result);
  return g.pgn();
}

let modalKind = null;
function openModal(kind) {
  modalKind = kind;
  $('#modal-title').text(kind === 'fen' ? 'FEN' : 'PGN');
  $('#modal-text').val(kind === 'fen' ? game.fen() : buildPgn()).attr('rows', kind === 'fen' ? 3 : 12);
  $('#modal-error').text('');
  $('#modal-download').prop('hidden', kind !== 'pgn');
  $('#modal')[0].showModal();
  $('#modal-text').trigger('select');
}

function loadFromModal() {
  const text = String($('#modal-text').val()).trim();
  try {
    if (modalKind === 'fen') {
      const fen = new Chess(text).fen(); // throws on invalid FEN
      newGame(fen, []);
    } else {
      const g = new Chess();
      g.loadPgn(text);
      const verbose = g.history({ verbose: true });
      const startFen = verbose.length ? verbose[0].before : g.fen();
      newGame(
        startFen,
        verbose.map((m) => ({ from: m.from, to: m.to, promotion: m.promotion, san: m.san })),
      );
    }
    $('#modal')[0].close();
  } catch (err) {
    $('#modal-error').text(`Invalid ${modalKind.toUpperCase()}: ${err.message || err}`);
  }
}

// ---- Wiring ----------------------------------------------------------------
function flip() {
  state.settings.orientation = opposite(state.settings.orientation);
  update();
}

function cycleCoords() {
  const i = COORD_MODES.indexOf(state.settings.coordMode);
  state.settings.coordMode = COORD_MODES[(i + 1) % COORD_MODES.length];
  update();
}

$('#new').on('click', () => newGame());
$('#flip').on('click', flip);
$('#coords').on('click', cycleCoords);
$('#undo').on('click', undo);
$('#redo').on('click', redo);
$('#first').on('click', () => goTo(0));
$('#last').on('click', () => {
  goTo(state.history.length);
  maybeBotMove();
});
$('#moves').on('click', '.mv[data-ply]', (e) => goTo(Number(e.currentTarget.dataset.ply)));

$('#mode').on('change', (e) => {
  state.settings.mode = e.target.value;
  cancelBot();
  if (isBot()) resolveHumanColor();
  update();
  maybeBotMove();
});
$('#side').on('change', (e) => {
  state.settings.side = e.target.value;
  cancelBot();
  resolveHumanColor();
  update();
  maybeBotMove();
});
$('#level').on('input', (e) => {
  state.settings.level = Number(e.target.value);
  $('#level-out').text(state.settings.level);
  save();
});

$('#fen-btn').on('click', () => openModal('fen'));
$('#pgn-btn').on('click', () => openModal('pgn'));
$('#modal-load').on('click', loadFromModal);
$('#modal-close').on('click', () => $('#modal')[0].close());
$('#modal-copy').on('click', async () => {
  try {
    await navigator.clipboard.writeText(String($('#modal-text').val()));
    $('#modal-error').text('Copied.');
  } catch {
    $('#modal-text').trigger('select');
    $('#modal-error').text('Copy failed — press Ctrl+C.');
  }
});
$('#modal-download').on('click', () => {
  const blob = new Blob([String($('#modal-text').val())], { type: 'application/x-chess-pgn' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `chess-${new Date().toISOString().slice(0, 10)}.pgn`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$(document).on('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if ($(e.target).is('input, textarea, select') || $('#modal')[0].open) return;
  const k = e.key.toLowerCase();
  if (k === 'f') flip();
  else if (k === 'c') cycleCoords();
  else if (k === 'n') newGame();
  else if (e.key === 'ArrowLeft') undo();
  else if (e.key === 'ArrowRight') redo();
  else if (e.key === 'Home') goTo(0);
  else if (e.key === 'End') $('#last').trigger('click');
  else return;
  e.preventDefault();
});

// ---- Boot ------------------------------------------------------------------
restore();
rebuild();
update();
engine.init().catch((err) => {
  console.error(err);
  engineError = null; // only surfaced when the bot is actually needed
});
maybeBotMove();
