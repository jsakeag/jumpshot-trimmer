import { KINDS, clamp, esc, fmt } from './util.js';

// Track heights, in CSS pixels. The ruler, filmstrip and waveform are one canvas the width of
// the view (a canvas as wide as a long video at full zoom would be too big), redrawn on scroll.
const RULER = 22, FILM = 48, WAVE = 36, TOP = RULER + FILM + WAVE, LANE = 26, MIN_LANES = 3;
const SNAP = 8;      // edges snap to the playhead within this many pixels
const MAX_ZOOM = 400; // pixels per second
const STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200];

/*
 * The timeline under the preview: a time ruler, the video's filmstrip and loudness, and the
 * annotations in lanes. Click or drag in the top tracks to scrub; drag an annotation to move it,
 * or its ends to trim it. It draws what it's given and reports edits through the callbacks:
 *   seek(t), scrub(active), select(id), edit(id, start, end, phase) with phase 'start' | 'move' | 'end',
 *   play(id) on double-click.
 */
export class Timeline {
  constructor(el, duration, cb) {
    this.duration = Math.max(0.1, duration);
    this.cb = cb;
    this.anns = [];
    this.els = new Map();  // annotation id -> element, reused so a drag survives re-renders
    this.time = 0;
    this.media = null;
    el.innerHTML = `
      <div class="tl-bar">
        <span class="tl-title">Timeline</span>
        <span class="meta" id="tl-media"></span>
        <span class="grow"></span>
        <button class="icon" data-z="out" title="Zoom out (−)">−</button>
        <input type="range" class="tl-zoom" min="0" max="1000" value="0" aria-label="Zoom">
        <button class="icon" data-z="in" title="Zoom in (=)">+</button>
        <button class="btn small" data-z="fit" title="Fit the whole video (0)">Fit</button>
      </div>
      <div class="tl-scroll">
        <div class="tl-inner">
          <canvas class="tl-canvas"></canvas>
          <div class="tl-anns"></div>
          <div class="tl-playhead"></div>
        </div>
      </div>`;
    this.scroll = el.querySelector('.tl-scroll');
    this.inner = el.querySelector('.tl-inner');
    this.canvas = el.querySelector('.tl-canvas');
    this.annsEl = el.querySelector('.tl-anns');
    this.playhead = el.querySelector('.tl-playhead');
    this.slider = el.querySelector('.tl-zoom');
    this.mediaNote = el.querySelector('#tl-media');

    el.querySelector('.tl-bar').addEventListener('click', e => {
      const z = e.target.closest('[data-z]')?.dataset.z;
      if (z === 'in') this.zoomBy(1.6);
      else if (z === 'out') this.zoomBy(1 / 1.6);
      else if (z === 'fit') this.fit();
    });
    this.slider.addEventListener('input', () => {
      const lo = Math.log(this.minZoom()), hi = Math.log(MAX_ZOOM);
      this.setZoom(Math.exp(lo + (hi - lo) * this.slider.value / 1000), this.time);
    });
    this.scroll.addEventListener('scroll', () => this.redraw());
    this.scroll.addEventListener('wheel', e => {
      if (!e.ctrlKey && !e.metaKey) return;  // pinch on a trackpad arrives as ctrl+wheel
      e.preventDefault();
      this.setZoom(this.zoom * Math.exp(-e.deltaY * 0.01), this.timeAt(e.clientX), e.clientX);
    }, { passive: false });
    this.scroll.addEventListener('pointerdown', e => this.onPointerDown(e));
    this.scroll.addEventListener('dblclick', e => {
      const id = e.target.closest('.ann')?.dataset.id;
      if (id) cb.play(id);
    });
    new ResizeObserver(() => {
      if (this.zoom < this.minZoom()) this.zoom = this.minZoom();
      this.layout();
    }).observe(this.scroll);

    this.zoom = this.minZoom();
    this.layout();
  }

  minZoom() { return Math.max(1e-3, (this.scroll.clientWidth - 2) / this.duration); }

  timeAt(clientX) {
    return clamp((clientX - this.inner.getBoundingClientRect().left) / this.zoom, 0, this.duration);
  }

  setZoom(z, anchorT = this.time, anchorX = null) {
    const viewX = anchorX != null ? anchorX - this.scroll.getBoundingClientRect().left : anchorT * this.zoom - this.scroll.scrollLeft;
    this.zoom = clamp(z, this.minZoom(), MAX_ZOOM);
    this.layout();
    this.scroll.scrollLeft = anchorT * this.zoom - viewX;
    this.redraw();
  }

  zoomBy(f) {
    const visible = this.time * this.zoom >= this.scroll.scrollLeft && this.time * this.zoom <= this.scroll.scrollLeft + this.scroll.clientWidth;
    this.setZoom(this.zoom * f, visible ? this.time : (this.scroll.scrollLeft + this.scroll.clientWidth / 2) / this.zoom);
  }

