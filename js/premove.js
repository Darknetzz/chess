// Premoves: moves queued during the opponent's turn. Destinations are geometric (pieces may still be in
// the way, as in lichess/chessground); legality is checked only when a premove is about to be played.

const FILES = 'abcdefgh';
const at = (f, r) => (f >= 0 && f < 8 && r >= 0 && r < 8 ? FILES[f] + (r + 1) : null);
const LINES = { r: [[1, 0], [-1, 0], [0, 1], [0, -1]], b: [[1, 1], [1, -1], [-1, 1], [-1, -1]] };
LINES.q = [...LINES.r, ...LINES.b];
const KNIGHT = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];

/**
 * Squares the piece on `square` could premove to, as fake verbose moves ({ from, to, color, flags, promotion? })
 * so the board's hint / promotion code can use them. `pieces` is the predicted position (square -> {type, color}).
 */
export function premoveDests(pieces, square) {
  const p = pieces[square];
  if (!p) return [];
  const f = FILES.indexOf(square[0]);
  const r = Number(square[1]) - 1;
  const out = new Set();
  const step = (df, dr) => out.add(at(f + df, r + dr));
  if (p.type === 'n') KNIGHT.forEach(([df, dr]) => step(df, dr));
  else if (p.type === 'k') {
    for (const [df, dr] of LINES.q) step(df, dr);
    const home = p.color === 'w' ? 0 : 7;
    if (f === 4 && r === home) {
      // Castling: king's target squares; the rook must still be on its corner (in the predicted position).
      for (const [rookFile, kingFile] of [[7, 6], [0, 2]]) {
        const rook = pieces[at(rookFile, home)];
        if (rook?.type === 'r' && rook.color === p.color) out.add(at(kingFile, home));
      }
    }
  } else if (p.type === 'p') {
    const dir = p.color === 'w' ? 1 : -1;
    step(0, dir);
    if (r === (p.color === 'w' ? 1 : 6)) step(0, 2 * dir);
    step(-1, dir);
    step(1, dir);
  } else {
    for (const [df, dr] of LINES[p.type]) for (let i = 1; i < 8; i++) step(df * i, dr * i);
  }
  out.delete(null);
  const lastRank = p.color === 'w' ? '8' : '1';
  return [...out]
    .filter((to) => pieces[to]?.color !== p.color)
    .map((to) => ({
      from: square,
      to,
      color: p.color,
      flags: p.type === 'k' && Math.abs(FILES.indexOf(to[0]) - f) === 2 ? (to[0] === 'g' ? 'k' : 'q') : 'n',
      ...(p.type === 'p' && to[1] === lastRank ? { promotion: 'q' } : {}),
    }));
}

/** Position after playing the queued premoves on `pieces` (no legality checks). */
export function applyPremoves(pieces, queue) {
  const out = { ...pieces };
  for (const { from, to, promotion } of queue) {
    const p = out[from];
    if (!p) continue;
    delete out[from];
    if (p.type === 'k' && Math.abs(FILES.indexOf(to[0]) - FILES.indexOf(from[0])) === 2) {
      const rank = from[1];
      const [rf, rt] = to[0] === 'g' ? ['h', 'f'] : ['a', 'd'];
      const rook = out[rf + rank];
      delete out[rf + rank];
      if (rook) out[rt + rank] = rook;
    }
    // En passant is not predicted: the captured pawn simply stays until the move is really played.
    out[to] = promotion ? { type: promotion, color: p.color } : p;
  }
  return out;
}
