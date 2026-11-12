/* global $ */
import { Chess, DEFAULT_POSITION } from '../vendor/chess.js/chess.js';
import { Board, pieceUrl, setPieceSet } from './board.js';
import { Engine, Analyzer } from './engine.js';
import * as Settings from './settings.js';
import { play as playSound } from './sound.js';
import { api } from './api.js';
import { store } from './store.js';
import { recordToPgn, pgnToRecord, toUci, fromUci, download, today } from './pgn.js';
import { initSettingsUi } from './settings-ui.js';
import { initAccount } from './account.js';
import { initLibrary } from './library.js';
import { hydrateIcons, setButton } from './icons.js';
import { remoteFromUrl, botApi, netStore, gameLink } from './botgame.js';
import { premoveDests, applyPremoves } from './premove.js';

hydrateIcons();

const STATE_KEY = 'chess.state.v2';
const OLD_STATE_KEY = 'chess.state.v1';
const COORD_MODES = ['off', 'edge', 'all'];
const COORD_LABELS = { off: 'Coords: off', edge: 'Coords: edges', all: 'Coords: all' };
const VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const START_COUNT = { p: 8, n: 2, b: 2, r: 2, q: 1 };
const COLOR_NAME = { w: 'White', b: 'Black' };
const BOT_PAUSE_MS = 350; // minimum gap between the player's move landing and the bot's reply
const RESULT_TEXT = { '1-0': 'White wins', '0-1': 'Black wins', '1/2-1/2': 'Draw', '*': 'Unfinished' };

const STOCKFISH_URL = new URL('../vendor/stockfish/stockfish-19-lite-single.js', import.meta.url);
const engine = new Engine(STOCKFISH_URL);
const analyzer = new Analyzer(STOCKFISH_URL);

// ---- State -----------------------------------------------------------------
const state = {
  startFen: DEFAULT_POSITION,
  history: [], // [{ from, to, promotion, san }]
  ply: 0, // number of history moves applied to the shown position
  humanColor: 'w',
  resigned: null, // colour that resigned the live game
  gameId: null, // id in the store (number = account, string = local)
  createdAt: null,
  gameToken: 0, // bumps whenever a different game becomes live
  assisted: false, // Stockfish analysis was shown during the live game
  settings: Settings.loadLocal(),
  replay: null, // { rec, live: snapshot of the live game }
};
let game = new Chess();
let thinking = false;
let thinkToken = 0;
let engineError = null;
let saveError = null;
let pendingAnim = null;
let autoplayTimer = null;
let premoves = []; // online games: moves queued during the opponent's turn [{ from, to, promotion }]
let pendingMove = null; // online games with "confirm moves": played on the board, not sent yet { from, to, promotion, san }
// Server-refereed bot API game (?game=<id>[#token=<t>]). Every live game except the local analysis board is one.
// { id, token, engineToken, engineLevel, invite, botToken, saved, side, server, busy, engineBusy, error }
const joinedByLink = /token=/.test(location.hash + location.search); // opened an invite (play-as) link
const remote = remoteFromUrl();
if (remote) Object.assign(remote, { side: null, server: null, busy: false, engineBusy: false, error: null });

const opposite = (c) => (c === 'w' ? 'b' : 'w');
const isBot = () => state.settings.mode === 'bot' && !state.replay && !remote;
const startTurn = () => state.startFen.split(' ')[1];
const turnAt = (ply) => (ply % 2 === 0 ? startTurn() : opposite(startTurn()));
const atEnd = () => state.ply === state.history.length;
const nowSec = () => Math.floor(Date.now() / 1000);

function rebuild() {
  game = new Chess(state.startFen);
  for (let i = 0; i < state.ply; i++) {
    const { from, to, promotion } = state.history[i];
    game.move({ from, to, promotion });
  }
}

/** Outcome of a chess.js position (+ resignation) as { result, termination }. */
function outcomeOf(g, resigned) {
  if (resigned) return { result: resigned === 'w' ? '0-1' : '1-0', termination: `${COLOR_NAME[resigned]} resigned` };
  if (g.isCheckmate()) return { result: g.turn() === 'w' ? '0-1' : '1-0', termination: 'Checkmate' };
  if (g.isStalemate()) return { result: '1/2-1/2', termination: 'Stalemate' };
  if (g.isInsufficientMaterial()) return { result: '1/2-1/2', termination: 'Insufficient material' };
  if (g.isThreefoldRepetition()) return { result: '1/2-1/2', termination: 'Threefold repetition' };
  if (g.isDrawByFiftyMoves()) return { result: '1/2-1/2', termination: '50-move rule' };
  return { result: '*', termination: '' };
}

const isOver = () => (remote ? remote.server?.status !== 'ongoing' : game.isGameOver() || (!!state.resigned && atEnd()));

// ---- Persistence of the live game -------------------------------------------
function liveSnapshot() {
  const { startFen, history, ply, humanColor, resigned, gameId, createdAt, gameToken, assisted } = state;
  return { startFen, history, ply, humanColor, resigned, gameId, createdAt, gameToken, assisted };
}

function persist() {
  if (remote) return;
  try {
    const s = state.replay ? state.replay.live : liveSnapshot();
    const data = { ...s, history: s.history.map(({ from, to, promotion }) => ({ from, to, promotion })) };
    delete data.gameToken;
    localStorage.setItem(STATE_KEY, JSON.stringify(data));
  } catch {
    /* storage unavailable: ignore */
  }
}

function restore() {
  let data;
  try {
    data = JSON.parse(localStorage.getItem(STATE_KEY) || localStorage.getItem(OLD_STATE_KEY) || 'null');
  } catch {
    data = null;
  }
  if (!data) return;
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
    state.resigned = ['w', 'b'].includes(data.resigned) ? data.resigned : null;
    state.gameId = typeof data.gameId === 'number' || typeof data.gameId === 'string' ? data.gameId : null;
    state.createdAt = Number.isInteger(data.createdAt) ? data.createdAt : null;
    state.assisted = data.assisted === true;
  } catch {
    /* corrupt saved game: start fresh */
  }
}

// ---- Saved games (autosave to account or local list) --------------------------
let saveTimer = null;
let savedSig = null;
let saveChain = Promise.resolve();
const idsByToken = new Map();

function playerNames() {
  if (remote) {
    const n = (c) => remote.server?.players?.[c === 'w' ? 'white' : 'black']?.name || COLOR_NAME[c];
    return { white: n('w'), black: n('b') };
  }
  const me = api.user?.username || 'Player';
  if (state.settings.mode !== 'bot') return { white: me, black: me };
  const bot = `Stockfish (level ${state.settings.level})`;
  return state.humanColor === 'w' ? { white: me, black: bot } : { white: bot, black: me };
}

