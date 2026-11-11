#!/usr/bin/env node
// Example bot: plays random legal moves through the bot API. No dependencies.
//   node bot/random_bot.mjs <base_url> --new [move_time_ms]   create a game, print tokens
//   node bot/random_bot.mjs <base_url> <game_id> <token>       play one side until the game ends
import { Chess } from '../vendor/chess.js/chess.js';

const [base, idOrNew, arg3] = process.argv.slice(2);
if (!base || !idOrNew) {
  console.error('usage: random_bot.mjs <base_url> --new [move_time_ms]\n       random_bot.mjs <base_url> <game_id> <token>');
  process.exit(2);
}
const api = `${base.replace(/\/+$/, '')}/api/games`;

async function call(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Game-Token'] = token;
  const res = await fetch(api + path, { method, headers, body: body && JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`${res.status} ${data.error}: ${data.message}`), { status: res.status });
  return data;
}

if (idOrNew === '--new') {
  const g = await call('', { method: 'POST', body: arg3 ? { move_time_ms: Number(arg3) } : {} });
  console.log(`game_id     ${g.game_id}`);
  console.log(`white_token ${g.white_token}`);
  console.log(`black_token ${g.black_token}`);
  console.log(`spectate    ${base.replace(/\/+$/, '')}/?game=${g.game_id}`);
  console.log(`\nnode bot/random_bot.mjs ${base} ${g.game_id} ${g.white_token}`);
  console.log(`node bot/random_bot.mjs ${base} ${g.game_id} ${g.black_token}`);
  process.exit(0);
}

const id = idOrNew;
const token = arg3;
let s = await call(`/${id}`);
let me = null;

while (s.status === 'ongoing') {
  // Our turn is detected by trying: the server tells us which side the token is via not_your_turn.
  if (me === null || s.turn === me) {
    const chess = new Chess(s.fen);
    const moves = chess.moves({ verbose: true });
    const pick = moves[Math.floor(Math.random() * moves.length)].lan;
    try {
      s = await call(`/${id}/move`, { method: 'POST', body: { token, move: pick }, token });
      me ??= s.turn === 'white' ? 'black' : 'white';
      console.log(`${String(s.ply).padStart(3)} ${me} ${s.moves.at(-1).san}`);
      continue;
    } catch (e) {
      if (e.status !== 409 || !/not_your_turn/.test(e.message)) throw e;
      me = s.turn === 'white' ? 'black' : 'white';
    }
  }
  try {
    s = await call(`/${id}/wait?since=${s.ply}`, { token });
  } catch (e) {
    console.error(`wait failed (${e.message}), retrying`);
    await new Promise((r) => setTimeout(r, 1000));
    s = await call(`/${id}`);
  }
}
console.log(`game over: ${s.status} ${s.result}${s.reason ? ` (${s.reason})` : ''} after ${s.ply} plies`);
