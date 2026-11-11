/* global $ */
import { Chess, DEFAULT_POSITION } from 'https://cdn.jsdelivr.net/npm/chess.js@1.4.0/dist/esm/chess.js';
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

const opposite = (c) => (c === 'w' ? 'b' : 'w');
const isBot = () => state.settings.mode === 'bot' && !state.replay;
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

const isOver = () => game.isGameOver() || (!!state.resigned && atEnd());

// ---- Persistence of the live game -------------------------------------------
function liveSnapshot() {
  const { startFen, history, ply, humanColor, resigned, gameId, createdAt, gameToken, assisted } = state;
  return { startFen, history, ply, humanColor, resigned, gameId, createdAt, gameToken, assisted };
}

function persist() {
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
  if (!storeReady || state.replay || !state.history.length) return;
  if (saveSig() === savedSig) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 600);
}

/** Save the live game now (if it changed); resolves when all queued saves are done. */
function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (storeReady && !state.replay && state.history.length && saveSig() !== savedSig) {
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
  getMoves: (square) => game.moves({ square, verbose: true }),
  onMove: (from, to, promotion, dragged) => {
    if (playMove({ from, to, promotion }, !dragged)) maybeBotMove();
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
  $('#autoplay').text('▶ Play');
}

function toggleAutoplay() {
  if (!state.replay) return;
  if (autoplayTimer) return stopAutoplay();
  if (atEnd()) goTo(0);
  $('#autoplay').text('⏸ Pause');
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
  $('#status').text(statusText()).toggleClass('over', isOver() && !state.replay).toggleClass('thinking', thinking);
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
    pieces,
    orientation: s.orientation,
    coordMode: s.coordMode,
    lastMove: s.showLastMove && state.ply > 0 ? state.history[state.ply - 1] : null,
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
  $('#mode').val(s.mode);
  $('#side').val(s.side);
  $('#level').val(s.level);
  $('#level-out').text(s.level);
  $('.bot-only').prop('hidden', s.mode !== 'bot');
  $('.live-only').prop('hidden', replay);
  $('#replay-bar').prop('hidden', !replay);
  if (replay) {
    const r = state.replay.rec;
    $('#replay-title').text(`${r.white || '?'} vs ${r.black || '?'}${r.title ? ` — ${r.title}` : ''}`);
    const sp = String(s.autoplaySpeed);
    if (!$(`#autoplay-speed option[value="${sp}"]`).length) $('#autoplay-speed').append(`<option value="${sp}">${sp} s</option>`);
    $('#autoplay-speed').val(sp);
    $('#replay-continue').text(r.result === '*' && atEnd() ? 'Resume game' : 'Continue from here');
  }
  $('#resign').prop('disabled', !inProgress());
  $('#coords').text(COORD_LABELS[s.coordMode]);
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
  const on = state.settings.analysis;
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
      const { mode, side, level, orientation } = state.settings;
      state.settings = { ...server, mode, side, level, orientation };
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
  if (confirmIf(inProgress(), 'Abandon the current game and start a new one? (It stays in My games.)')) newGame();
}

$('#new').on('click', askNewGame);
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

$('#mode').on('change', (e) => {
  state.settings.mode = e.target.value;
  cancelBot();
  if (isBot()) resolveHumanColor();
  saveSettings();
  update();
  maybeBotMove();
});
$('#side').on('change', (e) => {
  state.settings.side = e.target.value;
  cancelBot();
  resolveHumanColor();
  saveSettings();
  update();
  maybeBotMove();
});
$('#level').on('input', (e) => {
  state.settings.level = Number(e.target.value);
  $('#level-out').text(state.settings.level);
  saveSettings();
});

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
  else if (e.key === 'ArrowLeft') undo();
  else if (e.key === 'ArrowRight') redo();
  else if (e.key === 'Home') goTo(0);
  else if (e.key === 'End') $('#last').trigger('click');
  else return;
  e.preventDefault();
});

window.addEventListener('pagehide', () => flushSave());

// ---- Boot ------------------------------------------------------------------
restore();
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
    const { mode, side, level, orientation } = state.settings;
    state.settings = { ...Settings.sanitize(user.settings), mode, side, level, orientation };
    applySettings();
    Settings.saveLocal(state.settings);
  }
  account.render();
  storeReady = true;
  update();
  maybeBotMove();
});