function liveRecord() {
  const g = atEnd() ? game : (() => {
    const c = new Chess(state.startFen);
    state.history.forEach(({ from, to, promotion }) => c.move({ from, to, promotion }));
    return c;
  })();
  const { result, termination } = outcomeOf(g, state.resigned);
  return {
    id: state.gameId,
    createdAt: state.createdAt || nowSec(),
    startFen: state.startFen,
    moves: state.history.map(toUci),
    result,
    termination,
    mode: state.settings.mode,
    humanColor: state.humanColor,
    botLevel: state.settings.mode === 'bot' ? state.settings.level : null,
    ...playerNames(),
    title: '',
    assisted: state.assisted,
  };
}

const saveSig = () => `${state.gameToken}|${state.history.map(toUci).join(' ')}|${state.resigned || ''}|${state.settings.mode}|${state.humanColor}|${state.assisted}`;

let storeReady = false; // set once we know whether saves go to the account or this browser

function scheduleSave() {
  if (!storeReady || remote || state.replay || !state.history.length) return;
  if (saveSig() === savedSig) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 600);
}

/** Save the live game now (if it changed); resolves when all queued saves are done. */
function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (storeReady && !remote && !state.replay && state.history.length && saveSig() !== savedSig) {
    const sig = saveSig();
    const rec = liveRecord();
    const token = state.gameToken;
    if (!state.createdAt) state.createdAt = rec.createdAt;
    savedSig = sig;
    saveChain = saveChain.then(async () => {
      rec.id = rec.id ?? idsByToken.get(token) ?? null;
      // An id from the other store (local vs account) can't be updated there: create instead.
      if (rec.id !== null && (typeof rec.id === 'number') !== store.remote()) rec.id = null;
      try {
        const saved = await store.save(rec);
        idsByToken.set(token, saved.id);
        if (token === state.gameToken && !state.replay) state.gameId = saved.id;
        else if (state.replay?.live.gameToken === token) state.replay.live.gameId = saved.id;
        saveError = null;
        persist();
      } catch (err) {
        console.error(err);
        if (savedSig === sig) savedSig = null;
        saveError = `Not saved: ${err.message || err}`;
      }
      renderStatus();
    });
  }
  return saveChain;
}

function startNewIdentity(id = null, createdAt = null) {
  state.gameToken++;
  state.gameId = id;
  state.createdAt = createdAt;
  savedSig = null;
}

// ---- Board -----------------------------------------------------------------
const board = new Board($('#board'), {
  getMoves: (square) => (premoveMode() ? premoveDests(displayPieces(), square) : game.moves({ square, verbose: true })),
  onMove: (from, to, promotion, dragged) => {
    if (remote && premoveMode()) return addPremove({ from, to, promotion });
    if (remote) return remoteMove({ from, to, promotion }, !dragged);
    if (playMove({ from, to, promotion }, !dragged)) maybeBotMove();
  },
  onRightClick: () => clearPremoves(),
});

function piecesMap(g = game) {
  const map = {};
  for (const row of g.board()) for (const p of row) if (p) map[p.square] = { type: p.type, color: p.color };
  return map;
}

/** What the board shows: the position plus a move awaiting confirmation plus queued premoves. */
function displayPieces() {
  let pieces = piecesMap();
  if (pendingMove) {
    const g = new Chess(game.fen());
    g.move(pendingMove);
    pieces = piecesMap(g);
  }
  return premoves.length ? applyPremoves(pieces, premoves) : pieces;
}

// ---- Premoves & move confirmation (online games) ---------------------------------
/** Playing an online game that is going on, at the latest position, whose host allowed premoves. */
const canPremove = () => !!remote?.side && remote.server?.premoves !== false && remote.server?.status === 'ongoing' && atEnd();
/** The board takes premoves now: it's the opponent's turn or our move is still on its way to the server. */
const premoveMode = () => canPremove() && !pendingMove && (remote.busy || game.turn() !== remote.side);

function addPremove(m) {
  premoves.push(m);
  update();
}

function clearPremoves() {
  if (!premoves.length) return;
  premoves = [];
  update();
}

/** Play the first queued premove if it's our turn; drop the whole queue if it isn't legal (or can't be played). */
function runPremove() {
  if (!premoves.length) return;
  if (!canPremove()) return clearPremoves();
  if (remote.busy || pendingMove || game.turn() !== remote.side) return;
  const m = premoves.shift();
  const legal = game.moves({ verbose: true }).some((x) => x.from === m.from && x.to === m.to && (x.promotion || null) === (m.promotion || null));
  if (!legal) return clearPremoves();
  remoteMove(m, true, true);
}

function confirmPending() {
  if (!pendingMove) return;
  const m = pendingMove;
  pendingMove = null;
  remoteMove(m, false, true);
}

function cancelPending() {
  if (!pendingMove) return;
  pendingMove = null;
  update();
}

function kingSquare(color) {
  for (const row of game.board()) for (const p of row) if (p && p.type === 'k' && p.color === color) return p.square;
  return null;
}

function movableColor() {
  if (remote) {
    if (premoveMode()) return remote.side;
    return remote.side && !remote.busy && !pendingMove && !isOver() && atEnd() && game.turn() === remote.side ? remote.side : null;
  }
  if (state.replay || isOver()) return null;
  if (!isBot()) return 'both';
  if (thinking) return null;
  return game.turn() === state.humanColor ? state.humanColor : null;
}

// ---- Moves -----------------------------------------------------------------
function moveSound(res) {
  if (!state.settings.sound) return;
  const kind = game.isGameOver() ? 'end' : game.inCheck() ? 'check' : res.captured ? 'capture' : 'move';
  playSound(kind, state.settings.volume);
}

function animFor(m) {
  const ms = Settings.ANIMATION_MS[state.settings.animation];
  return ms ? { from: m.from, to: m.to, ms } : null;
}

