// Shared MCP layer for the bot API: tool definitions, JSON-RPC dispatch and result text.
// Transports (bot/mcp.mjs over stdio, POST /mcp in bot/server.mjs) supply a backend:
//   create(opts) / get(id, token) / wait(id, since, token) / move(id, token, uci) / resign(id, token) / abort(id, token)
//   draw(id, token, action) / takeback(id, token, action) / rules(id, token, analysis) / pgn(id, token) -> text / lookup(token) -> id
//   list({ status, player, limit }) -> states / library(key, { id } | { limit, offset }) -> web-app game record(s); libraryKey: default key or undefined
// Each returns the API game state or throws { status, code, message, extra } (the API error shape).
// Speaks both protocol eras: 2026-07-28 (server/discover + per-request _meta) and the older
// initialize handshake (2025-11-25 and earlier).
import { Chess, DEFAULT_POSITION } from '../vendor/chess.js/chess.js';

export const MODERN = '2026-07-28';
const LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26'];
export const SUPPORTED = [MODERN, ...LEGACY];
export const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
export const E = { parse: -32700, invalid: -32600, method: -32601, params: -32602, internal: -32603, headerMismatch: -32020, version: -32022 };
const CACHE = { ttlMs: 3_600_000, cacheScope: 'public' };

const INSTRUCTIONS = `Chess games refereed by a server. create_game returns a game_id and one secret token per side you control.
Loop: get_board with your token tells you your side ("you"). If it is your turn, make_move (UCI, e.g. e2e4, e7e8q).
Otherwise call get_board with wait_since_ply = the current ply; it returns when the opponent moves (or after ~25 s unchanged).
Time: nothing counts down until both sides are connected (aborted after 24 h if they never are). Then each side has first_move_ms (30 min) for its first move, else the game is aborted. After that, per-move games give every move move_time_ms; clock games ("clock" set) give each side initial_ms plus increment_ms per move. Running out loses on time. Stop when status is no longer "ongoing".
Every tool that takes game_id also works with just your token. list_games shows ongoing games used through this server.
To play against the user: create_game with human_side; you get only your own token plus a link for the user to play their side in the browser. Give them the link and never move for their side. To let the user play Stockfish while you watch: create_game with engine_side and human_side; give the user the returned link (never a bare token) and spectate with get_board using game_id and wait_since_ply. If the user gives you a token (e.g. the bot token from a "Bot" game in the web client), call get_board with just that token and play only that side.
Custom start: create_game takes one of fen, pgn, from_game_id (an earlier game here; find them with list_games status/player) or library_game_id (the user's saved games in the web app; find them with list_library_games), plus ply to start after that many of its moves (default: its final position). The new game's move list starts empty at that position.
Before both sides' first moves either side may abort; later, end a lost game with resign. Draws: draw offer/accept/decline (moving also declines). Takebacks: takeback request undoes your last move once the opponent accepts. set_analysis turns Stockfish analysis for the web client on/off mid-game (games created through MCP only). Watch "offers" in get_board and answer offers made to you.`;

export class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    Object.assign(this, { code, data });
  }
}

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const int = (description, minimum, maximum) => ({ type: 'integer', description, minimum, maximum });
const GAME_ID = str('Game id returned by create_game. Optional when token is given', { pattern: '^[A-Za-z0-9]{10}$' });
const TOKEN = str('Secret token of your side');
const action = (name, title, description, extra = {}, annotations = {}) => ({
  name,
  title,
  description,
  inputSchema: { type: 'object', properties: { game_id: GAME_ID, token: TOKEN, ...extra }, required: ['token', ...Object.keys(extra)], additionalProperties: false },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, ...annotations },
});

