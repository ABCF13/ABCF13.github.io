/*
 * ascii-player.js - plays ASCV1 clip files (made by ascii_conv) in a <pre>.
 *
 *   const p = new AsciiPlayer(document.getElementById('bg'));
 *   await p.load('clips/clip_001.txt');
 *   p.play();                 // free-running clock
 *   p.seek(73.5);             // jump to 73.5 s (use for Spotify sync)
 *   p.setClock(() => spotifySeconds());  // or slave it to any external clock
 */
const HEADER_LEN = 64;

class AsciiPlayer {
  constructor(pre, { loop = true } = {}) {
    this.pre = pre;
    this.loop = loop;
    this.data = null;
    this.clock = null;       // optional external clock: () => seconds
    this.offset = 0;         // seconds, used by the internal clock
    this.startedAt = null;   // performance.now() when playing
    this.raf = 0;
    this.lastIndex = -1;
  }

  get playing() { return this.raf !== 0; }

  async load(url) {
    const res = await fetch(url);               // server gzip/brotli is transparent
    if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
    const text = await res.text();
    const [magic, id, w, h, fps, frames] = text.slice(0, HEADER_LEN).trim().split(/\s+/);
    if (magic !== 'ASCV1') throw new Error('Not an ASCV1 file');
    this.id = id;
    this.w = +w; this.h = +h; this.fps = +fps; this.frames = +frames;
    this.n = this.w * this.h;                   // chars per frame
    this.data = text;
    this.duration = this.frames / this.fps;
    this.lastIndex = -1;
    this.offset = 0;
    this.render(0);
    return this;
  }

  /** Raw frame i as a string with newlines inserted at row boundaries. */
  frameText(i) {
    const start = HEADER_LEN + i * this.n;
    const rows = new Array(this.h);
    for (let y = 0; y < this.h; y++) {
      const s = start + y * this.w;
      rows[y] = this.data.slice(s, s + this.w);
    }
    return rows.join('\n');
  }

  render(i) {
    if (i === this.lastIndex) return;           // nothing changed, skip DOM work
    this.lastIndex = i;
    this.pre.textContent = this.frameText(i);
  }

  /** Current time in seconds from whichever clock is active. */
  now() {
    if (this.clock) return this.clock();
    if (this.startedAt === null) return this.offset;
    return this.offset + (performance.now() - this.startedAt) / 1000;
  }

  /** "AAAMMSSFF" tag for the current moment, matching your original format. */
  timecode() {
    const t = this.now();
    const i = this.indexAt(t);
    const mm = Math.floor(t / 60), ss = Math.floor(t % 60), ff = i % this.fps;
    const p = (v, l) => String(v).padStart(l, '0');
    return `${this.id}${p(mm, 2)}${p(ss, 2)}${p(ff, 2)}`;
  }

  indexAt(t) {
    let i = Math.floor(t * this.fps);
    if (this.loop) i = ((i % this.frames) + this.frames) % this.frames;
    else i = Math.max(0, Math.min(this.frames - 1, i));
    return i;
  }

  setClock(fn) { this.clock = fn; }

  seek(seconds) {
    this.offset = seconds;
    if (this.startedAt !== null) this.startedAt = performance.now();
    this.render(this.indexAt(seconds));
  }

  /** Time folded into the clip's length (matches how frames loop). */
  wrap(t) {
    if (!this.loop) return Math.max(0, Math.min(t, this.duration));
    return ((t % this.duration) + this.duration) % this.duration;
  }

  play() {
    if (this.raf || !this.data) return;
    if (this.startedAt === null) this.startedAt = performance.now();
    const tick = () => {
      const t = this.now();
      this.render(this.indexAt(t));             // frame chosen from time, never drifts
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  pause() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.startedAt !== null) {
      this.offset = this.now();
      this.startedAt = null;
    }
  }
}

/*
 * Jukebox - playlist + transport controls. Everything goes through run(),
 * which takes a command string and returns a status message, so the same
 * calls work from buttons now and from a terminal prompt later.
 *
 *   const jb = new Jukebox(player, { dir: 'clips' });
 *   await jb.init();                 // reads clips/playlist.json, starts playing
 *   await jb.run('skip 10');         // also: back [n], pause, play, toggle, next, prev,
 *                                    //       seek <sec|m:ss>, goto <id>, list, status
 */
