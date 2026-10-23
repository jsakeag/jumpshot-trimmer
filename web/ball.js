// Experimental: the ball's flight in 3D. Click four or more known points on the court once (that
// finds the camera), then the ball frame by frame; each flight between a hit and a bounce is fitted with
// gravity and air drag, drawn back on the video, and shown in a 3D view of the court.
// Kept apart from the annotations, in ball.json.

import { api, clamp, esc } from './util.js';
import { COURT, LANDMARKS, aimPoint, ballAt, calibrate, courtLines, cross, dot, fitTrack, ground, project, sub, unit } from './ballgeo.js';

const COLORS = ['#ffd43b', '#4dd4ff', '#ff8787', '#69db7c', '#da77f2', '#ffa94d'];
const SLOWMO = [1, 2, 4, 8];
const r3 = x => Math.round(x * 1000) / 1000;
const newId = () => `b-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const VIEWS = {  // orbits around the court: yaw from behind the near baseline, pitch up from the ground
  behind: { yaw: 0, pitch: 0.32, dist: 30, target: [0, 0, 0] },
  side: { yaw: Math.PI / 2, pitch: 0.15, dist: 30, target: [0, 0, 0] },
  top: { yaw: 0, pitch: 1.5, dist: 38, target: [0, 0, 0] },
};

// env: {base, vid, screen, svg, bar, view, tabs, layout() -> {p, z}, fps(), flash(text, ms), seek(t), onMode()}
export function ballTool(env) {
  const { base, vid } = env;
  const B = {
    data: { court: null, slowmo: 1, tracks: [] }, loaded: false,
    cur: 0,          // the track being edited
    mode: null,      // 'court' while placing court points, 'ball' while clicking the ball
    sel: null,       // the selected point
    pick: null,      // in court mode, the landmark the next click places
    view: 'video', orbit: { ...VIEWS.behind, lens: null },
    undo: [], ver: 0, key: null, dirty: false, saving: false,
    cal: undefined, calKey: null, fits: new Map(),
  };
  let saveTimer = null;

  api(`${base}/ball`).then(d => {
    B.data = d;
    B.cur = Math.max(0, d.tracks.length - 1);
    B.loaded = true;
    changed(false);
  }).catch(e => env.flash(`Couldn’t load the ball tracks: ${e.message}`));
  vid.addEventListener('loadedmetadata', () => changed(false));  // the camera needs the frame size

  // ---------------------------------------------------------------- derived: camera and fits

  // The calibration from the court points, or null with fewer than four; it may be {error}.
  function calib() {
    const c = B.data.court, W = vid.videoWidth, H = vid.videoHeight;
    if (!c || c.points.length < 4 || !W) return null;
    const key = JSON.stringify([c, W, H]);
    if (key !== B.calKey) { B.calKey = key; B.cal = calibrate(c.points, W, H); B.fits.clear(); }
    return B.cal;
  }
  const camera = () => { const c = calib(); return c && !c.error ? c : null; };

  function fits(tr) {
    const cam = camera();
    if (!cam) return [];
    const key = JSON.stringify([tr.points, B.data.slowmo]);
    let m = B.fits.get(tr.id);
    if (!m || m.key !== key) B.fits.set(tr.id, m = { key, fits: fitTrack(cam, tr.points, B.data.slowmo, env.fps()) });
    return m.fits;
  }

  const track = () => B.data.tracks[B.cur];
  const courtPoints = () => B.data.court?.points || [];
  // The next landmark to place after key: the next one not placed yet, in order.
  const nextPick = (key = null) => {
    const placed = new Set(courtPoints().map(p => p.k)), i = LANDMARKS.findIndex(l => l.key === key);
    return [...LANDMARKS.slice(i + 1), ...LANDMARKS.slice(0, i + 1)].find(l => !placed.has(l.key))?.key ?? null;
  };

  // ---------------------------------------------------------------- editing and saving

  function pushUndo() {
    B.undo.push(JSON.stringify(B.data));
    if (B.undo.length > 200) B.undo.shift();
  }

  function change(fn) {
    pushUndo();
    fn();
    changed();
  }

  function changed(save = true) {
    B.ver++;
    renderBar();
    if (save) scheduleSave();
  }

  function undo() {
    if (!B.undo.length) return env.flash('Nothing to undo');
    B.data = JSON.parse(B.undo.pop());
    B.sel = null;
    B.cur = clamp(B.cur, 0, Math.max(0, B.data.tracks.length - 1));
    changed();
    env.flash('Undone', 900);
  }

  function scheduleSave() {
    B.dirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 600);
  }

  async function saveNow() {
    clearTimeout(saveTimer);
    if (B.saving) return;
    B.saving = true;
    B.dirty = false;
    try { await api(`${base}/ball`, { method: 'PUT', json: B.data }); } catch (e) {
      B.dirty = true;
      env.flash(`Couldn’t save the ball tracks: ${e.message}`);
    }
    B.saving = false;
    if (B.dirty) scheduleSave();
  }

  function setMode(mode) {
    B.mode = mode;
    B.sel = null;
    if (mode === 'court') B.pick = nextPick();
    if (mode) { vid.pause(); if (B.view !== 'video') setView('video'); }
    env.screen.classList.toggle('balling', !!mode);
    env.onMode();
    changed(false);
  }

  function toggle() {
    if (B.mode) return setMode(null);
    if (!B.loaded) return env.flash('Still loading the ball tracks');
    setMode(camera() ? 'ball' : 'court');
  }

  function done() {
    const cal = calib();
    if (!cal) return env.flash('Place at least four points first');
    if (cal.error) return env.flash(cal.error, 3000);
    setMode('ball');
    env.flash('Court set. Now click the ball, frame by frame (← → step)', 2500);
  }

  function addPoint(x, y, ev) {
    const t = r3(vid.currentTime), half = 0.5 / env.fps();
    change(() => {
      if (!track()) { B.data.tracks.push({ id: newId(), points: [] }); B.cur = B.data.tracks.length - 1; }
      const q = { t, x, y, ...(ev ? { ev } : {}) };
      // one point per frame: clicking again on the same frame moves it
      track().points = [...track().points.filter(p => Math.abs(p.t - t) >= half), q].sort((a, b) => a.t - b.t);
      B.sel = q;
    });
  }

  // ⌫: the selected point (then the one before it), or in court mode the last corner.
  function removeSel() {
    if (B.mode === 'court') {
      const pts = courtPoints(), p = pts.find(x => x.k === B.pick) || pts.at(-1);
      if (!p) return;
      change(() => { B.data.court.points = pts.filter(x => x !== p); });
      B.pick = p.k;
      return renderBar();
    }
    const tr = track(), i = tr ? tr.points.indexOf(B.sel) : -1;
    if (i < 0) return env.flash('Click a point to select it');
    change(() => { tr.points.splice(i, 1); });
    B.sel = tr.points[Math.max(0, i - 1)] || null;
    B.ver++;
  }

  function newTrack() {
    if (track() && !track().points.length) return env.flash('This track is still empty');
    change(() => { B.data.tracks.push({ id: newId(), points: [] }); B.cur = B.data.tracks.length - 1; B.sel = null; });
    env.flash(`Track ${B.cur + 1}: click the ball`, 1200);
  }

  function goTrack(d) {
    const n = B.data.tracks.length;
    if (!n) return;
    B.cur = clamp(B.cur + d, 0, n - 1);
    B.sel = null;
    const first = track().points[0];
    if (first) env.seek(first.t);
    changed(false);
  }

  function deleteTrack() {
    const tr = track();
    if (!tr || (tr.points.length && !confirm(`Delete track ${B.cur + 1} and its ${tr.points.length} points?`))) return;
    change(() => {
      B.data.tracks.splice(B.cur, 1);
      B.cur = clamp(B.cur, 0, Math.max(0, B.data.tracks.length - 1));
      B.sel = null;
    });
  }

  // Keys while the tool is on; true if it took the key.
  function key(e) {
    if (!B.mode) return false;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const fn = {
      Escape: () => { if (B.sel) { B.sel = null; B.ver++; } else setMode(null); },
      Backspace: removeSel, Delete: removeSel,
      n: newTrack, '[': () => goTrack(-1), ']': () => goTrack(1),
      ...(B.mode === 'court' && { Enter: done }),
    }[k];
    if (!fn) return false;
    fn();
    return true;
  }

  // ---------------------------------------------------------------- on the video

  const toScreen = ([x, y], { p, z }) => [z.x + z.s * (p.x + x * p.w), z.y + z.s * (p.y + y * p.h)];

  function frameAt(e) {
    const r = vid.getBoundingClientRect(), { p, z } = env.layout();
    const f = v => Math.round(clamp(v, 0, 1) * 10000) / 10000;
    return [f(((e.clientX - r.left) / z.s - p.x) / p.w), f(((e.clientY - r.top) / z.s - p.y) / p.h)];
  }

  env.svg.addEventListener('pointerdown', e => {
    if (!B.mode || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    vid.pause();
    const g = e.target.closest('[data-i]');
    if (g) return drag(g);
    const [x, y] = frameAt(e);
    if (B.mode === 'ball') return addPoint(x, y, e.shiftKey ? 'bounce' : e.altKey ? 'hit' : null);
    if (!B.pick) return env.flash('Pick a point on the court map first');
    const k = B.pick;
    change(() => { B.data.court = { points: [...courtPoints().filter(p => p.k !== k), { k, x, y }] }; });
    B.pick = nextPick(k);
    renderBar();
  });

  // Drag a court or ball point to move it; a click on a ball point selects it and goes to its frame.
  function drag(g) {
    const i = Number(g.dataset.i), corner = g.dataset.kind === 'corner', q = corner ? courtPoints()[i] : track().points[i];
    if (corner) { B.pick = q.k; renderBar(); } else { B.sel = q; B.ver++; }
    let moved = false;
    const move = ev => {
      if (!moved) { pushUndo(); moved = true; }
      const [x, y] = frameAt(ev);
      Object.assign(q, { x, y });
      B.ver++;
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', () => {
      removeEventListener('pointermove', move);
      if (moved) changed();
      else if (!corner) { env.seek(q.t); renderBar(); }
    }, { once: true });
  }

  // Right-click a point to remove it.
  env.svg.addEventListener('contextmenu', e => {
    const g = e.target.closest('[data-kind]');
    if (!g) return;
    e.preventDefault();
    const i = Number(g.dataset.i);
    if (g.dataset.kind === 'pt') return change(() => { track().points = track().points.filter((_, k) => k !== i); });
    change(() => { B.data.court.points = courtPoints().filter((_, k) => k !== i); });
    B.pick = nextPick();
    renderBar();
  });

  function renderOverlay(t) {
    const svg = env.svg;
    if (!B.mode) {
      if (B.key !== 'off') { svg.innerHTML = ''; B.key = 'off'; }
      return;
    }
    const L = env.layout(), frame = Math.round(t * env.fps());
    const key = JSON.stringify([B.mode, frame, B.cur, B.ver, B.pick, L]);
    if (key === B.key) return;
    B.key = key;
    const cam = camera(), S = X => { const q = cam && project(cam, X); return q && toScreen(q, L); };
    const pts = list => list.map(q => q.join(',')).join(' ');
    let html = '';
    if (cam) {  // the court as the camera sees it: lines that sit on the real ones mean a good calibration
      for (const [[x0, y0], [x1, y1]] of courtLines()) {
        const a = S([x0, y0, 0]), b = S([x1, y1, 0]);
        if (a && b) html += `<line class="court" x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}"/>`;
      }
      const px = COURT.doubles / 2 + COURT.postOut, net = [[-px, 0, COURT.post], [0, 0, COURT.net], [px, 0, COURT.post]].map(S);
      if (net.every(Boolean)) html += `<polyline class="netline" points="${pts(net)}"/>`;
    }
    if (B.mode === 'court') {
      courtPoints().forEach((c, i) => {
        const [x, y] = toScreen([c.x, c.y], L), l = LANDMARKS.find(l => l.key === c.k);
        html += `<g class="corner${c.k === B.pick ? ' sel' : ''}" data-kind="corner" data-i="${i}"><title>${esc(l?.label || c.k)}</title>
          <circle cx="${x}" cy="${y}" r="7"/><circle class="dot" cx="${x}" cy="${y}" r="1.5"/></g>`;
      });
    } else if (track()) {
      const tr = track(), half = 0.5 / env.fps();
      html += `<g style="--c:${COLORS[B.cur % COLORS.length]}">`;
      for (const f of fits(tr)) {
        if (f.path) html += `<polyline class="fit" points="${pts(f.path.map(s => S(s)).filter(Boolean))}"/>`;
        else html += `<polyline class="raw" points="${pts(f.pts.map(q => toScreen([q.x, q.y], L)))}"/>`;
        const at = ballAt(f, t);  // the fitted ball now, with its shadow on the ground
        if (at) {
          const b = S(at), sh = S([at[0], at[1], 0]);
          if (b && sh) html += `<line class="drop" x1="${b[0]}" y1="${b[1]}" x2="${sh[0]}" y2="${sh[1]}"/><ellipse class="shadow" cx="${sh[0]}" cy="${sh[1]}" rx="5" ry="2"/><circle class="est" cx="${b[0]}" cy="${b[1]}" r="6"/>`;
        }
      }
      tr.points.forEach((q, i) => {
        const [x, y] = toScreen([q.x, q.y], L);
        const cls = `bp${q.ev ? ` ${q.ev}` : ''}${q === B.sel ? ' sel' : ''}${Math.abs(q.t - t) < half ? ' now' : ''}`;
        const mark = q.ev === 'bounce' ? `<rect x="${x - 4.5}" y="${y - 4.5}" width="9" height="9"/>`
          : q.ev === 'hit' ? `<rect x="${x - 4}" y="${y - 4}" width="8" height="8" transform="rotate(45 ${x} ${y})"/>`
          : `<circle cx="${x}" cy="${y}" r="3.5"/>`;
        html += `<g class="${cls}" data-kind="pt" data-i="${i}"><title>${q.ev || 'in flight'} · ${q.t.toFixed(3)} s</title><circle class="hitarea" cx="${x}" cy="${y}" r="9"/>${mark}</g>`;
      });
      html += '</g>';
    }
    svg.innerHTML = html;
  }

  // ---------------------------------------------------------------- the bar above the video

  function camText(cal) {
    if (!cal) return '';
    if (cal.error) return `<span class="error">${esc(cal.error)}</span>`;
    const fov = 2 * Math.atan(0.5 * cal.W / cal.s / cal.f) * 180 / Math.PI;
    return `<span class="meta" title="If the court lines don’t sit on the real ones, drag the points">Lens ≈ ${fov.toFixed(0)}° across${cal.guessed ? ' (guessed)' : ''}
      · camera ${cal.center[2].toFixed(1)} m up · points off by ${cal.err.toFixed(1)} px</span>`;
  }

  function courtBar() {
    const n = courtPoints().length, l = LANDMARKS.find(l => l.key === B.pick);
    return `<strong>Court</strong>
      <span>${l ? `Click <b>${esc(l.label)}</b> on the video, or pick another point on the map` : 'Pick a point on the map'}
        <span class="meta">· ${n} placed${n < 4 ? ', 4 or more needed' : ''} · ⌫ takes one back</span></span>
      ${n >= 4 ? camText(calib()) : ''}
      <span class="grow"></span>
      ${n ? '<button class="btn small" data-b="recourt">Start over</button>' : ''}
      ${n >= 4 ? '<button class="btn small primary" data-b="done">Done <kbd>↵</kbd></button>' : ''}
      <button class="icon" data-b="close" title="Put the tool down (Esc)">×</button>`;
  }

  // A map of the court (near end at the bottom) to pick which landmark the next click places.
  const courtKey = document.createElement('div');
  courtKey.className = 'court-key';
  env.screen.append(courtKey);
  courtKey.addEventListener('pointerdown', e => {
    e.stopPropagation();
    const k = e.target.closest('[data-k]')?.dataset.k;
    if (k) { B.pick = k; renderBar(); }
  });

  function renderCourtKey() {
    courtKey.hidden = B.mode !== 'court';
    if (courtKey.hidden) return;
    const placed = new Set(courtPoints().map(p => p.k));
    courtKey.innerHTML = `<svg viewBox="-7.2 -13.4 14.4 26.8">
      ${courtLines().map(([[x0, y0], [x1, y1]]) => `<line x1="${x0}" y1="${-y0}" x2="${x1}" y2="${-y1}"/>`).join('')}
      <line class="net" x1="-6.4" y1="0" x2="6.4" y2="0"/>
      ${LANDMARKS.map(l => `<circle data-k="${l.key}" class="${placed.has(l.key) ? 'placed' : ''}${l.key === B.pick ? ' pick' : ''}"
        cx="${l.at[0]}" cy="${-l.at[1]}" r="0.75"><title>${esc(l.label)}</title></circle>`).join('')}
    </svg><span>near end</span>`;
  }

  function ballBar() {
    const tr = track(), fl = tr ? fits(tr) : [], n = B.data.tracks.length;
    return `<strong>Ball <span class="badge">beta</span></strong>
      ${camera() ? '<button class="btn small" data-b="court" title="Edit the court points">Court ✓</button>'
        : '<button class="btn small primary" data-b="court">Set the court</button>'}
      <span class="seg small"><button data-b="prev" title="Previous track ([)">‹</button><button disabled>Track ${n ? B.cur + 1 : 0} / ${n}</button><button data-b="next" title="Next track (])">›</button></span>
      <button class="btn small" data-b="new" title="New track (N)">+ New</button>
      ${tr ? '<button class="btn small danger" data-b="delete">Delete</button>' : ''}
      <span class="meta">${tr ? `${tr.points.length} points · ${fl.filter(f => f.path).length} of ${fl.length} flights fitted` : 'No tracks yet'}</span>
      <label class="meta" title="How many times slower than real time the video plays">Slow-mo
        <select data-b="slowmo">${SLOWMO.map(v => `<option value="${v}" ${v === B.data.slowmo ? 'selected' : ''}>${v}×</option>`).join('')}</select></label>
      <span class="grow"></span>
      ${B.mode ? `<span class="meta">Click the ball · <kbd>⇧</kbd> bounce · <kbd>⌥</kbd> racket hit · 3+ per flight</span>
        <button class="icon" data-b="close" title="Put the tool down (Esc)">×</button>` : ''}`;
  }

  function renderBar() {
    const bar = env.bar;
    bar.hidden = !B.mode && B.view !== '3d';
    if (!bar.hidden) bar.innerHTML = B.mode === 'court' ? courtBar() : ballBar();
    renderCourtKey();
    if (B.view === '3d') renderLegend();
  }

  env.bar.addEventListener('click', e => {
    const b = e.target.closest('[data-b]');
    if (!b || b.tagName === 'SELECT') return;
    ({
      recourt: () => { change(() => { B.data.court = { points: [] }; }); B.pick = nextPick(); renderBar(); },
      done, close: () => setMode(null), court: () => setMode('court'),
      prev: () => goTrack(-1), next: () => goTrack(1), new: newTrack, delete: deleteTrack,
    })[b.dataset.b]?.();
    b.blur();
  });
  env.bar.addEventListener('change', e => {
    if (e.target.dataset.b !== 'slowmo') return;
    change(() => { B.data.slowmo = Number(e.target.value); });
    e.target.blur();
  });

  // ---------------------------------------------------------------- the 3D view

  env.view.innerHTML = `<canvas></canvas>
    <div class="c3-views seg small">${['camera', 'behind', 'side', 'top'].map(v => `<button data-v="${v}">${v[0].toUpperCase()}${v.slice(1)}</button>`).join('')}</div>
    <ul class="c3-legend"></ul>
    <p class="c3-hint">Drag to turn · scroll to zoom · double-click to reset</p>`;
  const canvas = env.view.querySelector('canvas'), legend = env.view.querySelector('.c3-legend');

  function setView(view) {
    B.view = view;
    if (view === '3d' && B.mode) setMode(null);
    env.screen.hidden = view === '3d';
    env.view.hidden = view !== '3d';
    env.tabs.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === view));
    renderBar();
  }

  function preset(name) {
    const cam = camera();
    if (name !== 'camera') return Object.assign(B.orbit, VIEWS[name], { lens: null });
    if (!cam) return env.flash('Set the court first: on the Video tab, press G');
    // from where the camera stands, looking where it looks, through the same lens
    const target = aimPoint(cam), d = sub(cam.center, target), dist = Math.hypot(...d);
    Object.assign(B.orbit, { target, dist, yaw: Math.atan2(d[0], -d[1]), pitch: Math.asin(d[2] / dist), lens: cam.f });
  }

  env.view.addEventListener('click', e => {
    const b = e.target.closest('[data-v]');
    if (b) { preset(b.dataset.v); b.blur(); }
    const li = e.target.closest('[data-track]');
    if (li) { B.cur = Number(li.dataset.track); B.sel = null; changed(false); }
  });
  canvas.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    let lx = e.clientX, ly = e.clientY;
    const move = ev => {
      const o = B.orbit;
      o.yaw -= (ev.clientX - lx) * 0.008;
      o.pitch = clamp(o.pitch + (ev.clientY - ly) * 0.006, 0.02, 1.55);
      lx = ev.clientX;
      ly = ev.clientY;
    };
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', () => canvas.removeEventListener('pointermove', move), { once: true });
  });
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    B.orbit.dist = clamp(B.orbit.dist * Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), 3, 150);
  }, { passive: false });
  canvas.addEventListener('dblclick', () => preset('behind'));

  // World points to canvas pixels for the orbit camera; null behind it.
  function projector(w, h) {
    const o = B.orbit, cp = Math.cos(o.pitch);
    const eye = [o.target[0] + o.dist * Math.sin(o.yaw) * cp, o.target[1] - o.dist * Math.cos(o.yaw) * cp, o.target[2] + o.dist * Math.sin(o.pitch)];
    const fwd = unit(sub(o.target, eye)), right = unit(cross(fwd, [0, 0, 1])), up = cross(right, fwd);
    const F = o.lens ? o.lens * Math.max(w, h) : Math.min(w, h) * 1.2;
    return X => {
      const d = sub(X, eye), z = dot(d, fwd);
      return z < 0.2 ? null : [w / 2 + F * dot(d, right) / z, h / 2 - F * dot(d, up) / z];
    };
  }

  function draw3d(t) {
    const w = env.view.clientWidth, h = env.view.clientHeight, dpr = devicePixelRatio || 1;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d'), P = projector(w, h), cam = camera();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0d1311';
    ctx.fillRect(0, 0, w, h);
    const path = (pts, close = false) => {
      ctx.beginPath();
      let pen = false;
      for (const X of pts) {
        const q = P(X);
        if (!q) { pen = false; continue; }
        if (pen) ctx.lineTo(...q); else ctx.moveTo(...q);
        pen = true;
      }
      if (close) ctx.closePath();
    };
    const ring = (X, color, r = 0.18) => {
      path(Array.from({ length: 17 }, (_, i) => [X[0] + r * Math.cos(i * Math.PI / 8), X[1] + r * Math.sin(i * Math.PI / 8), 0]));
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
    };
    const dotAt = (X, color, r) => {
      const q = P(X);
      if (!q) return;
      ctx.beginPath();
      ctx.arc(q[0], q[1], r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    };
    const D = COURT.doubles / 2, L = COURT.length / 2, px = D + COURT.postOut;
    path([[-D - 3.7, -L - 6.4, 0], [D + 3.7, -L - 6.4, 0], [D + 3.7, L + 6.4, 0], [-D - 3.7, L + 6.4, 0]], true);
    ctx.fillStyle = '#1b3a32';
    ctx.fill();
    path([[-D, -L, 0], [D, -L, 0], [D, L, 0], [-D, L, 0]], true);
    ctx.fillStyle = '#245849';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.85)';
    ctx.lineWidth = 1.5;
    for (const [[x0, y0], [x1, y1]] of courtLines()) { path([[x0, y0, 0], [x1, y1, 0]]); ctx.stroke(); }
    path([[-px, 0, 0], [px, 0, 0], [px, 0, COURT.post], [0, 0, COURT.net], [-px, 0, COURT.post]], true);
    ctx.fillStyle = 'rgba(230,230,230,.14)';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    path([[-px, 0, 0], [-px, 0, COURT.post], [0, 0, COURT.net], [px, 0, COURT.post], [px, 0, 0]]);
    ctx.stroke();
    if (cam && !B.orbit.lens) {  // where the video was filmed from
      const c = cam.center, q = P(c);
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = 'rgba(255,255,255,.4)';
      ctx.lineWidth = 1;
      path([c, [c[0], c[1], 0]]);
      ctx.stroke();
      ctx.setLineDash([]);
      dotAt(c, '#fff', 4);
      if (q) { ctx.fillStyle = '#8e8d94'; ctx.font = '11px -apple-system, system-ui, sans-serif'; ctx.fillText('camera', q[0] + 7, q[1] + 4); }
    }
    let now = null;
    B.data.tracks.forEach((tr, i) => {
      const color = COLORS[i % COLORS.length], on = i === B.cur;
      ctx.globalAlpha = on ? 1 : 0.35;
      for (const f of fits(tr)) {
        if (!f.path) {  // not enough points to fit: still show where it bounced
          for (const q of f.pts) if (q.ev === 'bounce' && cam) { const g = ground(cam, q); if (g) ring(g, color); }
          continue;
        }
        ctx.strokeStyle = 'rgba(0,0,0,.45)';
        ctx.lineWidth = 2;
        path(f.path.map(s => [s[0], s[1], 0]));
        ctx.stroke();
        ctx.strokeStyle = color;
        ctx.lineWidth = on ? 2.5 : 1.5;
        path(f.path);
        ctx.stroke();
        if (f.from === 'bounce') ring(f.path[0], color);
        if (f.to === 'bounce') ring(f.path.at(-1), color);
        if (f.from === 'hit') dotAt(f.path[0], color, 4);
        const at = ballAt(f, t);
        if (at && (on || !now)) now = at;
      }
    });
    ctx.globalAlpha = 1;
    if (now) {  // the ball at the playhead, with a line down to its shadow
      ctx.setLineDash([2, 3]);
      ctx.strokeStyle = 'rgba(255,255,255,.6)';
      ctx.lineWidth = 1;
      path([now, [now[0], now[1], 0]]);
      ctx.stroke();
      ctx.setLineDash([]);
      dotAt([now[0], now[1], 0], 'rgba(0,0,0,.55)', 4);
      dotAt(now, '#d8f04a', 6);
    }
  }

  function renderLegend() {
    const ev = e => e || '…';
    const flight = f => f.path
      ? `<li>${ev(f.from)} → ${ev(f.to)}: <b>${f.speed.toFixed(0)} km/h</b> → ${f.endSpeed.toFixed(0)} · peak ${f.peak.toFixed(1)} m
          ${f.net != null ? `· ${f.net >= 0 ? `clears the net by ${f.net.toFixed(2)} m` : `<span class="error">${(-f.net).toFixed(2)} m under the net</span>`}` : ''}
          <span class="meta">· fit ${f.rms.toFixed(1)} px</span></li>`
      : `<li class="meta">${ev(f.pts[0].ev)} → ${ev(f.pts.at(-1).ev)}: needs 3+ points</li>`;
    const html = !camera() ? '<li class="meta">Set the court first: on the Video tab, press G.</li>'
      : B.data.tracks.map((tr, i) => `<li class="${i === B.cur ? 'on' : ''}" data-track="${i}" style="--c:${COLORS[i % COLORS.length]}">
          <span class="sw"></span>Track ${i + 1} <span class="meta">${tr.points.length} points</span>
          <ul>${fits(tr).map(flight).join('')}</ul></li>`).join('') || '<li class="meta">No tracks yet: on the Video tab, press G and click the ball.</li>';
    if (legend.innerHTML !== html) legend.innerHTML = html;
  }

  return {
    active: () => !!B.mode,
    toggle, key, undo, setView,
    off: () => B.mode && setMode(null),
    render(t) {
      renderOverlay(t);
      if (B.view === '3d') draw3d(t);
    },
    close() { clearTimeout(saveTimer); if (B.dirty) saveNow(); },
  };
}
