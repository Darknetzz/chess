#!/usr/bin/env node
// Example bot: plays random legal moves via the bot API. No npm deps; uses the repo's vendored chess.js.
//   node bot/random_bot.mjs <base_url> --new [move_time_ms]   create a game, print tokens + spectate URL
//   node bot/random_bot.mjs <base_url> <game_id> <token>       play the token's side until the game ends
import { Chess } from '../vendor/chess.js/chess.js';

const [base, a, b] = process.argv.slice(2);
if (!base || !a) {
  console.error('usage: random_bot.mjs <base_url> --new [move_time_ms] | <base_url> <game_id> <token>');
  process.exit(2);
}
const api = (path, { method = 'GET', body, token } = {}) =>
  fetch(new URL(`/api/games${path}`, base), {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body && JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, data: await r.json() }));

if (a === '--new') {
  const { status, data } = await api('', { method: 'POST', body: b ? { move_time_ms: Number(b) } : {} });
  if (status !== 201) throw new Error(data.message);
  const spectate = new URL(`/?game=${data.game_id}`, base);
  console.log(`game_id      ${data.game_id}
white_token  ${data.white_token}
black_token  ${data.black_token}
move_time_ms ${data.move_time_ms}
spectate     ${spectate}
play white   ${spectate}#token=${data.white_token}

node bot/random_bot.mjs ${base} ${data.game_id} ${data.white_token}
node bot/random_bot.mjs ${base} ${data.game_id} ${data.black_token}`);
  process.exit(0);
}

const [id, token] = [a, b];
let { status, data: s } = await api(`/${id}`, { token });
if (status !== 200) throw new Error(s.message);
const me = s.you;
console.log(`playing ${me} in ${id}`);

while (s.status === 'ongoing') {
  if (s.turn !== me) {
    ({ data: s } = await api(`/${id}/wait?since=${s.ply}`, { token }));
    continue;
  }
  const legal = new Chess(s.fen).moves({ verbose: true }).map((m) => m.lan);
  const move = legal[Math.floor(Math.random() * legal.length)];
  const r = await api(`/${id}/move`, { method: 'POST', body: { token, move } });
  if (r.status !== 200) throw new Error(`${move}: ${r.data.message}`);
  s = r.data;
  console.log(`${s.ply}. ${s.moves.at(-1).san}`);
}
console.log(`game over: ${s.status} ${s.result}${s.reason ? ` (${s.reason})` : ''}`);