class Jukebox {
  constructor(player, { dir = 'clips', fallback = ['001'] } = {}) {
    this.player = player;
    this.dir = dir;
    this.playlist = fallback;
    this.index = 0;
    this.busy = false;
  }

  get id() { return this.playlist[this.index]; }

  static fmt(s) {
    s = Math.max(0, Math.floor(s));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  async init() {
    try {
      const res = await fetch(`${this.dir}/playlist.json`);
      if (res.ok) {
        const list = (await res.json()).clips;
        if (Array.isArray(list) && list.length) this.playlist = list.map(String);
      }
    } catch (e) { console.warn('No playlist.json, using default list', e); }
    await this.load(0);
    this.player.play();
  }

  /** Load playlist entry i (wraps around). Keeps the paused/playing state. */
  async load(i) {
    const n = this.playlist.length;
    const idx = ((i % n) + n) % n;
    const id = this.playlist[idx];
    await this.player.load(`${this.dir}/clip_${id}.txt`);
    this.index = idx;
    this.player.seek(0);                       // also restarts the clock if playing
    return `now on ${id}`;
  }

  async go(i) {
    if (this.busy) return 'busy loading';
    this.busy = true;
    try { return await this.load(i); } finally { this.busy = false; }
  }

  skip(sec) {
    const p = this.player;
    const t = p.wrap(p.now()) + sec;
    if (t >= p.duration) return this.go(this.index + 1);   // skipped past the end
    const to = Math.max(0, t);
    p.seek(to);
    return `at ${Jukebox.fmt(to)}`;
  }

  _num(arg, dflt) {
    const n = arg === undefined ? dflt : Number(arg);
    if (!Number.isFinite(n) || n < 0) throw new Error('expected a positive number');
    return n;
  }

  _time(arg) {
    if (!arg) throw new Error('usage: seek <seconds | m:ss>');
    const parts = arg.split(':').map(Number);
    if (parts.some(Number.isNaN)) throw new Error('bad time: ' + arg);
    return parts.reduce((a, v) => a * 60 + v, 0);
  }

  status() {
    const p = this.player;
    const t = p.wrap(p.now());
    return `${this.id}  ${Jukebox.fmt(t)} / ${Jukebox.fmt(p.duration)}  ` +
           (p.playing ? 'playing' : 'paused');
  }

  /** Run one command line. Always resolves to a message string. */
  async run(line) {
    const [cmd, ...args] = String(line).trim().toLowerCase().split(/\s+/);
    const p = this.player;
    try {
      switch (cmd) {
        case 'play':   p.play();  return 'playing';
        case 'pause':  p.pause(); return 'paused';
        case 'toggle': p.playing ? p.pause() : p.play(); return p.playing ? 'playing' : 'paused';
        case 'skip':   return await this.skip(this._num(args[0], 10));
        case 'back':   return await this.skip(-this._num(args[0], 10));
        case 'next':   return await this.go(this.index + 1);
        case 'prev':   return await this.go(this.index - 1);
        case 'goto': {
          const i = this.playlist.indexOf(String(args[0]).padStart(3, '0'));
          if (i < 0) return `no such clip: ${args[0]}`;
          return await this.go(i);
        }
        case 'seek': {
          const to = Math.min(this._time(args[0]), p.duration - 0.1);
          p.seek(to);
          return `at ${Jukebox.fmt(to)}`;
        }
        case 'list':   return this.playlist.map((id, i) => (i === this.index ? '* ' : '  ') + id).join('\n');
        case 'status': return this.status();
        case 'help':   return 'play pause toggle skip [n] back [n] next prev seek <t> goto <id> list status';
        default:       return `unknown command: ${cmd} (try "help")`;
      }
    } catch (e) { return `error: ${e.message}`; }
  }
}

if (typeof module !== 'undefined') module.exports = { AsciiPlayer, Jukebox };