  fit() { this.setZoom(this.minZoom(), 0, this.scroll.getBoundingClientRect().left); }

  // Show a region (an annotation) if it's out of view, zooming out if it doesn't fit.
  reveal(start, end) {
    const w = this.scroll.clientWidth;
    if ((end - start) * this.zoom > w * 0.9) this.setZoom(w * 0.8 / (end - start), start);
    const x0 = start * this.zoom, x1 = end * this.zoom, left = this.scroll.scrollLeft;
    if (x0 < left || x1 > left + w) this.scroll.scrollLeft = x0 - w * 0.2;
  }

  setMedia(media, film, wave) {
    this.media = media;
    this.film = film;
    this.wave = wave;
    this.redraw();
  }

  setMediaNote(text) { this.mediaNote.textContent = text; }

  layout() {
    this.inner.style.width = `${Math.ceil(this.duration * this.zoom)}px`;
    const lo = Math.log(this.minZoom()), hi = Math.log(MAX_ZOOM);
    this.slider.value = hi > lo ? Math.round((Math.log(this.zoom) - lo) / (hi - lo) * 1000) : 0;
    this.renderAnns();
    this.setTime(this.time, false);
    this.redraw();
  }

  // anns: [{id, kind, start, end, maybe, tags}], plus opts.selected, opts.dim (ids), opts.live (one being marked)
  setAnnotations(anns, opts = {}) {
    this.anns = anns;
    this.opts = opts;
    this.renderAnns();
  }

  renderAnns() {
    const opts = this.opts || {};
    const list = opts.live ? [...this.anns, { ...opts.live, id: '__live', tags: [] }] : this.anns;
    // greedy lanes: each annotation goes in the first lane that's free by its start
    const ends = [], lanes = new Map();
    for (const a of [...list].sort((a, b) => a.start - b.start)) {
      let lane = ends.findIndex(e => e <= a.start + 1e-3);
      if (lane < 0) lane = ends.length;
      ends[lane] = a.end;
      lanes.set(a.id, lane);
    }
    const nLanes = Math.max(MIN_LANES, ends.length);
    this.annsEl.style.height = `${nLanes * LANE + 8}px`;
    this.inner.style.height = `${TOP + nLanes * LANE + 8}px`;

    const seen = new Set();
    for (const a of list) {
      seen.add(a.id);
      let el = this.els.get(a.id);
      if (!el) {
        el = document.createElement('div');
        el.dataset.id = a.id;
        this.annsEl.appendChild(el);
        this.els.set(a.id, el);
      }
      const k = KINDS[a.kind];
      el.className = `ann${a.maybe ? ' maybe' : ''}${a.id === opts.selected ? ' sel' : ''}${opts.dim?.has(a.id) ? ' dim' : ''}${a.id === '__live' ? ' live' : ''}`;
      el.style.left = `${a.start * this.zoom}px`;
      el.style.width = `${Math.max(2, (a.end - a.start) * this.zoom)}px`;
      el.style.top = `${4 + lanes.get(a.id) * LANE}px`;
      el.style.setProperty('--c', k.color);
      const tag = a.tags[0] ? ` · ${a.tags[0].name}${a.tags.length > 1 ? ` +${a.tags.length - 1}` : ''}` : '';
      const html = `<i class="h l"></i><span>${esc(k.short)}${esc(tag)}</span><i class="h r"></i>`;
      if (el.innerHTML !== html) el.innerHTML = html;
      el.title = `${k.label}${a.maybe ? ' (maybe)' : ''} ${fmt(a.start, true)}–${fmt(a.end, true)}${a.tags.map(t => `\n${t.name}: ${t.score}`).join('')}`;
    }
    for (const [id, el] of this.els) {
      if (!seen.has(id)) { el.remove(); this.els.delete(id); }
    }
  }

  // follow: keep the playhead in view (while playing)
  setTime(t, follow = false) {
    this.time = t;
    const x = t * this.zoom;
    this.playhead.style.transform = `translateX(${x}px)`;
    if (follow && !this.dragging) {
      const left = this.scroll.scrollLeft, w = this.scroll.clientWidth;
      if (x > left + w - 30 || x < left) this.scroll.scrollLeft = x - 30;
    }
  }

