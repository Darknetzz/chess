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

/** Threads the multi-threaded build can use here (SharedArrayBuffer needs a cross-origin isolated page). */
export function maxEngineThreads() {
  const isolated = globalThis.crossOriginIsolated === true && typeof SharedArrayBuffer === 'function';
  return isolated ? Math.max(1, navigator.hardwareConcurrency || 1) : 1;
}

/** Threads for a setting value: 0 = auto (all cores but one), else clamped to what's available. */
export function engineThreads(setting) {
  const max = maxEngineThreads();
  return setting > 0 ? Math.min(setting, max) : Math.max(1, max - 1);
}

/**
 * Continuous analysis on its own worker (full strength, independent of the bot).
 * analyze(fen, onUpdate) streams { depth, cp, mate, best } from White's point of view.
 * urls: { single, multi } builds; the multi-threaded one is used when more than one thread is available.
 */
export class Analyzer {
  constructor(urls, { depth = 28, threads = 0, hash = 128 } = {}) {
    this.urls = urls;
    this.depth = depth;
    this.threadSetting = threads;
    this.hash = hash;
    this.threads = 1; // threads of the running worker
    this.worker = null;
    this.readyPromise = null;
    this.searching = false;
    this.staleBestmoves = 0;
    this.job = null; // { fen, white, onUpdate, latest }
    this.frame = 0;
  }

  /**
   * Update search options. Returns true when the running search must restart (the worker is
   * recreated on the next analyze() if threads or hash changed).
   */
  configure({ depth, threads, hash }) {
    let restart = false;
    if (depth !== undefined && depth !== this.depth) {
      this.depth = depth;
      restart = true;
    }
    if ((threads !== undefined && threads !== this.threadSetting) || (hash !== undefined && hash !== this.hash)) {
      this.threadSetting = threads ?? this.threadSetting;
      this.hash = hash ?? this.hash;
      if (this.worker) this.terminate();
      restart = true;
    }
    return restart;
  }

  init() {
    if (this.readyPromise) return this.readyPromise;
    const threads = engineThreads(this.threadSetting);
    const start = (multi) => new Promise((resolve, reject) => {
      try {
        this.worker = new Worker(multi ? this.urls.multi : this.urls.single);
      } catch (err) {
        reject(err);
        return;
      }
      this.threads = multi ? threads : 1;
      this.worker.onerror = (e) => reject(e.message || e);
      this.worker.onmessage = (e) => {
        const line = typeof e.data === 'string' ? e.data : String(e.data ?? '');
        if (line === 'uciok') {
          if (multi) this.worker.postMessage(`setoption name Threads value ${threads}`);
          this.worker.postMessage(`setoption name Hash value ${this.hash}`);
          this.worker.postMessage('isready');
        }
        else if (line === 'readyok') resolve();
        else if (line.startsWith('info ')) this._onInfo(line);
        else if (line.startsWith('bestmove')) this._onBestmove();
      };
      this.worker.postMessage('uci');
    });
    const multi = threads > 1 && !!this.urls.multi;
    this.readyPromise = start(multi).catch((err) => {
      if (!multi) throw err;
      console.warn('Multi-threaded Stockfish failed, using the single-threaded build', err);
      this.worker?.terminate();
      return start(false);
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
