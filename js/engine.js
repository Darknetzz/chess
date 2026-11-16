// Thin promise wrapper around the Stockfish WASM web worker (UCI protocol).

/**
 * Bot strength curve: { depth, ms } for Skill Level 0–20. Levels 0–15 keep the original depth = level + 1;
 * 16–20 get deeper caps and more time so the top levels are limited by time, not depth.
 * Mirrored in bot/engine.mjs (server-side bot).
 */
export function botSearch(lvl) {
  return lvl <= 15
    ? { depth: lvl + 1, ms: 50 + lvl * 50 }
    : { depth: 16 + (lvl - 15) * 3, ms: 800 + (lvl - 15) * 340 };
}

export class Engine {
  constructor(url) {
    this.url = url;
    this.worker = null;
    this.readyPromise = null;
    this.pending = null;      // { resolve } for the active search
    this.staleBestmoves = 0;  // bestmove replies to ignore after a 'stop'
    this.searching = false;
  }

  init() {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise((resolve, reject) => {
      try {
        this.worker = new Worker(this.url);
      } catch (err) {
        reject(err);
        return;
      }
      this.worker.onerror = (e) => reject(e.message || e);
      this.worker.onmessage = (e) => {
        const line = typeof e.data === 'string' ? e.data : String(e.data ?? '');
        if (line === 'uciok') this.send('isready');
        else if (line === 'readyok') resolve();
        else if (line.startsWith('bestmove')) this._onBestmove(line);
        else if (this.pending?.score && line.startsWith('info') && !/\b(lowerbound|upperbound)\b/.test(line)) {
          const m = /\bscore (cp|mate) (-?\d+)/.exec(line);
          if (m) this.pending.score = m[1] === 'cp' ? { cp: +m[2], mate: null } : { cp: null, mate: +m[2] };
        }
      };
      this.send('uci');
    });
    return this.readyPromise;
  }

  send(cmd) {
    this.worker?.postMessage(cmd);
  }

  _onBestmove(line) {
    // A stale reply belongs to a stopped search: the current one (if any) is still running.
    if (this.staleBestmoves > 0) {
      this.staleBestmoves--;
      return;
    }
    this.searching = false;
    const move = line.split(/\s+/)[1];
    const p = this.pending;
    this.pending = null;
    if (p?.score) p.resolve(p.score);
    else p?.resolve(move && move !== '(none)' ? move : null);
  }

  async newGame() {
    await this.init();
    this.cancel();
    this.send('ucinewgame');
  }

  // Resolves with a UCI move string ("e2e4", "e7e8q") or null if cancelled / no move.
  // capMs (optional) caps the search time, e.g. to stay inside a running clock.
  async bestMove(fen, level, capMs) {
    await this.init();
    this.cancel();
    const lvl = Math.max(0, Math.min(20, level | 0));
    return new Promise((resolve) => {
      this.pending = { resolve };
      this.send(`setoption name Skill Level value ${lvl}`);
      this.send(`position fen ${fen}`);
      const s = botSearch(lvl);
      const ms = Math.max(20, Math.min(s.ms, capMs ?? Infinity));
      this.send(`go depth ${s.depth} movetime ${ms}`);
      this.searching = true;
    });
  }

  // Full-strength eval: { cp, mate } for the side to move, or null if cancelled.
  async evaluate(fen, ms = 1500) {
    await this.init();
    this.cancel();
    return new Promise((resolve) => {
      this.pending = { resolve, score: { cp: 0, mate: null } };
      this.send('setoption name Skill Level value 20');
      this.send(`position fen ${fen}`);
      this.send(`go depth 14 movetime ${ms}`);
      this.searching = true;
    });
  }

  cancel() {
    if (this.pending) {
      this.pending.resolve(null);
      this.pending = null;
    }
    if (this.searching) {
      this.staleBestmoves++;
      this.searching = false;
      this.send('stop');
    }
  }
}

/**
 * Continuous analysis on its own worker (full strength, independent of the bot).
 * analyze(fen, onUpdate) streams { depth, cp, mate, best } from White's point of view.
 */
export class Analyzer {
  constructor(url, depth = 28) {
    this.url = url;
    this.depth = depth;
    this.worker = null;
    this.readyPromise = null;
    this.searching = false;
    this.staleBestmoves = 0;
    this.job = null; // { fen, white, onUpdate, latest }
    this.frame = 0;
  }

  init() {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise((resolve, reject) => {
      try {
        this.worker = new Worker(this.url);
      } catch (err) {
        reject(err);
        return;
      }
      this.worker.onerror = (e) => reject(e.message || e);
      this.worker.onmessage = (e) => {
        const line = typeof e.data === 'string' ? e.data : String(e.data ?? '');
        if (line === 'uciok') {
          this.worker.postMessage('setoption name Hash value 64'); // deep searches thrash the default 16 MB
          this.worker.postMessage('isready');
        }
        else if (line === 'readyok') resolve();
        else if (line.startsWith('info ')) this._onInfo(line);
        else if (line.startsWith('bestmove')) this._onBestmove();
      };
      this.worker.postMessage('uci');
    });
    return this.readyPromise;
  }

  _onInfo(line) {
    if (this.staleBestmoves > 0 || !this.job) return;
    if (/\bmultipv (?!1\b)/.test(line) || /\b(lowerbound|upperbound)\b/.test(line)) return;
    const depth = /\bdepth (\d+)/.exec(line);
    const score = /\bscore (cp|mate) (-?\d+)/.exec(line);
    const pv = /\bpv ([a-h][1-8][a-h][1-8][qrbn]?)/.exec(line);
    if (!depth || !score || !pv) return;
    const sign = this.job.white ? 1 : -1;
    const n = sign * Number(score[2]);
    this.job.latest = {
      depth: Number(depth[1]),
      cp: score[1] === 'cp' ? n : null,
      mate: score[1] === 'mate' ? n : null,
      best: pv[1],
    };
    if (!this.frame) {
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        if (this.job?.latest) this.job.onUpdate(this.job.latest);
      });
    }
  }

  _onBestmove() {
    // A stale reply belongs to a stopped search: the current one is still running and must stay
    // stoppable, or its output would be taken for the next position's.
    if (this.staleBestmoves > 0) this.staleBestmoves--;
    else {
      this.searching = false;
      const job = this.job;
      if (!job) return;
      if (this.frame) { // deliver the final update first, so it can't land after onDone
        cancelAnimationFrame(this.frame);
        this.frame = 0;
        if (job.latest) job.onUpdate(job.latest);
      }
      job.onDone?.();
    }
  }

  /** onDone (optional) fires when the search reaches its target depth. */
  async analyze(fen, onUpdate, onDone) {
    this.stop();
    const job = { fen, white: fen.split(' ')[1] === 'w', onUpdate, onDone, latest: null };
    this.job = job;
    await this.init();
    if (this.job !== job) return; // superseded while the worker was loading
    this.worker.postMessage(`position fen ${fen}`);
    this.worker.postMessage(`go depth ${this.depth}`);
    this.searching = true;
  }

  stop() {
    this.job = null;
    if (this.searching) {
      this.staleBestmoves++;
      this.searching = false;
      this.worker?.postMessage('stop');
    }
  }

  /** Stop and free the worker (it is recreated on the next analyze()). */
  terminate() {
    this.stop();
    this.worker?.terminate();
    this.worker = null;
    this.readyPromise = null;
    this.searching = false;
    this.staleBestmoves = 0;
  }
}
