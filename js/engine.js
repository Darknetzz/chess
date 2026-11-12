// Thin promise wrapper around the Stockfish WASM web worker (UCI protocol).

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
      };
      this.send('uci');
    });
    return this.readyPromise;
  }

  send(cmd) {
    this.worker?.postMessage(cmd);
  }

  _onBestmove(line) {
    this.searching = false;
    if (this.staleBestmoves > 0) {
      this.staleBestmoves--;
      return;
    }
    const move = line.split(/\s+/)[1];
    const p = this.pending;
    this.pending = null;
    p?.resolve(move && move !== '(none)' ? move : null);
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
      const ms = Math.max(20, Math.min(50 + lvl * 50, capMs ?? Infinity));
      this.send(`go depth ${lvl + 1} movetime ${ms}`);
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
  constructor(url, depth = 20) {
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
        if (line === 'uciok') this.worker.postMessage('isready');
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
    this.searching = false;
    if (this.staleBestmoves > 0) this.staleBestmoves--;
  }

  async analyze(fen, onUpdate) {
    this.stop();
    const job = { fen, white: fen.split(' ')[1] === 'w', onUpdate, latest: null };
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
