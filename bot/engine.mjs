// Server-side Stockfish for headless games: the vendored single-threaded WASM build run under Node,
// one child process per engine, spoken to over UCI on stdio. Capped in processes, depth and time.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const SF = fileURLToPath(new URL('../vendor/stockfish/stockfish-19-lite-single.js', import.meta.url));

class Proc {
  constructor() {
    this.child = spawn(process.execPath, [SF], { stdio: ['pipe', 'pipe', 'ignore'] });
    this.listener = null;
    this.dead = false;
    createInterface({ input: this.child.stdout }).on('line', (l) => this.listener?.(l.trim()));
    this.child.on('exit', () => {
      this.dead = true;
      this.listener?.('__exit__');
    });
    this.child.stdin.on('error', () => {}); // EPIPE after a crash surfaces through 'exit'
  }

  send(...lines) {
    if (!this.dead) this.child.stdin.write(lines.join('\n') + '\n');
  }

  /** Resolve with the first line matching `want` within `ms`, else reject. */
  until(want, ms) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => done(new Error('engine timeout')), ms);
      const done = (e, v) => {
        clearTimeout(t);
        this.listener = null;
        e ? reject(e) : resolve(v);
      };
      this.listener = (l) => {
        if (l === '__exit__') done(new Error('engine exited'));
        else if (want(l)) done(null, l);
      };
    });
  }

  kill() {
    this.dead = true;
    this.child.kill();
  }
}

/**
 * Pool of at most `maxProcs` engines with a FIFO queue.
 * bestMove(fen, level) resolves with a UCI move or null (no legal move).
 */
export function enginePool({ maxProcs = 2, maxDepth = 12, maxMs = 2000 } = {}) {
  const idle = [];
  const queue = [];
  let running = 0;

  async function fresh() {
    const p = new Proc();
    p.send('uci');
    await p.until((l) => l === 'uciok', 15_000);
    p.send('setoption name Threads value 1', 'setoption name Hash value 16', 'isready');
    await p.until((l) => l === 'readyok', 15_000);
    return p;
  }

  async function search(fen, level) {
    const lvl = Math.max(0, Math.min(20, level | 0));
    // Same strength curve as the browser bot (js/engine.js), clamped by the server caps.
    const depth = Math.min(lvl + 1, maxDepth);
    const ms = Math.min(50 + lvl * 50, maxMs);
    let p = idle.pop();
    if (!p || p.dead) p = await fresh();
    try {
      p.send(`setoption name Skill Level value ${lvl}`, 'ucinewgame', `position fen ${fen}`, `go depth ${depth} movetime ${ms}`);
      const line = await p.until((l) => l.startsWith('bestmove'), ms + 10_000);
      idle.push(p);
      const mv = line.split(/\s+/)[1];
      return mv && mv !== '(none)' ? mv : null;
    } catch (e) {
      p.kill();
      throw e;
    }
  }

  function pump() {
    while (running < maxProcs && queue.length) {
      const job = queue.shift();
      running++;
      search(job.fen, job.level)
        .then(job.resolve, job.reject)
        .finally(() => {
          running--;
          pump();
        });
    }
  }

  return {
    bestMove: (fen, level) =>
      new Promise((resolve, reject) => {
        queue.push({ fen, level, resolve, reject });
        pump();
      }),
    close: () => idle.splice(0).forEach((p) => p.kill()),
  };
}