  redraw() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = null; this.draw(); });
  }

  draw() {
    const c = this.canvas, dpr = devicePixelRatio || 1, w = this.scroll.clientWidth;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(TOP * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(TOP * dpr);
      c.style.width = `${w}px`;
      c.style.height = `${TOP}px`;
    }
    const g = c.getContext('2d'), css = getComputedStyle(this.scroll);
    const fg = css.getPropertyValue('--muted').trim(), line = css.getPropertyValue('--line').trim();
    const left = this.scroll.scrollLeft, z = this.zoom;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, TOP);
    g.fillStyle = css.getPropertyValue('--track').trim();
    g.fillRect(0, RULER, w, FILM + WAVE);

    // ruler: labeled ticks at least 80px apart, small ticks between
    const step = STEPS.find(s => s * z >= 80) ?? STEPS[STEPS.length - 1];
    const per = step >= 60 ? 4 : step === 15 ? 3 : step === 0.2 ? 2 : 5, minor = step / per;
    g.strokeStyle = line;
    g.fillStyle = fg;
    g.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    g.beginPath();
    const t0 = left / z, t1 = (left + w) / z;
    for (let i = Math.floor(t0 / minor); i * minor <= t1; i++) {
      const t = i * minor, x = Math.round(t * z - left) + 0.5, major = i % per === 0;
      g.moveTo(x, major ? 6 : 15);
      g.lineTo(x, RULER);
      if (major) g.fillText(fmt(t, step < 1), x + 3, 12);
    }
    g.stroke();

    // filmstrip: thumbnails side by side, each showing the moment at its left edge
    const m = this.media;
    if (m && this.film?.complete && this.film.naturalWidth) {
      const tw = m.thumb_w * FILM / m.thumb_h;
      for (let x = Math.floor(left / tw) * tw; x < left + w; x += tw) {
        const i = Math.min(m.count - 1, Math.floor(x / z / m.interval));
        g.drawImage(this.film, (i % m.cols) * m.thumb_w, Math.floor(i / m.cols) * m.thumb_h, m.thumb_w, m.thumb_h,
          x - left, RULER, tw, FILM);
      }
    }

    // loudness: the loudest moment under each pixel
    if (m && this.wave?.length) {
      const mid = RULER + FILM + WAVE / 2, perPx = 1 / z / m.wave_step;
      g.fillStyle = css.getPropertyValue('--wave').trim();
      for (let px = 0; px < w; px++) {
        const a = Math.floor((left + px) / z / m.wave_step), b = Math.max(a + 1, Math.floor(a + perPx));
        let peak = 0;
        for (let i = a; i < b && i < this.wave.length; i++) if (this.wave[i] > peak) peak = this.wave[i];
        const h = peak / 255 * (WAVE / 2 - 2);
        if (h > 0.3) g.fillRect(px, mid - h, 1, h * 2);
      }
    }

    g.fillStyle = line;
    g.fillRect(0, RULER - 1, w, 1);
    g.fillRect(0, RULER + FILM, w, 1);
    g.fillRect(0, TOP - 1, w, 1);
  }

  // ---- pointer: scrub, select, move, trim

  onPointerDown(e) {
    if (e.button !== 0) return;
    const annEl = e.target.closest('.ann');
    if (annEl && annEl.dataset.id !== '__live') return this.dragAnn(e, annEl);
    if (e.target === this.canvas || e.target === this.annsEl || e.target === this.scroll || e.target === this.inner) {
      if (e.target === this.annsEl) this.cb.select(null);
      this.scrub(e);
    }
  }

  scrub(e) {
    e.preventDefault();
    this.dragging = true;
    this.cb.scrub(true);
    this.cb.seek(this.timeAt(e.clientX));
    const move = ev => this.cb.seek(this.timeAt(ev.clientX));
    const up = () => {
      this.dragging = false;
      this.cb.scrub(false);
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }

  dragAnn(e, el) {
    e.preventDefault();
    const a = this.anns.find(x => x.id === el.dataset.id);
    if (!a) return;
    const h = e.target.closest('.h'), mode = !h ? 'move' : h.classList.contains('l') ? 'start' : 'end';
    const x0 = e.clientX, s0 = a.start, e0 = a.end;
    let started = false;
    this.cb.select(a.id);
    const snap = t => Math.abs(t - this.time) * this.zoom < SNAP ? this.time : t;
    const move = ev => {
      if (!started && Math.abs(ev.clientX - x0) < 3) return;
      if (!started) { started = true; this.dragging = true; this.cb.edit(a.id, s0, e0, 'start'); }
      const dt = (ev.clientX - x0) / this.zoom;
      let start = s0, end = e0;
      if (mode === 'start') start = clamp(snap(s0 + dt), 0, e0 - 0.1);
      else if (mode === 'end') end = clamp(snap(e0 + dt), s0 + 0.1, this.duration);
      else {
        start = clamp(s0 + dt, 0, this.duration - (e0 - s0));
        const snapped = snap(start), snappedEnd = snap(start + e0 - s0);
        if (snapped !== start) start = snapped;
        else if (snappedEnd !== start + e0 - s0) start = snappedEnd - (e0 - s0);
        end = start + (e0 - s0);
      }
      this.cb.edit(a.id, start, end, 'move');
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      if (started) { this.dragging = false; this.cb.edit(a.id, null, null, 'end'); }
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }
}