function playMove(move, animate = true) {
  let res;
  try {
    res = game.move(move);
  } catch {
    return false;
  }
  state.resigned = null;
  state.history.length = state.ply; // drop redo line when branching
  state.history.push({ from: res.from, to: res.to, promotion: res.promotion, san: res.san });
  state.ply++;
  if (animate) pendingAnim = animFor(res);
  moveSound(res);
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
  if (!isBot() || isOver() || game.turn() === state.humanColor) return;
  if (!atEnd()) return; // don't overwrite a redo line
  const token = ++thinkToken;
  const fen = game.fen();
  // Let the player's own slide finish and pause briefly so the reply is visible.
  const minDelay = Settings.ANIMATION_MS[state.settings.animation] + BOT_PAUSE_MS;
  const started = performance.now();
  thinking = true;
  // Don't re-render the board here: that would cut the player's move animation short.
  board.setMovable(movableColor());
  renderStatus();
  engine
    .bestMove(fen, state.settings.level)
    .then(async (uci) => {
      const wait = minDelay - (performance.now() - started);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (token !== thinkToken) return;
      thinking = false;
      if (!uci) return update();
      playMove(fromUci(uci));
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
  premoves = [];
  pendingMove = null;
  const target = Math.max(0, Math.min(state.history.length, ply));
  if (target === state.ply + 1) {
    pendingAnim = animFor(state.history[state.ply]);
    state.ply = target;
    rebuild();
    if (state.replay && state.settings.sound) {
      const last = game.history({ verbose: true }).at(-1);
      if (last) moveSound(last);
    }
  } else {
    state.ply = target;
    rebuild();
  }
  update();
}

function undo() {
  if (state.ply === 0) return;
  let p = state.ply - 1;
  if (isBot()) while (p > 0 && turnAt(p) !== state.humanColor) p--;
  if (!state.replay) state.resigned = null;
  goTo(p);
}

function redo() {
  if (atEnd()) return;
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

const inProgress = () => state.history.length > 0 && !isOver() && !state.replay;
const confirmIf = (cond, text) => !cond || !state.settings.confirmActions || confirm(text);

function newGame(fen = DEFAULT_POSITION, history = []) {
  if (state.replay) exitReplay(false);
  flushSave();
  cancelBot();
  startNewIdentity();
  state.startFen = fen;
  state.history = history;
  state.ply = history.length;
  state.resigned = null;
  state.assisted = false;
  resolveHumanColor();
  rebuild();
  engine.newGame().catch(() => {});
  update();
  maybeBotMove();
}

function resign() {
  if (remote) return remoteResign();
  if (!inProgress()) return;
  cancelBot();
  if (!atEnd()) goTo(state.history.length);
  const who = isBot() ? state.humanColor : game.turn();
  if (!confirmIf(true, `Resign as ${COLOR_NAME[who]}?`)) return maybeBotMove();
  state.resigned = who;
  if (state.settings.sound) playSound('end', state.settings.volume);
  update();
}

// ---- Replay ------------------------------------------------------------------
function enterReplay(rec) {
  stopAutoplay();
  cancelBot();
  flushSave();
  let history;
  try {
    const g = new Chess(rec.startFen);
    history = rec.moves.map((u) => {
      const r = g.move(fromUci(u));
      return { from: r.from, to: r.to, promotion: r.promotion, san: r.san };
    });
  } catch (err) {
    alert(`This game can't be replayed: ${err.message || err}`);
    return;
  }
  const live = state.replay ? state.replay.live : liveSnapshot();
  state.replay = { rec, live, orientation: state.settings.orientation };
  state.startFen = rec.startFen;
  state.history = history;
  state.ply = 0;
  state.resigned = null;
  if (rec.mode === 'bot') state.settings.orientation = rec.humanColor;
  rebuild();
  update();
}

function exitReplay(render = true) {
  if (!state.replay) return;
  stopAutoplay();
  const { live, orientation } = state.replay;
  state.replay = null;
  Object.assign(state, live);
  state.settings.orientation = orientation;
  rebuild();
  if (render) {
    update();
    maybeBotMove();
  }
}

function continueFromHere() {
  if (!state.replay) return;
  stopAutoplay();
  const { rec } = state.replay;
  const resume = rec.result === '*' && atEnd() && rec.id != null && (typeof rec.id === 'number') === store.remote();
  state.replay = null;
  state.history = state.history.slice(0, state.ply);
  state.resigned = null;
  state.assisted = !!rec.assisted;
  if (resume) {
    startNewIdentity(rec.id, rec.createdAt);
    if (rec.mode === 'bot') Object.assign(state.settings, { mode: 'bot', side: rec.humanColor, level: rec.botLevel ?? state.settings.level });
  } else {
    startNewIdentity();
  }
  resolveHumanColor();
  rebuild();
  engine.newGame().catch(() => {});
  saveSettings();
  update();
  maybeBotMove();
}

function stopAutoplay() {
  clearTimeout(autoplayTimer);
  autoplayTimer = null;
  setButton($('#autoplay'), 'play', 'Play');
}

function toggleAutoplay() {
  if (!state.replay) return;
  if (autoplayTimer) return stopAutoplay();
  if (atEnd()) goTo(0);
  setButton($('#autoplay'), 'pause', 'Pause');
  const step = () => {
    if (!state.replay || atEnd()) return stopAutoplay();
    goTo(state.ply + 1);
    autoplayTimer = setTimeout(step, state.settings.autoplaySpeed * 1000);
  };
  autoplayTimer = setTimeout(step, 300);
}

// ---- Rendering -------------------------------------------------------------
function statusText() {
  if (engineError) return engineError;
  if (remote) return remoteStatus();
  let s;
  if (state.replay) {
    const r = state.replay.rec;
    s = `Replay · ${RESULT_TEXT[r.result] || r.result}${r.termination ? ` (${r.termination})` : ''} · move ${state.ply}/${state.history.length}`;
    return s;
  }
  const t = COLOR_NAME[game.turn()];
  if (state.resigned && atEnd()) s = `${COLOR_NAME[state.resigned]} resigned — ${COLOR_NAME[opposite(state.resigned)]} wins`;
  else if (game.isCheckmate()) s = `Checkmate — ${COLOR_NAME[opposite(game.turn())]} wins`;
  else if (game.isStalemate()) s = 'Draw — stalemate';
  else if (game.isInsufficientMaterial()) s = 'Draw — insufficient material';
  else if (game.isThreefoldRepetition()) s = 'Draw — threefold repetition';
  else if (game.isDrawByFiftyMoves()) s = 'Draw — 50-move rule';
  else if (thinking) s = `Bot (${t}) is thinking…`;
  else s = `${t} to move${game.inCheck() ? ' — check!' : ''}`;
  if (!atEnd()) s += ` · viewing move ${state.ply}/${state.history.length}`;
  if (state.assisted) s += ' · assisted';
  if (saveError) s += ` · ${saveError}`;
  return s;
}

function renderStatus() {
  const text = statusText();
  if ($('#status').text() !== text) $('#status').text(text); // unchanged text: don't re-announce (aria-live)
  $('#status').toggleClass('over', isOver() && !state.replay).toggleClass('thinking', thinking);
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
  // Scroll only the list itself: scrollIntoView would also scroll the page when the panel is below the board.
  const list = $('#moves')[0];
  if (!cur) list.scrollTop = 0;
  else {
    const top = cur.getBoundingClientRect().top - list.getBoundingClientRect().top - list.clientTop + list.scrollTop;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + cur.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + cur.offsetHeight - list.clientHeight;
  }
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
      .map((t) => `<img class="cap-${c}" src="${pieceUrl(c, t)}" alt="${t}">`)
      .join('');
  const top = state.settings.orientation === 'w' ? 'b' : 'w';
  const bottom = opposite(top);
  // Show next to each player the enemy pieces they captured, plus their material lead.
  const lead = (c) => {
    const d = c === 'w' ? material : -material;
    return d > 0 ? `<span class="lead">+${d}</span>` : '';
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
  const name = (c) => {
    const r = state.replay?.rec;
    const n = r ? (c === 'w' ? r.white : r.black) : playerNames()[c === 'w' ? 'white' : 'black'];
    return n ? `<span class="player">${esc(n)}</span>` : '';
  };
  $('#captured-top').html(name(top) + html(bottom) + lead(top));
  $('#captured-bottom').html(name(bottom) + html(top) + lead(bottom));
}

function update() {
  const s = state.settings;
  const pieces = piecesMap();
  board.render({
    pieces: remote ? displayPieces() : pieces,
    premoves,
    orientation: s.orientation,
    coordMode: s.coordMode,
    lastMove: !s.showLastMove ? null : pendingMove || (state.ply > 0 ? state.history[state.ply - 1] : null),
    checkSquare: s.showCheck && game.inCheck() ? kingSquare(game.turn()) : null,
    movable: movableColor(),
    autoQueen: s.autoQueen,
    animate: pendingAnim,
  });
  pendingAnim = null;
  renderStatus();
  renderMoves();
  renderCaptured(pieces);

  const replay = !!state.replay;
  $('.live-only').prop('hidden', replay);
  $('#replay-bar').prop('hidden', !replay);
  if (replay) {
    const r = state.replay.rec;
    $('#replay-title').text(`${r.white || '?'} vs ${r.black || '?'}${r.title ? ` — ${r.title}` : ''}`);
    const sp = String(s.autoplaySpeed);
    if (!$(`#autoplay-speed option[value="${sp}"]`).length) $('#autoplay-speed').append(`<option value="${sp}">${sp} s</option>`);
    $('#autoplay-speed').val(sp);
    setButton($('#replay-continue'), null, r.result === '*' && atEnd() ? 'Resume game' : 'Continue from here');
  }
  $('#resign').prop('disabled', remote ? !remote.side || isOver() : !inProgress());
  $('#analysis-btn').prop('disabled', netPlaying());
  $('#modal-load').prop('hidden', !!remote);
  $('#confirm-bar').prop('hidden', !pendingMove);
  renderNet();
  setButton($('#coords'), null, COORD_LABELS[s.coordMode]);
  $('#undo, #first').prop('disabled', state.ply === 0);
  $('#redo, #last').prop('disabled', atEnd());
  refreshAnalysis();
  persist();
  scheduleSave();
}

// ---- Analysis ----------------------------------------------------------------
let analysisKey = null; // position currently analysed (null = analyzer idle)
let lastEval = { info: null, result: null, fen: null };

function refreshAnalysis() {
  const on = state.settings.analysis && !netPlaying(); // no engine help while playing an online game
  $('#analysis-btn').attr('aria-pressed', String(on));
  $('#eval-bar, #analysis-info').prop('hidden', !on);
  if (!on) {
    if (analysisKey !== null) analyzer.terminate();
    analysisKey = null;
    board.setArrows([]);
    return;
  }
  const over = isOver();
  if (!state.replay && !over && !state.assisted) {
    state.assisted = true; // saved with the game (saveSig includes it)
    renderStatus();
  }
  const fen = game.fen();
  const key = `${fen}|${over}`;
  if (key !== analysisKey) {
    analysisKey = key;
    board.setArrows([]);
    if (over) {
      analyzer.stop();
      lastEval = { info: null, result: outcomeOf(game, atEnd() ? state.resigned : null).result, fen };
    } else {
      lastEval = { info: null, result: null, fen };
      analyzer
        .analyze(fen, (info) => {
          if (analysisKey !== key) return;
          lastEval = { info, result: null, fen };
          board.setArrows([fromUci(info.best)]);
          renderEval();
        })
        .catch((err) => {
          console.error(err);
          if (analysisKey === key) $('#analysis-info').text('Analysis unavailable (engine failed to load)');
        });
    }
  }
  renderEval();
}

const fmtEval = ({ cp, mate }) =>
  mate !== null ? `#${mate < 0 ? '−' : ''}${Math.abs(mate)}` : `${cp < 0 ? '−' : '+'}${(Math.abs(cp) / 100).toFixed(1)}`;

function renderEval() {
  const { info, result, fen } = lastEval;
  const flipped = state.settings.orientation === 'b';
  let pct = 50;
  let text = '';
  let line;
  if (result) {
    pct = result === '1-0' ? 100 : result === '0-1' ? 0 : 50;
    text = result === '1/2-1/2' ? '½' : result;
    line = `Game over · ${RESULT_TEXT[result] || result}`;
  } else if (!info) {
    line = 'Analysing…';
  } else {
    pct = info.mate !== null ? (info.mate > 0 ? 100 : 0) : 50 + 50 * Math.tanh(info.cp / 400);
    text = fmtEval(info);
    let san = info.best;
    try {
      san = new Chess(fen).move(fromUci(info.best)).san;
    } catch {
      /* keep UCI */
    }
    line = `${text} · depth ${info.depth} · best ${san}`;
  }
  $('#eval-bar').toggleClass('flipped', flipped).find('.eval-fill').css('height', `${pct}%`);
  const whiteAhead = pct >= 50;
  const atBottom = whiteAhead !== flipped; // the leader's end of the bar
  $('#eval-text').text(text).toggleClass('bottom', atBottom).toggleClass('top', !atBottom)
    .toggleClass('on-light', whiteAhead).toggleClass('on-dark', !whiteAhead);
  $('#analysis-info').text(line);
}

// ---- Settings ----------------------------------------------------------------
let settingsTimer = null;
function saveSettings() {
  Settings.saveLocal(state.settings);
  if (!api.user) return;
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => {
    api.saveSettings(state.settings).catch((err) => {
      console.error(err);
      settingsUi.message(`Settings not synced: ${err.message || err}`);
    });
  }, 500);
}

const gameBits = () => Object.fromEntries(Settings.GAME_KEYS.map((k) => [k, state.settings[k]]));

function applySettings() {
  Settings.apply(state.settings);
  setPieceSet(state.settings.pieceSet);
}

function changeSettings(patch) {
  const before = state.settings;
  state.settings = Settings.sanitize({ ...before, ...patch });
  applySettings();
  saveSettings();
  update();
}

const settingsUi = initSettingsUi({ get: () => state.settings, onChange: changeSettings });

// ---- Account & library ---------------------------------------------------------
const account = initAccount({
  async onLogin(user) {
    await flushSave(); // finish guest saves into the local list first
    const server = Settings.sanitize(user.settings);
    if (user.settings && Object.keys(user.settings).length) {
      // Keep the game-mode bits of the session in progress.
      state.settings = { ...server, ...gameBits() };
    }
    applySettings();
    saveSettings();

    const local = store.localGames();
    let mapped = null;
    if (local.length && confirm(`Upload ${local.length} game(s) saved in this browser to your account?`)) {
      try {
        const ids = await store.importMany(local);
        store.clearLocal();
        const i = local.findIndex((g) => g.id === state.gameId);
        if (i >= 0) mapped = ids[i];
      } catch (err) {
        alert(`Upload failed: ${err.message || err}`);
      }
    }
    state.gameId = mapped;
    idsByToken.delete(state.gameToken);
    if (state.replay) state.replay.live.gameId = null;
    savedSig = mapped ? saveSig() : null;
    update();
  },
  beforeLogout: () => flushSave(),
  onLogout() {
    state.gameId = null;
    idsByToken.delete(state.gameToken);
    savedSig = null;
    if (state.replay) exitReplay(false);
    update();
  },
});

const library = initLibrary({
  onReplay: enterReplay,
  onDeleted(id) {
    if (id === state.gameId) {
      state.gameId = null;
      idsByToken.delete(state.gameToken);
      savedSig = null;
    }
    if (state.replay?.live.gameId === id) state.replay.live.gameId = null;
  },
  currentId: () => (state.replay ? state.replay.live.gameId : state.gameId),
  beforeOpen: () => flushSave(),
});

// ---- Import / export modal (current game) ----------------------------------------
function currentPgn() {
  return recordToPgn(state.replay ? state.replay.rec : liveRecord());
}

let modalKind = null;
function openModal(kind) {
  modalKind = kind;
  $('#modal-title').text(kind === 'fen' ? 'FEN' : 'PGN');
  $('#modal-text').val(kind === 'fen' ? game.fen() : currentPgn()).attr('rows', kind === 'fen' ? 3 : 12);
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
      const rec = pgnToRecord(text);
      const g = new Chess(rec.startFen);
      newGame(
        rec.startFen,
        rec.moves.map((u) => {
          const r = g.move(fromUci(u));
          return { from: r.from, to: r.to, promotion: r.promotion, san: r.san };
        }),
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
  saveSettings();
  update();
}

function cycleCoords() {
  const i = COORD_MODES.indexOf(state.settings.coordMode);
  changeSettings({ coordMode: COORD_MODES[(i + 1) % COORD_MODES.length] });
}

function toggleAnalysis() {
  changeSettings({ analysis: !state.settings.analysis });
}

function askNewGame() {
  if (state.replay) return;
  $('#ng-error').text('');
  $('#ng-side').val(state.settings.side);
  $('#ng-level').val(state.settings.level);
  $('#ng-level-out').text(state.settings.level);
  $('#ng-tc').val(state.settings.timeControl);
  $('#ng-clock-min').val(state.settings.clockMinutes);
  $('#ng-clock-inc').val(state.settings.clockIncrement);
  $('#ng-time').val(String(state.settings.moveTimeMs));
  $('#ng-premoves').prop('checked', state.settings.premoves);
  syncNewGameForm();
  $('#newgame-modal')[0].showModal();
}

function syncNewGameForm() {
  const opp = ngOpponent();
  $('#newgame-form .ng-online').prop('hidden', opp === 'analysis');
  $('#newgame-form .ng-stockfish').prop('hidden', opp !== 'stockfish');
  const tc = String($('#ng-tc').val());
  const online = opp !== 'analysis';
  $('#newgame-form .ng-custom').prop('hidden', !online || tc !== 'custom');
  $('#ng-clock-min, #ng-clock-inc').prop('disabled', !online || tc !== 'custom');
  $('#newgame-form .ng-move').prop('hidden', !online || tc !== 'move');
  $('#newgame-form .ng-clock-note').prop('hidden', !online || tc === 'move');
}

/** Time control chosen in the dialog as API create options ({clock} or {move_time_ms}). */
function dialogTimeControl() {
  const tc = String($('#ng-tc').val());
  if (tc === 'move') return { patch: { timeControl: tc, moveTimeMs: Number($('#ng-time').val()) }, opts: { move_time_ms: Number($('#ng-time').val()) } };
  const [min, inc] = tc === 'custom' ? [Number($('#ng-clock-min').val()), Number($('#ng-clock-inc').val())] : Settings.CLOCK_PRESETS[tc];
  const patch = { timeControl: tc, ...(tc === 'custom' ? { clockMinutes: min, clockIncrement: inc } : {}) };
  return { patch, opts: { clock: { initial_ms: Math.round(min * 60000), increment_ms: Math.round(inc * 1000) } } };
}

/** Start the chosen game: online ones are created on the server, then the page opens them by URL. */
async function startFromDialog() {
  const opp = ngOpponent();
  const sideSel = String($('#ng-side').val());
  const level = Number($('#ng-level').val());
  const tc = dialogTimeControl();
  const allowPremoves = $('#ng-premoves').prop('checked');
  changeSettings({ side: sideSel, level, ...(opp === 'analysis' ? {} : { ...tc.patch, premoves: allowPremoves }) });
  if (opp === 'analysis') {
    $('#newgame-modal')[0].close();
    if (remote) return location.assign(`${location.pathname}#analysis`);
    if (!confirmIf(inProgress(), 'Abandon the current game and start a new one? (It stays in My games.)')) return;
    changeSettings({ mode: 'free' });
    return newGame();
  }
  const me = sideSel === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : sideSel;
  const [mine, theirs] = me === 'w' ? ['white', 'black'] : ['black', 'white'];
  const theirName = { human: '', stockfish: `Stockfish (level ${level})`, bot: 'Bot' }[opp];
  $('#ng-start').prop('disabled', true);
  if (opp === 'human') await fairPlayOnce();
  $('#ng-error').text('Creating game…');
  try {
    const g = await botApi.create({
      ...tc.opts,
      premoves: allowPremoves,
      [mine]: { name: api.user?.username || '' },
      [theirs]: { name: theirName },
    });
    const other = g[`${theirs}_token`];
    netStore.set(g.game_id, {
      token: g[`${mine}_token`],
      engineToken: opp === 'stockfish' ? other : null,
      engineLevel: opp === 'stockfish' ? level : null,
      invite: opp === 'human' ? other : null,
      botToken: opp === 'bot' ? other : null,
    });
    flushSave();
    location.assign(`${location.pathname}?game=${g.game_id}`);
  } catch (err) {
    $('#ng-error').text(err.code === 'rate_limited' ? err.message : `Could not create the game: ${err.message}`);
    $('#ng-start').prop('disabled', false);
  }
}

$('#ng-opponent, #ng-tc').on('change', syncNewGameForm);
function ngOpponent() {
  return $('#ng-opponent input:checked').val();
}
$('#ng-level').on('input', (e) => $('#ng-level-out').text(e.target.value));
$('#ng-cancel').on('click', () => $('#newgame-modal')[0].close());
$('#newgame-form').on('submit', (e) => {
  e.preventDefault();
  startFromDialog();
});
$(document).on('click', '[data-copy]', async (e) => {
  const input = $(e.currentTarget.dataset.copy)[0];
  input.select();
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    document.execCommand('copy');
  }
});

$('#new').on('click', askNewGame);
$('#confirm-move').on('click', confirmPending);
$('#cancel-move').on('click', cancelPending);
$('#resign').on('click', resign);
$('#flip').on('click', flip);
$('#coords').on('click', cycleCoords);
$('#analysis-btn').on('click', toggleAnalysis);
$('#undo').on('click', undo);
$('#redo').on('click', redo);
$('#first').on('click', () => goTo(0));
$('#last').on('click', () => {
  goTo(state.history.length);
  maybeBotMove();
});
$('#moves').on('click', '.mv[data-ply]', (e) => goTo(Number(e.currentTarget.dataset.ply)));

$('#autoplay').on('click', toggleAutoplay);
$('#autoplay-speed').on('change', (e) => changeSettings({ autoplaySpeed: Number(e.target.value) }));
$('#replay-continue').on('click', continueFromHere);
$('#replay-exit').on('click', () => exitReplay());

$('#games-btn').on('click', () => library.open());
$('#settings-btn').on('click', () => settingsUi.open());

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
$('#modal-download').on('click', () => download(String($('#modal-text').val()), `chess-${today()}.pgn`, 'application/x-chess-pgn'));

$(document).on('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if ($(e.target).is('input, textarea, select') || $('dialog[open]').length) return;
  const k = e.key.toLowerCase();
  if (k === 'f') flip();
  else if (k === 'c') cycleCoords();
  else if (k === 'a') toggleAnalysis();
  else if (k === 'n' && !state.replay) askNewGame();
  else if (k === 'g') library.open();
  else if (k === 's') settingsUi.open();
  else if (k === ' ' && state.replay) toggleAutoplay();
  else if (k === 'escape' && state.replay) exitReplay();
  else if (k === 'escape' && pendingMove) cancelPending();
  else if (k === 'escape' && premoves.length) clearPremoves();
  else if (k === 'enter' && pendingMove) confirmPending();
  else if (e.key === 'ArrowLeft') undo();
  else if (e.key === 'ArrowRight') redo();
  else if (e.key === 'Home') goTo(0);
  else if (e.key === 'End') $('#last').trigger('click');
  else return;
  e.preventDefault();
});

window.addEventListener('pagehide', () => flushSave());

// ---- Bot API game (server is the referee) ---------------------------------------
const REASON_TEXT = { threefold: 'threefold repetition', fifty_move: '50-move rule', insufficient_material: 'insufficient material' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const escHtml = (t) => String(t).replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** Remaining move time as 42s, 3:05 or 23:59:59. */
function fmtLeft(ms) {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const [h, m, s] = [Math.floor(sec / 3600), Math.floor(sec / 60) % 60, sec % 60];
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Server time now, corrected for this browser's clock offset (measured on each server response). */
const serverNow = () => Date.now() + (remote?.skew || 0);

/** Clock display: 9.3 under 10 s, else m:ss or h:mm:ss. */
function fmtClock(ms) {
  ms = Math.max(0, ms);
  if (ms < 10000) return `0:0${(Math.floor(ms / 100) / 10).toFixed(1)}`;
  const sec = Math.floor(ms / 1000);
  const [h, m, r] = [Math.floor(sec / 3600), Math.floor(sec / 60) % 60, sec % 60];
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

/** Time left on side c's clock now (ms). */
function clockLeft(s, c) {
  const running = s.status === 'ongoing' && s.ply >= 2 && s.turn[0] === c;
  return running ? Math.max(0, s.deadline_at - serverNow()) : s.clocks[c === 'w' ? 'white' : 'black'];
}

function renderClocks() {
  const s = remote?.server;
  const show = !!s?.clock;
  $('#clock-top, #clock-bottom').prop('hidden', !show);
  if (!show) return;
  const top = state.settings.orientation === 'w' ? 'b' : 'w';
  const lowAt = Math.min(20000, Math.max(10000, s.clock.initial_ms / 10));
  for (const [pos, c] of [['top', top], ['bottom', opposite(top)]]) {
    const ms = clockLeft(s, c);
    const flagged = s.status === 'timeout' && s.reason === `${c === 'w' ? 'white' : 'black'}_timeout`;
    const active = s.status === 'ongoing' && s.ply >= 2 && s.turn[0] === c;
    $(`#clock-${pos}`).text(fmtClock(ms)).toggleClass('active', active).toggleClass('low', ms < lowAt && !flagged)
      .toggleClass('flagged', flagged).attr('title', `${COLOR_NAME[c]}'s clock`);
  }
}

/** Playing (not spectating) an online game that is still going: engine help is off. */
function netPlaying() {
  return !!remote?.side && remote.server?.status === 'ongoing';
}

/** Side the in-browser Stockfish plays in this game, if any. */
const netEngineSide = () => (remote?.engineToken && remote.side ? opposite(remote.side) : null);

/** Players with live presence, plus invite/bot/spectator links for the creator. */
function renderNet() {
  $('#net-panel').prop('hidden', !remote);
  renderClocks();
  if (!remote) return;
  const s = remote.server;
  const rows = ['white', 'black'].map((side) => {
    const c = side[0];
    const p = s?.players?.[side] || {};
    const you = remote.side === c;
    const engineHere = netEngineSide() === c;
    const live = s?.status === 'ongoing';
    const on = live && (you || engineHere || !!p.connected);
    const tags = [COLOR_NAME[c], you && 'you', (p.engine || engineHere) && 'engine', live && !on && 'not connected'].filter(Boolean).join(' · ');
    const cls = s?.status === 'ongoing' && s.turn === side ? 'to-move' : '';
    return `<li class="${cls}"><span class="dot${on ? ' on' : ''}" title="${on ? 'Connected' : 'Not connected'}"></span>`
      + `<span class="name">${escHtml(p.name || COLOR_NAME[c])}</span><span class="tag">${tags}</span></li>`;
  });
  $('#net-players').html(rows.join(''));
  if (s) {
    const time = s.clock ? `${tcLabel(s.clock)} clock` : `${fmtLeft(s.move_time_ms)} per move`;
    $('#net-rules').text(`${time} · premoves ${s.premoves === false ? 'off' : 'allowed'}`);
  }
  const over = !!s && s.status !== 'ongoing';
  const other = remote.side ? COLOR_NAME[opposite(remote.side)] : '';
  $('#net-invite').prop('hidden', !remote.invite || over);
  if (remote.invite) {
    $('#net-invite-side').text(other);
    $('#net-invite-url').val(gameLink(remote.id, remote.invite));
  }
  $('#net-bot').prop('hidden', !remote.botToken || over);
  if (remote.botToken) {
    $('#net-bot-side').text(other);
    $('#net-bot-token').val(remote.botToken);
    $('#net-bot-cmd').val(`node bot/random_bot.mjs ${location.origin} ${remote.id} ${remote.botToken}`);
  }
  $('#net-watch-url').val(gameLink(remote.id));
}

/** In-browser Stockfish plays its side through the API, exactly like an external bot. */
async function netEngineTurn() {
  const s = remote?.server;
  if (!s || s.status !== 'ongoing' || remote.engineBusy || s.turn[0] !== netEngineSide()) return;
  remote.engineBusy = true;
  renderStatus();
  let retry = false;
  try {
    // On a clock, think at most ~1/40 of the time left so Stockfish doesn't flag.
    const left = s.clock ? (s.ply >= 2 ? clockLeft(s, s.turn[0]) : s.deadline_at - serverNow()) : null;
    const cap = left === null ? undefined : Math.max(50, Math.floor(left / 40));
    const pause = left === null ? BOT_PAUSE_MS : Math.min(BOT_PAUSE_MS, cap);
    const [uci] = await Promise.all([engine.bestMove(s.fen, remote.engineLevel ?? 5, cap), sleep(pause)]);
    if (!uci || remote.server.ply !== s.ply) return;
    const next = await botApi.move(remote.id, remote.engineToken, uci);
    remote.engineBusy = false;
    if (!remote.busy) applyServer(next);
  } catch (err) {
    remote.error = `Stockfish: ${err.message || err}`;
    retry = err.status === undefined || err.status === 0; // engine or network trouble, not a server rejection
  } finally {
    remote.engineBusy = false;
    renderStatus();
  }
  if (retry) setTimeout(netEngineTurn, 2000);
}

/** Store a finished online game in My games once (players only). */
function maybeSaveNet() {
  const s = remote?.server;
  if (!s || s.status === 'ongoing' || s.status === 'aborted' || !remote.side || remote.saved || !storeReady || !s.moves.length) return;
  remote.saved = true;
  netStore.set(remote.id, { saved: true });
  const names = playerNames();
  const rec = {
    id: null,
    createdAt: Math.floor(s.created_at / 1000),
    startFen: DEFAULT_POSITION,
    moves: s.moves.map((m) => m.uci),
    result: s.result,
    termination: remoteEndText(s).replace(/^./, (ch) => ch.toUpperCase()),
    mode: 'net',
    humanColor: remote.side,
    botLevel: remote.engineLevel ?? s.players?.[s.players?.white?.engine ? 'white' : 'black']?.engine?.level ?? null,
    white: names.white,
    black: names.black,
    title: `Online game ${remote.id}${s.clock ? ` · ${tcLabel(s.clock)}` : ''}`,
    assisted: false,
  };
  store.save(rec).catch((err) => {
    remote.saved = false;
    netStore.set(remote.id, { saved: false });
    saveError = `Not saved: ${err.message || err}`;
    renderStatus();
  });
}

/** "5+3" style label of a clock (minutes + increment seconds). */
const tcLabel = (c) => `${+(c.initial_ms / 60000).toFixed(2)}+${+(c.increment_ms / 1000).toFixed(1)}`;

function remoteEndText(s) {
  const who = s.reason?.startsWith('black') ? 'Black' : 'White';
  if (s.status === 'aborted') return `aborted, ${who} made no first move`;
  if (s.status === 'resigned') return `${who} resigned`;
  if (s.status === 'timeout') return `${who} ran out of time`;
  return REASON_TEXT[s.reason] || s.status;
}

function remoteStatus() {
  const s = remote.server;
  if (!s) return remote.error || `Loading game ${remote.id}…`;
  const role = remote.side ? `You are ${COLOR_NAME[remote.side]}` : 'Spectating';
  if (pendingMove && s.status === 'ongoing') return `${role} · Confirm ${pendingMove.san}? (Enter / Esc)`;
  let t;
  if (s.status === 'ongoing') {
    const mine = remote.side && s.turn[0] === remote.side;
    const who = mine ? 'Your move' : remote.engineBusy ? 'Stockfish is thinking' : `${COLOR_NAME[s.turn[0]]} to move`;
    const left = fmtLeft(s.deadline_at - serverNow());
    const time = !s.clock ? ` · ${left} left` : s.ply < 2 ? ` · first move within ${left}` : '';
    t = `${who}${s.in_check ? ' — check!' : ''}${time}`;
  } else if (s.status === 'aborted') {
    t = `Game ${remoteEndText(s)}`;
  } else {
    t = `${RESULT_TEXT[s.result] || s.result} — ${remoteEndText(s)}`;
  }
  let out = `${role} · ${t}`;
  if (!atEnd()) out += ` · viewing move ${state.ply}/${state.history.length}`;
  if (remote.error) out += ` · ${remote.error}`;
  return out;
}

/** Bring the board in line with the server's state. */
function applyServer(s) {
  const prev = remote.server;
  remote.server = s;
  if (s.server_now) remote.skew = s.server_now - Date.now();
  let sideSet = false;
  if (s.you && !remote.side) {
    remote.side = s.you[0];
    state.settings.orientation = remote.side;
    sideSet = true;
  }
  if (s.status !== 'ongoing') {
    premoves = [];
    pendingMove = null;
  }
  const local = state.history.map(toUci);
  const srv = s.moves.map((m) => m.uci);
  const isPrefix = local.length <= srv.length && local.every((u, i) => u === srv[i]);
  const following = atEnd();
  if (isPrefix && srv.length === local.length && !sideSet) {
    if (prev?.status === 'ongoing' && s.status !== 'ongoing' && state.settings.sound) playSound('end', state.settings.volume);
    // Nothing moved: don't re-render the board (would cut a running move animation).
    board.setMovable(movableColor());
    $('#resign').prop('disabled', !remote.side || isOver());
    $('#analysis-btn').prop('disabled', netPlaying());
    if (prev?.status !== s.status) refreshAnalysis();
    renderNet();
    renderStatus();
  } else if (isPrefix && following && srv.length === local.length + 1) {
    playMove(fromUci(srv.at(-1)));
  } else {
    pendingMove = null;
    const g = new Chess(DEFAULT_POSITION);
    state.startFen = DEFAULT_POSITION;
    state.history = srv.map((u) => {
      const r = g.move(fromUci(u));
      return { from: r.from, to: r.to, promotion: r.promotion, san: r.san };
    });
    if (following || !isPrefix) state.ply = state.history.length;
    rebuild();
    update();
  }
  netEngineTurn();
  maybeSaveNet();
  runPremove();
}

async function remoteMove(move, animate, skipConfirm = false) {
  if (state.settings.confirmMove && !skipConfirm) {
    // Show the move on the board and wait for Confirm / Cancel; nothing is sent yet.
    let res;
    try {
      res = new Chess(game.fen()).move(move);
    } catch {
      return update();
    }
    pendingMove = { from: res.from, to: res.to, promotion: res.promotion, san: res.san };
    if (animate) pendingAnim = animFor(res);
    return update();
  }
  remote.busy = true; // locks the board until the server answers
  if (!playMove(move, animate)) {
    remote.busy = false;
    return update();
  }
  try {
    const s = await botApi.move(remote.id, remote.token, toUci(state.history.at(-1)));
    remote.error = null;
    remote.busy = false;
    applyServer(s);
  } catch (err) {
    remote.busy = false;
    remote.error = `Move rejected: ${err.message}`;
    await remoteResync();
  }
}

async function remoteResign() {
  if (!remote.side || isOver() || !confirmIf(true, `Resign as ${COLOR_NAME[remote.side]}?`)) return;
  try {
    applyServer(await botApi.resign(remote.id, remote.token));
  } catch (err) {
    remote.error = `Resign failed: ${err.message}`;
    await remoteResync();
  }
}

/** Full reload from the server (after a rejected action). */
async function remoteResync() {
  try {
    const s = await botApi.get(remote.id, remote.token);
    state.history = [];
    state.ply = 0;
    rebuild();
    applyServer(s);
  } catch (err) {
    remote.error = err.message;
    update();
  }
}

async function remoteStart() {
  state.startFen = DEFAULT_POSITION;
  state.history = [];
  state.ply = 0;
  state.resigned = null;
  rebuild();
  let s;
  try {
    s = await botApi.get(remote.id, remote.token);
  } catch (err) {
    if (err.status === 401 && remote.token) {
      remote.token = null;
      remote.error = 'Invalid token, spectating';
      netStore.set(remote.id, { token: null, engineToken: null });
      remote.engineToken = null;
      return remoteStart();
    }
    remote.error = err.status === 404 ? `Game ${remote.id} not found` : `Could not load game: ${err.message}`;
    return update();
  }
  applyServer(s);
  setInterval(() => {
    if (remote.server?.status !== 'ongoing') return;
    renderStatus();
    renderClocks();
  }, remote.server?.clock ? 100 : 1000);
  let backoff = 1000;
  let engineSeen = 0;
  while (remote.server.status === 'ongoing') {
    // The in-browser engine's side shows as connected only if its token is seen now and then.
    if (netEngineSide() && Date.now() - engineSeen > 15000) {
      engineSeen = Date.now();
      botApi.get(remote.id, remote.engineToken).catch(() => {});
    }
    try {
      if (remote.error?.startsWith('Connection')) {
        // After an outage: quick full resync first, so the status clears without waiting out a long-poll.
        const fresh = await botApi.get(remote.id, remote.token);
        remote.error = null;
        backoff = 1000;
        state.history = [];
        state.ply = 0;
        rebuild();
        applyServer(fresh);
        continue;
      }
      const next = await botApi.wait(remote.id, remote.server.ply, remote.token);
      backoff = 1000;
      if (!remote.busy) applyServer(next);
    } catch (err) {
      remote.error = `Connection lost (${err.message}), retrying…`;
      renderStatus();
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 15000);
    }
  }
}

// ---- Fair play reminder (once per browser, before the first game against a person) ----
const FAIRPLAY_KEY = 'chess.fairplay.v1';

function fairPlayOnce() {
  try {
    if (localStorage.getItem(FAIRPLAY_KEY)) return Promise.resolve();
  } catch {
    /* storage unavailable: show it */
  }
  const dlg = $('#fairplay-modal')[0];
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => {
      try {
        localStorage.setItem(FAIRPLAY_KEY, '1');
      } catch {
        /* ignore */
      }
      resolve();
    }, { once: true });
    dlg.showModal();
  });
}
$('#fairplay-ok').on('click', () => $('#fairplay-modal')[0].close());

// ---- Boot ------------------------------------------------------------------
if (!remote) restore();
applySettings();
rebuild();
update();
engine.init().catch((err) => {
  console.error(err);
  engineError = null; // only surfaced when the bot is actually needed
});

api.init().then((user) => {
  // A stored id only makes sense in the store it came from.
  if (state.gameId !== null && (typeof state.gameId === 'number') !== !!user) state.gameId = null;
  if (user && user.settings && Object.keys(user.settings).length) {
    state.settings = { ...Settings.sanitize(user.settings), ...gameBits() };
    applySettings();
    Settings.saveLocal(state.settings);
  }
  account.render();
  storeReady = true;
  update();
  maybeBotMove();
  if (remote) maybeSaveNet();
});
if (remote) remoteStart();
if (remote && joinedByLink) fairPlayOnce();
else if (location.hash === '#analysis') {
  // "Analysis board" chosen while in an online game: fresh local board.
  history.replaceState(null, '', location.pathname);
  changeSettings({ mode: 'free' });
  newGame();
}