export const TOOLS = [
  {
    name: 'create_game',
    title: 'Create chess game',
    description:
      'Start a new chess game (new game, create game, play chess): play chess against the user (browser link), let the user play Stockfish, or play both sides yourself. ' +
      'From the standard position or a custom one (fen, pgn, from_game_id or library_game_id; ply picks the moment). Returns game_id and a secret token for every side not played by the server engine. ' +
      "Keep tokens private: a token is the only credential for its side. Time control: move_time_ms per move, " +
      'or a chess clock with clock_initial_ms (+ clock_increment_ms). Timing starts once both sides have joined and made a first move (30 min each). ' +
      'With human_side you play only the other side: the result gives your token and a browser link for the user to play human_side.',
    inputSchema: {
      type: 'object',
      properties: {
        move_time_ms: int('Time limit per move in ms (1000 to 86400000). Default: server setting, usually 30000', 1000, 86_400_000),
        clock_initial_ms: int('Chess clock: time per side in ms (15000 to 10800000). Not with move_time_ms', 15_000, 10_800_000),
        clock_increment_ms: int('Chess clock: time added after each move in ms (0 to 180000), only with clock_initial_ms', 0, 180_000),
        premoves: { type: 'boolean', description: 'Allow players to queue moves (premoves) in the web client. Default true' },
        eval_bar: { type: 'boolean', description: 'Allow players to show the Stockfish evaluation bar (winning chances) in the web client. Default false' },
        analysis: { type: 'boolean', description: 'Allow players to use full Stockfish analysis (best move + line) in the web client. Default false' },
        white_name: str('Display name for white (max 40 chars)', { maxLength: 40 }),
        black_name: str('Display name for black (max 40 chars)', { maxLength: 40 }),
        human_name: str("Display name for the user's side (human_side) or the side not played by the server engine (engine_side); applied once a random side is drawn. Max 40 chars", { maxLength: 40 }),
        engine_name: str("Display name for your side (with human_side) or the server engine's side (with engine_side); applied once a random side is drawn. Max 40 chars", { maxLength: 40 }),
        engine_side: str('Let the server play this side with Stockfish. With human_side "random" the engine takes whichever side the user does not get', { enum: ['white', 'black'] }),
        engine_level: int('Stockfish level 0-20 (default 5), only with engine_side', 0, 20),
        human_side: str('The user plays this side in the browser; you get only the other side\'s token. Default: you control both sides. With engine_side the user plays the engine and you only spectate (no token)', {
          enum: ['white', 'black', 'random'],
        }),
        fen: str('Start from this FEN (side to move, castling and en passant are taken from it). Only one of fen / pgn / from_game_id / library_game_id', { maxLength: 100 }),
        pgn: str('Start from a PGN game (mainline; a [FEN] tag is honoured): its final position, or the one after "ply" moves', { maxLength: 60000 }),
        from_game_id: str('Start from an earlier game on this server (finished or not): its final position, or the one after "ply" moves', { pattern: '^[A-Za-z0-9]{10}$' }),
        library_game_id: int('Start from a game saved in the user\'s web-app library (ids from list_library_games)', 1),
        library_key: str('API key of the user\'s web-app account (Account → API key). Only with library_game_id; optional when the server has a default'),
        ply: int('With pgn / from_game_id / library_game_id: start after this many plies (half-moves) of that game. Default: all of them', 0),
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'make_move',
    title: 'Make a chess move',
    description: 'Play a chess move in a game (from create_game) for the side that token controls. On an illegal move the error lists the legal moves.',
    inputSchema: {
      type: 'object',
      properties: {
        game_id: GAME_ID,
        token: str('Secret token of the side to move'),
        move: str('Move in UCI form: e2e4, e1g1 (castling), e7e8q (promotion)', { pattern: '^[a-hA-H][1-8][a-hA-H][1-8][qrbnQRBN]?$' }),
      },
      required: ['token', 'move'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'get_board',
    title: 'Show the chess board',
    description:
      'Show the current chess board and game state: position as an ASCII board, FEN, move list, legal moves, status and the deadline. ' +
      'With a token, "you" says which side it plays. With wait_since_ply, waits (up to ~25 s) until ply > wait_since_ply or the game ends.',
    inputSchema: {
      type: 'object',
      properties: {
        game_id: GAME_ID,
        token: str('Your token, to learn your side and show as connected. Required without game_id'),
        wait_since_ply: int('Optional: long-poll until the ply count exceeds this', 0),
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  action('resign', 'Resign chess game', 'Resign a chess game for the side that token controls: the opponent wins.', {}, { destructiveHint: true }),
  action('abort', 'Abort chess game', 'Abort a chess game (no result) before both sides have made their first move.', {}, { destructiveHint: true }),
  action('draw', 'Chess draw offer', "Chess draw: offer a draw, or accept / decline the opponent's offer. Offering when the opponent already offers accepts it. Making a move declines a pending offer.", {
    action: str('offer, accept or decline', { enum: ['offer', 'accept', 'decline'] }),
  }),
  action('takeback', 'Chess takeback', "Chess takeback (undo): ask to take back your last move (and the reply to it, if made), or accept / decline the opponent's request. Clocks are not refunded.", {
    action: str('request, accept or decline', { enum: ['request', 'accept', 'decline'] }),
  }),
  action('set_analysis', 'Allow chess analysis', 'Chess game setting: turn Stockfish analysis (best move + line) in the web client on or off mid-game. Only in games created through MCP.', {
    enabled: { type: 'boolean', description: 'true allows analysis, false turns it off' },
  }),
  {
    name: 'get_pgn',
    title: 'Export chess PGN',
    description: 'Export a chess game as PGN (finished or ongoing) with players, result, time control and termination.',
    inputSchema: { type: 'object', properties: { game_id: GAME_ID, token: str('Your token; required without game_id') }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'list_games',
    title: 'List chess games',
    description:
      'List chess games on this server (to resume one or start a new game from it with create_game): id, players, ply, side to move or result. Default: ongoing games created or played through MCP. ' +
      'With player: any game (also web-client games) where a player name contains that text, e.g. to find a player\'s previous games to start from. Tokens are not shown.',
    inputSchema: {
      type: 'object',
      properties: {
        status: str('ongoing (default), over or all', { enum: ['ongoing', 'over', 'all'] }),
        player: str('Case-insensitive part of a player name; searches every game, not only MCP ones', { maxLength: 40 }),
        limit: int('Max games (1-50, default 20)', 1, 50),
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'list_library_games',
    title: 'List saved chess games',
    description:
      "List saved chess games in the user's web-app account (My games): id, date, players, result, length. Use an id as create_game library_game_id. " +
      'Needs the account\'s API key (Account → API key in the web app) unless the server has a default.',
    inputSchema: {
      type: 'object',
      properties: {
        library_key: str('API key of the web-app account; optional when the server has a default'),
        limit: int('Max games (1-100, default 20), newest first', 1, 100),
        offset: int('Skip this many games', 0),
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

const fail = (message) => {
  throw Object.assign(new Error(message), { status: 400, code: 'invalid_arguments' });
};
const optStr = (v, k) => (v === undefined || typeof v === 'string' ? v : fail(`"${k}" must be a string`));
const optInt = (v, k) => (v === undefined || Number.isInteger(v) ? v : fail(`"${k}" must be an integer`));
const reqStr = (v, k) => (typeof v === 'string' && v ? v : fail(`"${k}" is required`));

const KEY_RE = /^ck_[A-Za-z0-9_-]{20,100}$/;

/**
 * Read the user's saved games from the web app (PHP, api/games.php) with an account API key.
 * query: { id } for one game, else { limit, offset }. Throws the API error shape.
 */
export async function libraryFetch(base, key, query = {}) {
  if (typeof key !== 'string' || !KEY_RE.test(key)) {
    throw { status: 400, code: 'invalid_library_key', message: 'A web-app API key is required ("ck_…", from Account → API key in the web app)' };
  }
  const root = new URL(base);
  if (!root.pathname.endsWith('/')) root.pathname += '/';
  const u = new URL('api/games.php', root);
  if (query.id != null) u.searchParams.set('id', String(query.id));
  else {
    u.searchParams.set('limit', String(query.limit ?? 20));
    u.searchParams.set('offset', String(query.offset ?? 0));
  }
  let r;
  try {
    r = await fetch(u, { headers: { 'X-Api-Key': key, Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    throw { status: 0, code: 'library_unreachable', message: `Game library unreachable at ${u.origin} (${e.cause?.code || e.message})` };
  }
  const data = await r.json().catch(() => null);
  if (!r.ok || !data) {
    const code = r.status === 401 ? 'invalid_library_key' : r.status === 404 ? 'not_found' : 'library_error';
    throw { status: r.status, code, message: data?.error || `Game library answered HTTP ${r.status}` };
  }
  return data;
}

/** create_game start options (fen / pgn / from_game / library game, + ply) into the REST body fields. */
async function startOpts(a, backend, opts) {
  const sources = ['fen', 'pgn', 'from_game_id', 'library_game_id'].filter((k) => a[k] !== undefined);
  if (sources.length > 1) fail(`Give only one of fen, pgn, from_game_id, library_game_id (got ${sources.join(', ')})`);
  if (optInt(a.ply, 'ply') !== undefined && !['pgn', 'from_game_id', 'library_game_id'].includes(sources[0])) fail('"ply" needs pgn, from_game_id or library_game_id');
  if (a.library_key !== undefined && sources[0] !== 'library_game_id') fail('"library_key" only goes with library_game_id');
  if (a.ply !== undefined) opts.ply = a.ply;
  if (optStr(a.fen, 'fen') !== undefined) opts.fen = a.fen;
  if (optStr(a.pgn, 'pgn') !== undefined) opts.pgn = a.pgn;
  if (optStr(a.from_game_id, 'from_game_id') !== undefined) opts.from_game = a.from_game_id;
  if (optInt(a.library_game_id, 'library_game_id') !== undefined) {
    const rec = await backend.library(optStr(a.library_key, 'library_key') || backend.libraryKey, { id: a.library_game_id });
    const moves = Array.isArray(rec.moves) ? rec.moves : [];
    if (a.ply !== undefined && a.ply > moves.length) fail(`"ply" must be between 0 and ${moves.length} for library game ${rec.id}`);
    const who = rec.white && rec.black ? ` (${rec.white} vs ${rec.black})` : '';
    Object.assign(opts, {
      fen: rec.startFen,
      moves,
      source: `library game #${rec.id}${who}${a.ply !== undefined && a.ply < moves.length ? ` after ply ${a.ply}` : ''}`.slice(0, 80),
    });
  }
}

/** "5+3" style label: minutes + increment seconds. */
const tc = (c) => `${+(c.initial_ms / 60000).toFixed(2)}+${+(c.increment_ms / 1000).toFixed(1)}`;

function moveList(moves, startFen) {
  const [, turn = 'w', , , , full = '1'] = (startFen || '').split(' ');
  const first = parseInt(full, 10) || 1;
  const off = turn === 'b' ? 1 : 0; // black moves first: numbering starts with "N..."
  const out = [];
  moves.forEach((m, i) => {
    const k = i + off;
    const n = first + Math.floor(k / 2);
    out.push(k % 2 ? (i === 0 ? `${n}... ${m.san}` : m.san) : `${n}. ${m.san}`);
  });
  return out.join(' ') || '(none)';
}

/** Human/LLM-readable game state. */
export function describe(s, link) {
  const lines = [];
  const who = s.you ? `; you are ${s.you}` : '';
  if (s.status === 'ongoing') {
    const left = s.deadline_at ? Math.max(0, Math.round((s.deadline_at - Date.now()) / 1000)) : null;
    const yours = s.you ? (s.you === s.turn ? ' (YOUR MOVE)' : ' (opponent to move)') : '';
    const time = left === null ? '' : s.clock && s.ply >= 2 ? `, ${left}s on ${s.turn}'s clock` : `, ${left}s left for this move`;
    lines.push(`Game ${s.game_id}: ply ${s.ply}, ${s.turn} to move${yours}${who}${s.in_check ? ', in check' : ''}${time}.`);
  } else {
    lines.push(`Game ${s.game_id} is over: ${s.status} ${s.result}${s.reason ? ` (${s.reason})` : ''}${s.winner ? `, ${s.winner} wins` : ''}${who}.`);
  }
  const chess = new Chess(s.fen);
  lines.push('', chess.ascii(), `FEN: ${s.fen}`);
  if (s.source || (s.start_fen && s.start_fen !== DEFAULT_POSITION)) lines.push(`Started from ${s.source || 'a custom position'}: ${s.start_fen}`);
  lines.push(`Moves: ${moveList(s.moves, s.start_fen)}`);
  if (s.status === 'ongoing') lines.push(`Legal moves (UCI): ${chess.moves({ verbose: true }).map((m) => m.lan).join(' ')}`);
  const p = s.players || {};
  const name = (c) => `${p[c]?.name || c}${p[c]?.connected ? '' : ' (not connected)'}`;
  const sec = (ms) => Math.round(ms / 100) / 10;
  const time = s.clock
    ? `Clock ${sec(s.clock.initial_ms)}s + ${sec(s.clock.increment_ms)}s/move; left: white ${sec(s.clocks.white)}s, black ${sec(s.clocks.black)}s${s.ply < 2 ? ` (clocks start after both first moves, each within ${sec(s.move_time_ms)}s)` : ''}`
    : `Move time ${s.move_time_ms} ms`;
  lines.push(`Players: white ${name('white')}, black ${name('black')}. ${time}. Watch: ${link(s.game_id)}`);
  const rule = s.clock ? `clock ${tc(s.clock)}` : `${sec(s.move_time_ms)}s per move`;
  lines.push(`Rules: ${rule}, premoves ${s.premoves === false ? 'off' : 'allowed'}, eval bar ${s.eval_bar ? 'allowed' : 'off'}, analysis ${s.analysis ? 'allowed' : 'off'} (web client).`);
  const o = s.offers || {};
  const tail = (c, verb) => (!s.you ? '' : c === s.you ? ' (yours, waiting for the opponent)' : `: answer with ${verb} accept or decline`);
  if (o.draw) lines.push(`Draw offered by ${o.draw}${tail(o.draw, 'draw')}.`);
  if (o.takeback) lines.push(`Takeback requested by ${o.takeback}${tail(o.takeback, 'takeback')}.`);
  if (s.status === 'ongoing' && s.ply < 2) lines.push('Abort is possible until both sides have made their first move.');
  return lines.join('\n');
}

async function callTool(backend, name, a = {}, link) {
  if (typeof a !== 'object' || a === null || Array.isArray(a)) fail('arguments must be an object');
  // game_id may be left out when a token is given: the token names its game.
  const gameId = async (token) => optStr(a.game_id, 'game_id') || (token ? backend.lookup(token) : fail('"game_id" or "token" is required'));
  const choice = (k, allowed) => (allowed.includes(a[k]) ? a[k] : fail(`"${k}" must be one of: ${allowed.join(', ')}`));
  // human_name / engine_name land on a colour only once the sides are known (human_side may be random).
  const sideNames = (opts, human, engine) => {
    for (const [k, c] of [['human_name', human], ['engine_name', engine]]) {
      if (!optStr(a[k], k)) continue;
      if (opts[c]) fail(`"${k}" and "${c}_name" both name ${c}`);
      opts[c] = { name: a[k] };
    }
  };
  switch (name) {
    case 'create_game': {
      const opts = {};
      if (optInt(a.move_time_ms, 'move_time_ms') !== undefined) opts.move_time_ms = a.move_time_ms;
      if (optInt(a.clock_initial_ms, 'clock_initial_ms') !== undefined) {
        opts.clock = { initial_ms: a.clock_initial_ms, increment_ms: optInt(a.clock_increment_ms, 'clock_increment_ms') ?? 0 };
      } else if (a.clock_increment_ms !== undefined) fail('"clock_increment_ms" needs "clock_initial_ms"');
      if (a.premoves !== undefined) {
        if (typeof a.premoves !== 'boolean') fail('"premoves" must be a boolean');
        opts.premoves = a.premoves;
      }
      if (a.eval_bar !== undefined) {
        if (typeof a.eval_bar !== 'boolean') fail('"eval_bar" must be a boolean');
        opts.eval_bar = a.eval_bar;
      }
      if (a.analysis !== undefined) {
        if (typeof a.analysis !== 'boolean') fail('"analysis" must be a boolean');
        opts.analysis = a.analysis;
      }
      if (optStr(a.white_name, 'white_name')) opts.white = { name: a.white_name };
      if (optStr(a.black_name, 'black_name')) opts.black = { name: a.black_name };
      if (optStr(a.engine_side, 'engine_side')) opts.engine = { side: a.engine_side, level: optInt(a.engine_level, 'engine_level') ?? 5 };
      await startOpts(a, backend, opts);
      if (optStr(a.human_side, 'human_side')) {
        const human = choice('human_side', ['white', 'black', 'random']);
        const side = human === 'random' ? (Math.random() < 0.5 ? 'white' : 'black') : human;
        if (opts.engine) {
          // User vs the server engine: the user plays in the browser, the agent only spectates.
          if (human !== 'random' && human === opts.engine.side) fail('"human_side" and "engine_side" must differ');
          opts.engine.side = side === 'white' ? 'black' : 'white';
          sideNames(opts, side, opts.engine.side);
          const { [`${side}_token`]: humanToken, ...s } = await backend.create(opts);
          Object.assign(s, { human_side: side, human_link: link(s.game_id, humanToken) });
          return {
            s,
            text:
              `Created game ${s.game_id}: the user plays ${side} against Stockfish (level ${opts.engine.level}). You have no token: you only spectate.\n` +
              `Give the user this link to play ${side} in the browser (it contains their token; never post the bare token):\n${s.human_link}\n` +
              `To spectate, call get_board with game_id "${s.game_id}" and wait_since_ply.\n\n${describe(s, link)}`,
          };
        }
        const agent = side === 'white' ? 'black' : 'white';
        sideNames(opts, side, agent);
        const full = await backend.create(opts);
        const { [`${side}_token`]: humanToken, ...s } = full;
        Object.assign(s, { human_side: side, human_link: link(s.game_id, humanToken), agent_side: agent, token: s[`${agent}_token`] });
        return {
          s,
          text:
            `Created game ${s.game_id}. You play ${agent}; your token: ${s.token}\nKeep it secret; pass it to make_move/get_board.\n` +
            `Give the user this link to play ${side} in the browser (it contains their token; do not move for ${side}):\n${s.human_link}\n\n${describe({ ...s, you: agent }, link)}`,
        };
      }
      if (opts.engine) {
        const other = opts.engine.side === 'white' ? 'black' : 'white';
        sideNames(opts, other, opts.engine.side);
      } else if (a.human_name !== undefined || a.engine_name !== undefined) fail('"human_name" / "engine_name" need "human_side" or "engine_side"');
      const s = await backend.create(opts);
      const tokens = ['white', 'black'].filter((c) => s[`${c}_token`]).map((c) => `${c}_token: ${s[`${c}_token`]}`);
      return { s, text: `Created game ${s.game_id}.\n${tokens.join('\n')}\nKeep tokens secret; pass one to make_move/get_board.\n\n${describe(s, link)}` };
    }
    case 'make_move': {
      const token = reqStr(a.token, 'token');
      const s = await backend.move(await gameId(token), token, reqStr(a.move, 'move'));
      return { s, text: `Played ${s.moves.at(-1)?.san}.\n\n${describe(s, link)}` };
    }
    case 'get_board': {
      const token = optStr(a.token, 'token') || null;
      const id = await gameId(token);
      const since = optInt(a.wait_since_ply, 'wait_since_ply');
      if (since !== undefined && since < 0) fail('"wait_since_ply" must be >= 0');
      const s = since === undefined ? await backend.get(id, token) : await backend.wait(id, since, token);
      return { s, text: describe(s, link) };
    }
    case 'resign':
    case 'abort': {
      const token = reqStr(a.token, 'token');
      const s = await backend[name](await gameId(token), token);
      return { s, text: `${name === 'resign' ? 'Resigned' : 'Aborted'}.\n\n${describe(s, link)}` };
    }
    case 'draw':
    case 'takeback': {
      const token = reqStr(a.token, 'token');
      const act = choice('action', name === 'draw' ? ['offer', 'accept', 'decline'] : ['request', 'accept', 'decline']);
      const s = await backend[name](await gameId(token), token, act);
      const what = name === 'draw' ? 'Draw' : 'Takeback';
      const done = { offer: 'offered', request: 'requested', accept: 'accepted', decline: 'declined' }[act];
      return { s, text: `${what} ${done}.\n\n${describe(s, link)}` };
    }
    case 'set_analysis': {
      const token = reqStr(a.token, 'token');
      if (typeof a.enabled !== 'boolean') fail('"enabled" must be a boolean');
      const s = await backend.rules(await gameId(token), token, a.enabled);
      return { s, text: `Analysis ${a.enabled ? 'allowed' : 'turned off'}.

${describe(s, link)}` };
    }
    case 'get_pgn': {
      const token = optStr(a.token, 'token') || null;
      const text = await backend.pgn(await gameId(token), token);
      return { s: { pgn: text }, text };
    }
    case 'list_games': {
      const status = a.status === undefined ? 'ongoing' : choice('status', ['ongoing', 'over', 'all']);
      const player = (optStr(a.player, 'player') || '').trim();
      const limit = optInt(a.limit, 'limit') ?? 20;
      if (limit < 1 || limit > 50) fail('"limit" must be 1-50');
      const games = await backend.list({ status, player, limit });
      const date = (ms) => new Date(ms).toISOString().slice(0, 10);
      const row = (g) => {
        const p = g.players || {};
        const head = `- ${g.game_id} (${date(g.created_at)}): ${p.white?.name || 'White'} vs ${p.black?.name || 'Black'}, ${g.ply} plies`;
        const from = g.source ? `, from ${g.source}` : '';
        if (g.status !== 'ongoing') return `${head}, ${g.status} ${g.result}${g.reason ? ` (${g.reason.replace(/_/g, ' ')})` : ''}${from}`;
        const clocks = g.clocks ? `, clocks ${Math.round(g.clocks.white / 1000)}s / ${Math.round(g.clocks.black / 1000)}s` : '';
        const offers = [g.offers?.draw && `draw offered by ${g.offers.draw}`, g.offers?.takeback && `takeback asked by ${g.offers.takeback}`].filter(Boolean);
        return `${head}, ${g.turn} to move${clocks}${from}${offers.length ? `; ${offers.join(', ')}` : ''}`;
      };
      const what = `${status === 'all' ? '' : `${status} `}game(s)${player ? ` with a player named like "${player}"` : ''}`;
      const text = games.length ? `${games.length} ${what}:\n${games.map(row).join('\n')}` : `No ${what}.`;
      return { s: { games }, text };
    }
    case 'list_library_games': {
      const limit = optInt(a.limit, 'limit') ?? 20;
      const offset = optInt(a.offset, 'offset') ?? 0;
      if (limit < 1 || limit > 100 || offset < 0) fail('"limit" must be 1-100 and "offset" >= 0');
      const data = await backend.library(optStr(a.library_key, 'library_key') || backend.libraryKey, { limit, offset });
      const games = (data.games || []).map((g) => ({
        id: g.id, date: g.createdAt ? new Date(g.createdAt * 1000).toISOString().slice(0, 10) : null, white: g.white || null, black: g.black || null,
        result: g.result, plies: g.moves?.length ?? 0, title: g.title || null, mode: g.mode, termination: g.termination || null,
        custom_start: g.startFen !== DEFAULT_POSITION,
      }));
      const row = (g) => `- #${g.id} (${g.date ?? '?'}): ${g.white || '?'} vs ${g.black || '?'}, ${g.result}, ${g.plies} plies, ${g.mode}${g.title ? ` · ${g.title}` : ''}${g.custom_start ? ' · custom start' : ''}`;
      const text = games.length
        ? `${games.length} of ${data.total} saved game(s)${offset ? ` from #${offset + 1}` : ''}:\n${games.map(row).join('\n')}`
        : data.total ? `No saved games past offset ${offset} (total ${data.total}).` : 'No saved games in this account.';
      return { s: { games, total: data.total }, text };
    }
    default:
      throw new RpcError(E.params, `Unknown tool: ${name}`);
  }
}

/**
 * JSON-RPC dispatcher. handle(msg, session) returns the response object, or null for notifications
 * and stray responses. session.version holds the legacy version negotiated by initialize (stdio:
 * one per process; HTTP: from the MCP-Protocol-Version header).
 */
export function mcpServer(backend, { name = 'chess-bot-api', version = '1.0.0', link = (id, token) => `/?game=${id}${token ? `#token=${token}` : ''}` } = {}) {
  const serverInfo = { name, title: 'Chess bot API', version };
  const meta = { 'io.modelcontextprotocol/serverInfo': serverInfo };

  async function dispatch(method, params, session) {
    if (method === 'initialize') {
      const want = params.protocolVersion;
      session.version = LEGACY.includes(want) ? want : LEGACY[0];
      return { protocolVersion: session.version, capabilities: { tools: {} }, serverInfo, instructions: INSTRUCTIONS };
    }
    const v = params._meta?.[META_VERSION] ?? session.version;
    if (v !== undefined && !SUPPORTED.includes(v)) throw new RpcError(E.version, `Unsupported protocol version: ${v}`, { supported: SUPPORTED, requested: v });
    switch (method) {
      case 'server/discover':
        return { resultType: 'complete', supportedVersions: SUPPORTED, capabilities: { tools: {} }, instructions: INSTRUCTIONS, ...CACHE, _meta: meta };
      case 'ping':
        return {};
      case 'tools/list':
        return { resultType: 'complete', tools: TOOLS, ...CACHE, _meta: meta };
      case 'tools/call': {
        if (typeof params.name !== 'string') throw new RpcError(E.params, '"name" is required');
        try {
          const { s, text } = await callTool(backend, params.name, params.arguments, link);
          return { resultType: 'complete', content: [{ type: 'text', text }], structuredContent: s, isError: false, _meta: meta };
        } catch (e) {
          if (e instanceof RpcError || e.code === undefined) throw e;
          // API errors go back as tool results so the model can read them and try again.
          const extra = e.extra || {};
          let text = `Error ${e.code}: ${e.message}`;
          if (extra.legal_moves) text += `\nLegal moves (UCI): ${extra.legal_moves.join(' ')}`;
          return { resultType: 'complete', content: [{ type: 'text', text }], structuredContent: { error: e.code, message: e.message, ...extra }, isError: true, _meta: meta };
        }
      }
      default:
        throw new RpcError(E.method, `Method not found: ${method}`);
    }
  }

  async function handle(msg, session = {}) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0') {
      return { jsonrpc: '2.0', id: null, error: { code: E.invalid, message: 'Expected a single JSON-RPC 2.0 message' } };
    }
    if (typeof msg.method !== 'string') return null; // a response from the client: nothing to do
    if (!('id' in msg)) return null; // notifications (initialized, cancelled, …) need no reply
    const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
    try {
      return { jsonrpc: '2.0', id: msg.id, result: await dispatch(msg.method, params, session) };
    } catch (e) {
      if (!(e instanceof RpcError)) console.error(e);
      const error = e instanceof RpcError ? { code: e.code, message: e.message, ...(e.data ? { data: e.data } : {}) } : { code: E.internal, message: 'Internal error' };
      return { jsonrpc: '2.0', id: msg.id, error };
    }
  }

  return { handle };
}
