// Shared MCP layer for the bot API: tool definitions, JSON-RPC dispatch and result text.
// Transports (bot/mcp.mjs over stdio, POST /mcp in bot/server.mjs) supply a backend:
//   create(opts) / get(id, token) / wait(id, since, token) / move(id, token, uci) / resign(id, token) / abort(id, token)
//   draw(id, token, action) / takeback(id, token, action) / pgn(id, token) -> text / lookup(token) -> id / list() -> states
// Each returns the API game state or throws { status, code, message, extra } (the API error shape).
// Speaks both protocol eras: 2026-07-28 (server/discover + per-request _meta) and the older
// initialize handshake (2025-11-25 and earlier).
import { Chess } from '../vendor/chess.js/chess.js';

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
Before both sides' first moves either side may abort; later, end a lost game with resign. Draws: draw offer/accept/decline (moving also declines). Takebacks: takeback request undoes your last move once the opponent accepts. Watch "offers" in get_board and answer offers made to you.`;

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
      'Create a game from the standard position. Returns game_id and a secret token for every side not played by the server engine. ' +
      "Keep tokens private: a token is the only credential for its side. Time control: move_time_ms per move, " +
      'or a chess clock with clock_initial_ms (+ clock_increment_ms). Timing starts once both sides have joined and made a first move (30 min each).',
    inputSchema: {
      type: 'object',
      properties: {
        move_time_ms: int('Time limit per move in ms (1000 to 86400000). Default: server setting, usually 30000', 1000, 86_400_000),
        clock_initial_ms: int('Chess clock: time per side in ms (15000 to 10800000). Not with move_time_ms', 15_000, 10_800_000),
        clock_increment_ms: int('Chess clock: time added after each move in ms (0 to 180000), only with clock_initial_ms', 0, 180_000),
        premoves: { type: 'boolean', description: 'Allow players to queue moves (premoves) in the web client. Default true' },
        eval_bar: { type: 'boolean', description: 'Allow players to show the Stockfish evaluation bar (winning chances) in the web client. Default false' },
        white_name: str('Display name for white (max 40 chars)', { maxLength: 40 }),
        black_name: str('Display name for black (max 40 chars)', { maxLength: 40 }),
        engine_side: str('Let the server play this side with Stockfish', { enum: ['white', 'black'] }),
        engine_level: int('Stockfish level 0-20 (default 5), only with engine_side', 0, 20),
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'make_move',
    title: 'Make a move',
    description: 'Play a move for the side that token controls. On an illegal move the error lists the legal moves.',
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
    title: 'Read the board',
    description:
      'Current position as an ASCII board, FEN, move list, legal moves, status and the deadline. ' +
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
  action('resign', 'Resign', 'Resign the game for the side that token controls: the opponent wins.', {}, { destructiveHint: true }),
  action('abort', 'Abort', 'Abort the game (no result) before both sides have made their first move.', {}, { destructiveHint: true }),
  action('draw', 'Draw offer', "Offer a draw, or accept / decline the opponent's offer. Offering when the opponent already offers accepts it. Making a move declines a pending offer.", {
    action: str('offer, accept or decline', { enum: ['offer', 'accept', 'decline'] }),
  }),
  action('takeback', 'Takeback', "Ask to take back your last move (and the reply to it, if made), or accept / decline the opponent's request. Clocks are not refunded.", {
    action: str('request, accept or decline', { enum: ['request', 'accept', 'decline'] }),
  }),
  {
    name: 'get_pgn',
    title: 'Export PGN',
    description: 'PGN of the game (finished or ongoing) with players, result, time control and termination.',
    inputSchema: { type: 'object', properties: { game_id: GAME_ID, token: str('Your token; required without game_id') }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'list_games',
    title: 'List active games',
    description: 'Ongoing games created or played through this MCP server: id, players, ply, side to move, clocks and offers. Tokens are not shown.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

const fail = (message) => {
  throw Object.assign(new Error(message), { status: 400, code: 'invalid_arguments' });
};
const optStr = (v, k) => (v === undefined || typeof v === 'string' ? v : fail(`"${k}" must be a string`));
const optInt = (v, k) => (v === undefined || Number.isInteger(v) ? v : fail(`"${k}" must be an integer`));
const reqStr = (v, k) => (typeof v === 'string' && v ? v : fail(`"${k}" is required`));

/** "5+3" style label: minutes + increment seconds. */
const tc = (c) => `${+(c.initial_ms / 60000).toFixed(2)}+${+(c.increment_ms / 1000).toFixed(1)}`;

function moveList(moves) {
  const out = [];
  moves.forEach((m, i) => out.push(i % 2 ? m.san : `${i / 2 + 1}. ${m.san}`));
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
  lines.push('', chess.ascii(), `FEN: ${s.fen}`, `Moves: ${moveList(s.moves)}`);
  if (s.status === 'ongoing') lines.push(`Legal moves (UCI): ${chess.moves({ verbose: true }).map((m) => m.lan).join(' ')}`);
  const p = s.players || {};
  const name = (c) => `${p[c]?.name || c}${p[c]?.connected ? '' : ' (not connected)'}`;
  const sec = (ms) => Math.round(ms / 100) / 10;
  const time = s.clock
    ? `Clock ${sec(s.clock.initial_ms)}s + ${sec(s.clock.increment_ms)}s/move; left: white ${sec(s.clocks.white)}s, black ${sec(s.clocks.black)}s${s.ply < 2 ? ` (clocks start after both first moves, each within ${sec(s.move_time_ms)}s)` : ''}`
    : `Move time ${s.move_time_ms} ms`;
  lines.push(`Players: white ${name('white')}, black ${name('black')}. ${time}. Watch: ${link(s.game_id)}`);
  const rule = s.clock ? `clock ${tc(s.clock)}` : `${sec(s.move_time_ms)}s per move`;
  lines.push(`Rules: ${rule}, premoves ${s.premoves === false ? 'off' : 'allowed'}, eval bar ${s.eval_bar ? 'allowed' : 'off'} (web client).`);
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
      if (optStr(a.white_name, 'white_name')) opts.white = { name: a.white_name };
      if (optStr(a.black_name, 'black_name')) opts.black = { name: a.black_name };
      if (optStr(a.engine_side, 'engine_side')) opts.engine = { side: a.engine_side, level: optInt(a.engine_level, 'engine_level') ?? 5 };
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
    case 'get_pgn': {
      const token = optStr(a.token, 'token') || null;
      const text = await backend.pgn(await gameId(token), token);
      return { s: { pgn: text }, text };
    }
    case 'list_games': {
      const games = await backend.list();
      const row = (g) => {
        const p = g.players || {};
        const clocks = g.clocks ? `, clocks ${Math.round(g.clocks.white / 1000)}s / ${Math.round(g.clocks.black / 1000)}s` : '';
        const offers = [g.offers?.draw && `draw offered by ${g.offers.draw}`, g.offers?.takeback && `takeback asked by ${g.offers.takeback}`].filter(Boolean);
        return `- ${g.game_id}: ${p.white?.name || 'White'} vs ${p.black?.name || 'Black'}, ply ${g.ply}, ${g.turn} to move${clocks}${offers.length ? `; ${offers.join(', ')}` : ''}`;
      };
      const text = games.length ? `${games.length} ongoing game(s):\n${games.map(row).join('\n')}` : 'No ongoing games.';
      return { s: { games }, text };
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
export function mcpServer(backend, { name = 'chess-bot-api', version = '1.0.0', link = (id) => `/?game=${id}` } = {}) {
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
