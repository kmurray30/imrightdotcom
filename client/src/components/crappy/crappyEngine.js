/**
 * Crappy's brain and renderer: a small state machine over the sprite
 * manifest plus a device-pixel-aware canvas loop. Framework-free so it can
 * be driven from React (CrappyPage) or anywhere else.
 *
 * States: loading → rest ⇄ uncurl → travel → curl → rest (or straight back
 * into uncurl when a click was queued during the curl).
 */
export const SCREEN_SCALE = 0.6; // sprite px → CSS px (384 px box → ~230 px)
export const SPEED = 420; // travel speed, CSS px per second
const MIN_TRAVEL_MS = 350;
const MAX_TRAVEL_MS = 2500;
const MIN_CYCLES_PER_SEC = 0.6;
const MAX_CYCLES_PER_SEC = 2.5;
const MAX_FRAME_DT = 50; // ms; clamps the first frame after a tab switch

export function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

export class CrappyEngine {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{ manifest: object, sheets: Record<string, HTMLImageElement>, hubs: Record<string, HTMLImageElement> }} sprites
   * @param {{ onState?: (state: string) => void, onFacing?: (facing: 1 | -1) => void, screenScale?: number }} [options]
   */
  constructor(canvas, sprites, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.manifest = sprites.manifest;
    this.sheets = sprites.sheets;
    this.hubs = sprites.hubs;
    this.onState = options.onState;
    this.onFacing = options.onFacing;
    this.scale = options.screenScale ?? SCREEN_SCALE;

    this.state = 'loading';
    this.stateStarted = 0;
    this.facing = 1;
    this.pos = null;
    this.from = null;
    this.target = null;
    this.queued = null;
    this.travelT = 0;
    this.travelMs = 0;
    this.phase = 0; // slither loop position, in cycles
    this.lastTick = 0;
    this.raf = 0;
    this.running = false;

    this.handleResize = () => this.resize();
    this.handlePointer = (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      event.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      this.setTarget(event.clientX - rect.left, event.clientY - rect.top);
    };
    this.handleVisibility = () => {
      if (document.hidden) this.pause();
      else if (this.running) this.resume();
    };
  }

  start() {
    this.running = true;
    this.resize();
    window.addEventListener('resize', this.handleResize);
    document.addEventListener('visibilitychange', this.handleVisibility);
    this.canvas.addEventListener('pointerdown', this.handlePointer);
    this.setState('rest');
    this.resume();
  }

  stop() {
    this.running = false;
    this.pause();
    window.removeEventListener('resize', this.handleResize);
    document.removeEventListener('visibilitychange', this.handleVisibility);
    this.canvas.removeEventListener('pointerdown', this.handlePointer);
  }

  pause() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  resume() {
    if (this.raf) return;
    this.lastTick = 0;
    this.raf = requestAnimationFrame((now) => this.tick(now));
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    this.width = width;
    this.height = height;
    this.canvas.width = Math.max(1, Math.round(width * dpr));
    this.canvas.height = Math.max(1, Math.round(height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!this.pos) this.pos = { x: width / 2, y: height * 0.6 };
    this.pos.x = Math.min(Math.max(this.pos.x, 0), width);
    this.pos.y = Math.min(Math.max(this.pos.y, 0), height);
    this.draw();
  }

  getState() {
    return this.state;
  }

  setState(state) {
    if (state === this.state) return;
    this.state = state;
    this.stateStarted = performance.now();
    this.onState?.(state);
  }

  setFacing(facing) {
    if (facing === this.facing) return;
    this.facing = facing;
    this.onFacing?.(facing);
  }

  faceTowards(x) {
    const dx = x - this.pos.x;
    if (Math.abs(dx) > 2) this.setFacing(dx < 0 ? -1 : 1);
  }

  /** Click handler: where Crappy should go next. */
  setTarget(x, y) {
    const target = { x, y };
    switch (this.state) {
      case 'rest':
        this.target = target;
        this.faceTowards(x);
        this.setState('uncurl');
        break;
      case 'uncurl':
        this.target = target;
        this.faceTowards(x);
        break;
      case 'travel':
        this.beginTravel(target);
        break;
      case 'curl':
        this.queued = target;
        break;
      default:
        break;
    }
  }

  beginTravel(target) {
    this.target = target;
    this.from = { x: this.pos.x, y: this.pos.y };
    const distance = Math.hypot(target.x - this.from.x, target.y - this.from.y);
    this.travelMs = Math.min(MAX_TRAVEL_MS, Math.max(MIN_TRAVEL_MS, (distance / SPEED) * 1000));
    this.travelT = 0;
    this.faceTowards(target.x);
    this.setState('travel');
  }

  clipFrame(name) {
    const clip = this.manifest.clips[name];
    const elapsed = performance.now() - this.stateStarted;
    const index = Math.floor((elapsed / 1000) * clip.fps);
    return { clip, index, done: index >= clip.frameCount };
  }

  tick(now) {
    this.raf = 0;
    if (!this.running) return;
    const dt = this.lastTick ? Math.min(now - this.lastTick, MAX_FRAME_DT) : 0;
    this.lastTick = now;
    this.update(dt);
    this.draw();
    this.raf = requestAnimationFrame((next) => this.tick(next));
  }

  update(dt) {
    switch (this.state) {
      case 'uncurl': {
        if (this.clipFrame('uncurl').done) this.beginTravel(this.target);
        break;
      }
      case 'travel': {
        const prev = { x: this.pos.x, y: this.pos.y };
        this.travelT = Math.min(1, this.travelT + dt / this.travelMs);
        const p = easeInOut(this.travelT);
        this.pos = {
          x: this.from.x + (this.target.x - this.from.x) * p,
          y: this.from.y + (this.target.y - this.from.y) * p,
        };
        const speed = dt > 0 ? (Math.hypot(this.pos.x - prev.x, this.pos.y - prev.y) / dt) * 1000 : 0;
        const slither = this.manifest.clips.slither;
        const travelPerCycle = (slither.travelPerCycle || 0) * this.scale;
        let cycles = travelPerCycle > 4 ? speed / travelPerCycle : speed / SPEED;
        cycles = Math.min(MAX_CYCLES_PER_SEC, Math.max(MIN_CYCLES_PER_SEC, cycles));
        this.phase += (cycles * dt) / 1000;
        if (this.travelT >= 1) {
          this.pos = { x: this.target.x, y: this.target.y };
          this.setState('curl');
        }
        break;
      }
      case 'curl': {
        if (this.clipFrame('curl').done) {
          if (this.queued) {
            const next = this.queued;
            this.queued = null;
            this.target = next;
            this.faceTowards(next.x);
            this.setState('uncurl');
          } else {
            this.setState('rest');
          }
        }
        break;
      }
      default:
        break;
    }
  }

  /** Which image and source rect to draw for the current state. */
  currentSprite() {
    const m = this.manifest;
    if (this.state === 'rest') {
      const hub = m.rest?.hub || 'curled';
      return { image: this.hubs[hub], sx: 0, sy: 0, w: m.frame.width, h: m.frame.height, anchor: m.anchor };
    }
    if (this.state === 'uncurl' || this.state === 'curl' || this.state === 'travel') {
      const name = this.state === 'travel' ? 'slither' : this.state;
      const clip = m.clips[name];
      let index;
      if (clip.loop) {
        const cycleFrames = Math.max(1, clip.frameCount - 1); // last frame duplicates the first
        index = Math.floor(this.phase * cycleFrames) % cycleFrames;
      } else {
        index = Math.min(clip.frameCount - 1, this.clipFrame(name).index);
      }
      return {
        image: this.sheets[name],
        sx: (index % clip.columns) * clip.frameWidth,
        sy: Math.floor(index / clip.columns) * clip.frameHeight,
        w: clip.frameWidth,
        h: clip.frameHeight,
        anchor: clip.anchor,
      };
    }
    return null;
  }

  draw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);
    const sprite = this.currentSprite();
    if (!sprite || !sprite.image || !this.pos) return;
    const s = this.scale;
    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);
    if (this.facing < 0) ctx.scale(-1, 1);
    ctx.drawImage(
      sprite.image,
      sprite.sx,
      sprite.sy,
      sprite.w,
      sprite.h,
      -sprite.anchor.x * s,
      -sprite.anchor.y * s,
      sprite.w * s,
      sprite.h * s
    );
    ctx.restore();
  }
}
