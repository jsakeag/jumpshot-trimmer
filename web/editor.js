import { $, KINDS, MARK_KEYS, VOLLEY, api, clamp, enc, esc, fmt, jobRunning, jobText, parseTime, strength } from './util.js';
import { Timeline } from './timeline.js';
import { colorOf, openPicker } from './picker.js';

const TAP_BEFORE = 1.0, TAP_AFTER = 0.5;  // a tapped mark key marks this window around where it went down
const MIN_HOLD = 0.3;                      // seconds of video a held key must cover, else it counts as a tap
const REWIND = 1.0;                        // Z rewinds to this long before the undone mark's key went down
const STROKES = ['fh', 'bh', 'serve'];
const FOOTWORK = ['fh', 'bh'];  // the only strokes footwork can be drawn on
const SPEEDS = [0.25, 0.5, 1, 1.5, 2];

const r3 = x => Math.round(x * 1000) / 1000;
const newId = () => `m-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const store = {  // per-browser conveniences only; the page works without them
  get(k, d) { try { const v = localStorage.getItem(`mpl.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`mpl.${k}`, JSON.stringify(v)); } catch {} },
};

const KEY_HELP = [
  ['Mark (hold while playing)', [['F', 'Forehand'], ['B', 'Backhand'], [';', 'Serve'], ['⇧F / ⇧B', `Forehand / backhand tagged ${VOLLEY}`],
    ['tap', `${TAP_BEFORE + TAP_AFTER} s around the playhead`], ['Z', `Undo last mark, rewind ${REWIND} s before it`]]],
  ['Playback', [['Space / K', 'Play / pause'], ['← →', 'Step a frame'], ['⇧← ⇧→', '1 s'], ['J / L', '5 s back / ahead'], ['R', 'Play only the listed annotations; steps skip the gaps too'],
    ['M', 'Mute']]],
  ['Annotations', [['↑ ↓', 'Previous / next'], ['↵', 'Confirm / back to maybe'], ['I / O', 'Set in / out to playhead'],
    ['T', 'Add a tag'], ['P', 'Play it'], ['⌫', 'Delete (again: the mark before)'], ['Esc', 'Deselect'], ['⌘Z / ⇧⌘Z', 'Undo / redo']]],
  ['Footwork (on a FH/BH)', [['D', 'Step tool: click to place steps, numbered'], ['⇧-click', 'A step landing with the previous one (hop): same number'], ['⌥-click', 'Where your feet were at the split step'],
    ['click / ⌫', 'Select a step, delete it (again: the one before)'], ['right-click', 'Remove one'], ['Esc', 'Put the tool down']]],
  ['View', [['\\', 'Annotations panel'], ['= / − / 0', 'Zoom in / out / fit'], ['?', 'All keys']]],
];

const keyTable = groups => groups.map(([title, rows]) => `
  <div class="keys"><h4>${esc(title)}</h4>${rows.map(([k, what]) => `<div><kbd>${esc(k)}</kbd><span>${esc(what)}</span></div>`).join('')}</div>`).join('');

// Confirmed annotations as time windows with overlaps joined, as the export will cut them.
function windows(anns) {
  const out = [];
  for (const a of [...anns].sort((a, b) => a.start - b.start)) {
    if (out.length && a.start <= out[out.length - 1].end) out[out.length - 1].end = Math.max(out[out.length - 1].end, a.end);
    else out.push({ start: a.start, end: a.end });
  }
  return out;
}

const sameWindows = (a, b) => a.length === b.length && a.every((w, i) =>
  Math.abs(w.start - b[i].start) < 2e-3 && Math.abs(w.end - b[i].end) < 2e-3);

// Each drawing's step number (a tied step shares the one before's), or null for a split-step foot.
function stepNumbers(drawings) {
  let n = 0;
  return drawings.map(d => d.type !== 'point' ? null : d.tie && n ? n : ++n);
}

// Replace el's contents, keeping focus (and a half-typed value) in the field marked data-fk.
function setHTML(el, html) {
  const a = document.activeElement, fk = el.contains(a) ? a.dataset.fk : null;
  const value = fk ? a.value : null;
  el.innerHTML = html;
  const n = fk && el.querySelector(`[data-fk="${fk}"]`);
  if (n) { n.value = value; n.focus(); }
}

export function openEditor(app, stem, info) {
  const base = `/api/videos/${enc(stem)}`;
  const S = {
    v: null, anns: [], rev: 0, sel: null,
    rec: null,     // the mark key being held: {code, kind, start}
    marks: [],     // marks made by key, newest last, for Z: {id, at}
    undo: [], redo: [], lastKey: null, lastAt: 0,
    f: { kinds: new Set(), tags: new Set(), mode: 'any', min: 0, sort: 'time', bad: false },
    open: { confirmed: true, maybe: true },
    tool: null,    // 'point' while placing footwork steps on the video
    regionsOnly: false, loop: false, panel: store.get('panel', true),
    stopAt: null, wasPlaying: false, dirty: false, saving: false,
    job: null, final: null, vocab: { labels: [], steps: [], splits: [] }, listed: [], playlist: [], dim: new Set(),
  };
  let alive = true, raf = null, saveTimer = null, pollTimer = null, mediaTimer = null, flashTimer = null;
  let vid = null, tl = null, dur = 0;

  // this video's filter, Play only these and open sections, as left last time
  const view = store.get(`view.${stem}`, {});
  Object.assign(S.f, { mode: view.mode || 'any', min: view.min || 0, sort: view.sort || 'time', bad: !!view.bad,
    kinds: new Set(view.kinds || []), tags: new Set(view.tags || []) });
  Object.assign(S.open, view.open || {});
  S.regionsOnly = !!view.regionsOnly;
  const saveView = () => store.set(`view.${stem}`, { ...S.f, kinds: [...S.f.kinds], tags: [...S.f.tags],
    open: S.open, regionsOnly: S.regionsOnly });

  app.innerHTML = '<p class="hint pad">Loading…</p>';
  document.title = `${stem} · Mock Premiere Lite`;

  const onBeforeUnload = e => { if (S.dirty || S.saving) e.preventDefault(); };
  const onBlur = () => { if (S.rec) finishMark(); };
  // Clicking anywhere else lets go of a text box (saving it), even where a drag handler stops the
  // browser from moving focus (video, timeline, scrub bar), so the keys work again.
  const onPointerDown = e => {
    const a = document.activeElement;
    if (e.target.closest?.('.picker')) return;
    if (a?.matches('input:not([type=checkbox]):not([type=range]), select') && !a.contains(e.target)) a.blur();
  };
  addEventListener('beforeunload', onBeforeUnload);
  addEventListener('blur', onBlur);
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);

  Promise.all([api(base), ...['labels', 'steps', 'splits'].map(k => api(`/api/vocab/${k}`).catch(() => []))]).then(([v, labels, steps, splits]) => {
    if (!alive) return;
    S.v = v;
    S.anns = v.annotations;
    S.rev = v.rev;
    S.vocab = { labels, steps, splits };
    dur = v.duration;
    build();
    applyStatus(v);
  }).catch(e => {
    if (alive) app.innerHTML = `<p class="error pad">${esc(e.message)} · <a href="#/">Back to videos</a></p>`;
  });

  function cleanup() {
    alive = false;
    clearTimeout(pollTimer);
    clearTimeout(mediaTimer);
    clearTimeout(flashTimer);
    cancelAnimationFrame(raf);
    removeEventListener('beforeunload', onBeforeUnload);
    removeEventListener('blur', onBlur);
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('keyup', onKeyUp);
    if (S.dirty) saveNow();
    if (vid) { vid.pause(); vid.removeAttribute('src'); vid.load(); }
  };

  // ---------------------------------------------------------------- layout

  function build() {
    app.innerHTML = `
      <div class="ed${S.panel ? '' : ' panel-closed'}">
        <header class="ed-head">
          <a href="#/" class="back" title="All videos">‹</a>
          <h1>${esc(S.v.name)}</h1>
          <span class="meta" id="save-state"></span>
          <span class="grow"></span>
          <span class="job" id="job"></span>
          <button class="btn" id="plugins-btn">Plugins…</button>
          <span class="export" id="export"></span>
          <button class="btn" id="panel-btn" title="Annotations panel (\\)">Annotations</button>
          <button class="icon" id="help-btn" title="Keys (?)">?</button>
        </header>
        <aside class="inspector" id="inspector"></aside>
        <section class="preview">
          <div class="screen" id="screen">
            <video id="vid" preload="auto" playsinline src="${base}/source"></video>
            <svg class="draw" id="draw"></svg>
            <div class="rec" id="rec" hidden></div>
            <div class="flash" id="flash" hidden></div>
          </div>
          <div class="scrubber" id="scrubber"><div class="regions" id="regions"></div><div class="played" id="played"></div></div>
          <div class="transport">
            <button class="icon" data-t="prev" title="Previous annotation (↑)">⏮</button>
            <button class="icon" data-t="back" title="Back a frame (←)">◂</button>
            <button class="icon play" data-t="play" id="play" title="Play / pause (Space)">▶</button>
            <button class="icon" data-t="fwd" title="Ahead a frame (→)">▸</button>
            <button class="icon" data-t="next" title="Next annotation (↓)">⏭</button>
            <span class="time" id="time"></span>
            <span class="grow"></span>
            <label class="toggle" title="Loop"><input type="checkbox" id="loop"> Loop</label>
            <select id="speed" title="Speed">${SPEEDS.map(s => `<option value="${s}" ${s === 1 ? 'selected' : ''}>${s}×</option>`).join('')}</select>
            <button class="icon" data-t="mute" id="mute" title="Mute (M)">🔊</button>
            <input type="range" id="volume" min="0" max="1" step="0.05" value="${store.get('volume', 1)}" aria-label="Volume">
            <span class="seg tools"><button data-t="point" title="Step tool: place footwork steps (D). ⌥-click anytime: split-step feet">• Steps</button></span>
            <button class="icon" data-t="full" title="Full screen">⛶</button>
          </div>
        </section>
        <aside class="panel" id="panel"></aside>
        <section class="timeline" id="timeline"></section>
        <dialog id="plugins-dlg"></dialog>
        <dialog id="help-dlg" class="help"><form method="dialog"><h2>Keys</h2><div class="keygrid">${keyTable(KEY_HELP)}</div>
          <div class="row end"><button class="btn">Close</button></div></form></dialog>
      </div>`;

    vid = $('#vid');
    vid.volume = store.get('volume', 1);
    vid.addEventListener('play', () => { $('#play').textContent = '❚❚'; });
    vid.addEventListener('pause', () => { $('#play').textContent = '▶'; });
    vid.addEventListener('click', e => { if (!e.altKey) togglePlay(); });
    vid.addEventListener('error', () => flash('This browser can’t play this video. Try Safari or Chrome.', 0));
    vid.addEventListener('volumechange', () => { $('#mute').textContent = vid.muted || !vid.volume ? '🔇' : '🔊'; });

    $('.transport').addEventListener('click', e => {
      const t = e.target.closest('[data-t]')?.dataset.t;
      ({
        prev: () => neighbor(-1), next: () => neighbor(1), back: () => stepFrame(-1), fwd: () => stepFrame(1),
        play: togglePlay, mute: () => { vid.muted = !vid.muted; },
        point: () => setTool('point'),
        full: () => document.fullscreenElement ? document.exitFullscreen() : $('#screen').requestFullscreen?.(),
      })[t]?.();
      if (t) e.target.blur();  // so Space doesn't also press the button
    });
    $('#loop').addEventListener('change', e => { S.loop = e.target.checked; vid.loop = S.loop && !S.regionsOnly; });
    $('#speed').addEventListener('change', e => { vid.playbackRate = Number(e.target.value); e.target.blur(); });
    $('#volume').addEventListener('input', e => { vid.volume = Number(e.target.value); vid.muted = false; store.set('volume', vid.volume); });
    $('#volume').addEventListener('change', e => e.target.blur());
    setupScrubber();

    $('#panel-btn').addEventListener('click', togglePanel);
    $('#help-btn').addEventListener('click', () => $('#help-dlg').showModal());
    $('#plugins-btn').addEventListener('click', openPlugins);
    $('#export').addEventListener('click', e => {
      if (e.target.closest('#export-btn')) startExport();
      if (e.target.closest('#reveal')) api(`/api/reveal?stem=${enc(stem)}`, { method: 'POST' }).catch(err => alert(err.message));
    });

    setupDrawing();
    setupInspector();
    setupPanel();

    tl = new Timeline($('#timeline'), dur, {
      seek, select: id => select(id, false),
      scrub: on => {
        if (on) { S.wasPlaying = !vid.paused; vid.pause(); } else if (S.wasPlaying) vid.play().catch(() => {});
      },
      play: playAnn,
      edit: (id, start, end, phase) => {
        if (phase === 'start') return pushUndo();
        if (phase === 'end') return scheduleSave();
        const a = S.anns.find(x => x.id === id);
        if (!a) return;
        a.start = r3(start);
        a.end = r3(end);
        renderAll();
      },
    });
    loadMedia();
    renderAll();
    raf = requestAnimationFrame(tick);
  }

  // ---------------------------------------------------------------- rendering

  function derive() {
    const f = S.f;
    const passes = a => (!f.kinds.size || f.kinds.has(a.kind))
      && (!f.tags.size || (f.mode === 'all'
        ? [...f.tags].every(n => a.tags.some(t => t.name === n))
        : a.tags.some(t => f.tags.has(t.name))))
      && (!f.min || (strength(a, f.tags) ?? -1) >= f.min)
      && (!f.bad || badSteps(a) > 0);
    S.listed = S.anns.filter(passes);
    if (f.sort === 'strength') {
      S.listed.sort((a, b) => (strength(b, f.tags) ?? -1) - (strength(a, f.tags) ?? -1) || a.start - b.start);
    }
    S.dim = new Set(S.anns.filter(a => !passes(a)).map(a => a.id));
    S.playlist = windows(S.listed);
  }

  function renderAll({ inspector = true } = {}) {
    if (!vid) return;
    derive();
    saveView();
    if (inspector) renderInspector();
    renderPanel();
    renderTimeline();
    renderRegions();
    renderExport();
  }

  const renderTimeline = () => tl.setAnnotations(S.anns, {
    selected: S.sel, dim: S.dim,
    live: S.rec && { kind: S.rec.kind, start: Math.min(S.rec.start, vid.currentTime), end: Math.max(S.rec.start + 0.05, vid.currentTime), maybe: false },
  });

  function renderRegions() {
    $('#regions').innerHTML = S.anns.map(a => `<div class="${a.maybe ? 'maybe' : ''}${S.dim.has(a.id) ? ' dim' : ''}"
      style="left:${a.start / dur * 100}%;width:${Math.max(0.15, (a.end - a.start) / dur * 100)}%;--c:${KINDS[a.kind].color}"></div>`).join('');
  }

  function renderExport() {
    const w = windows(S.anns.filter(a => !a.maybe));
    const total = w.reduce((s, x) => s + x.end - x.start, 0);
    const exporting = jobRunning(S.job) && S.job.label === 'Export';
    let html;
    if (S.final && !exporting && sameWindows(S.final.windows, w)) {
      html = `<span class="ok" title="${S.final.clips} clips · ${fmt(S.final.duration)}">✓ Exported</span>
        <button class="btn" id="reveal">Show in Finder</button><a class="btn" href="${base}/final" download>Download</a>`;
    } else {
      html = `<button class="btn primary" id="export-btn" ${w.length && !jobRunning(S.job) ? '' : 'disabled'}
        title="Joins the confirmed annotations into one video">Export ${w.length} clip${w.length === 1 ? '' : 's'} · ${fmt(total)}</button>`;
    }
    const el = $('#export');
    if (el.innerHTML !== html) el.innerHTML = html;
  }

  function renderJob() {
    const j = S.job, el = $('#job');
    if (!el) return;
    el.className = `job${j?.error ? ' error' : ''}`;
    el.innerHTML = j && j.stage !== 'done'
      ? `${esc(jobText(j))}${jobRunning(j) ? `<span class="bar"><span style="width:${j.progress * 100}%"></span></span>` : ''}`
      : '';
  }

  function setSaveState(text) { const el = $('#save-state'); if (el) el.textContent = text; }

  function flash(text, ms = 1800) {
    const el = $('#flash');
    if (!el) return;
    el.textContent = text;
    el.hidden = false;
    clearTimeout(flashTimer);
    if (ms) flashTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  // ---------------------------------------------------------------- inspector (the selected annotation)

  const selected = () => S.anns.find(a => a.id === S.sel);
  const sourceLabel = s => s === 'manual' ? 'Marked by you' : `Found by ${info.plugins.find(p => p.name === s)?.label || s}`;

  function renderInspector() {
    const el = $('#inspector'), a = selected();
    if (!a) {
      setHTML(el, `<div class="insp-empty"><strong>Nothing selected</strong>
        <p class="hint">Hold a key while the video plays to mark a stroke. Click one on the timeline to edit it.</p>
        ${keyTable(KEY_HELP.slice(0, 1))}<p class="hint"><a href="#" data-act="help">All keys (?)</a></p></div>`);
      return;
    }
    const k = KINDS[a.kind];
    const kinds = STROKES.includes(a.kind) ? STROKES : [a.kind, ...STROKES];
    setHTML(el, `
      <div class="insp-head" style="--c:${k.color}"><span class="swatch"></span><strong>${esc(k.label)}</strong>
        ${a.maybe ? '<span class="badge">maybe</span>' : ''}${a.weak ? '<span class="badge weak" title="The plugin wasn’t sure">weak</span>' : ''}</div>
      <p class="meta">${esc(sourceLabel(a.source))}</p>
      <div class="seg kinds">${kinds.map(x => `<button data-act="kind" data-kind="${x}" class="${x === a.kind ? 'on' : ''}"
        style="--c:${KINDS[x].color}" title="${esc(KINDS[x].label)}">${esc(KINDS[x].short)}</button>`).join('')}</div>
      <div class="times">
        <label>In <input data-act="in" data-fk="in" value="${fmt(a.start, true)}" spellcheck="false"></label>
        <button class="icon" data-act="set-in" title="Set to the playhead (I)">⇤</button>
        <label>Out <input data-act="out" data-fk="out" value="${fmt(a.end, true)}" spellcheck="false"></label>
        <button class="icon" data-act="set-out" title="Set to the playhead (O)">⇥</button>
        <span class="meta">${(a.end - a.start).toFixed(1)} s</span>
      </div>
      <div class="row">
        <button class="btn ${a.maybe ? 'primary' : ''}" data-act="confirm">${a.maybe ? '✓ Confirm' : 'Make maybe'} <kbd>↵</kbd></button>
        <button class="btn" data-act="play">▶ Play <kbd>P</kbd></button>
        <button class="btn danger" data-act="delete" title="Delete (⌫)">Delete</button>
      </div>
      ${FOOTWORK.includes(a.kind) ? footworkHTML(a) : ''}
      <h3>Tags</h3>
      <ul class="tag-edit">${a.tags.map((t, i) => `
        <li><span class="name lbl" style="--c:${colorOf(S.vocab.labels, t.name)}" title="${esc(t.name)}">${esc(t.name)}</span>
          <input type="range" min="1" max="5" step="1" value="${t.score}" data-act="score-range" data-i="${i}" aria-label="${esc(t.name)} score">
          <input type="number" min="1" max="5" step="1" value="${t.score}" data-act="score" data-i="${i}" data-fk="score-${i}">
          <button class="icon" data-act="untag" data-i="${i}" title="Remove tag">×</button></li>`).join('')}
      </ul>
      <button class="btn small add-tag" data-act="add-label">+ Add label <kbd>T</kbd></button>
      <p class="hint">Score how strongly each tag shows, 1–5.</p>`);
  }

  // A step (or split-step foot) whose name is marked bad: one that ideally isn't needed.
  const badStep = d => !!d.name && S.vocab[d.type === 'split' ? 'splits' : 'steps'].some(x => x.name === d.name && x.bad);
  const badSteps = a => (a.drawings || []).filter(badStep).length;

  // The stroke's steps as a numbered sequence, split-step feet first, each with a name.
  function footworkHTML(a) {
    const ds = a.drawings || [], nums = stepNumbers(ds);
    const order = ds.map((_, i) => i).sort((i, j) => (ds[j].type === 'split') - (ds[i].type === 'split'));
    return `<h3>Footwork</h3>
      ${ds.length ? `<ol class="steps-seq">${order.map(i => {
        const d = ds[i], split = d.type === 'split';
        return `<li class="${split ? 'split' : ''}${d === S.step ? ' sel' : ''}${badStep(d) ? ' bad' : ''}" data-act="step" data-i="${i}">
          <span class="num" title="${split ? 'Split step' : d.tie ? 'Lands with the step before' : ''}">${split ? '' : nums[i]}</span>
          <button class="step-name${d.name ? ' lbl' : ''}" data-act="name-step" data-i="${i}"
            ${d.name ? `style="--c:${colorOf(S.vocab[split ? 'splits' : 'steps'], d.name)}"` : ''}>${d.name ? `${badStep(d) ? '⚠ ' : ''}${esc(d.name)}` : split ? 'Split step…' : 'Name this step…'}</button>
          <button class="icon" data-act="unstep" data-i="${i}" title="Remove">×</button></li>`;
      }).join('')}</ol>` : ''}
      <p class="hint">D, then click on the video to add steps; ⇧-click for one landing with the previous (a hop);
        ⌥-click where your feet were at the split step.${ds.length ? ' <a href="#" data-act="clear-drawings">Clear all</a>' : ''}</p>
      <hr class="sep">`;
  }

  function selectStep(d) {
    S.step = d;
    S.drawKey = null;
    renderInspector();
  }

  // Tags are picked from the shared list of labels (or a new one made on the spot), then scored.
  function pickLabel(anchor) {
    const a = selected();
    if (!a) return;
    openPicker(anchor, {
      list: S.vocab.labels, exclude: a.tags.map(t => t.name), placeholder: 'Search or create a label…',
      pick: name => {
        let i = a.tags.findIndex(x => x.name.toLowerCase() === name.toLowerCase());
        if (i < 0) {
          change(() => { a.tags.push({ name, score: 3 }); });
          i = a.tags.length - 1;
        }
        const score = $(`#inspector [data-fk="score-${i}"]`);  // straight on to scoring it: type 1-5
        score?.focus();
        score?.select();
      },
      ...vocabOps('labels'),
    });
  }

  // What the picker can do to a shared list (labels or steps), keeping this page in step with it.
  function vocabOps(kind) {
    const call = async (method, json, query = '') =>
      (S.vocab[kind] = await api(`/api/vocab/${kind}${query}`, { method, ...(json ? { json } : {}) }));
    return {
      create: name => call('POST', { name }),
      recolor: async (name, color) => { const list = await call('PATCH', { name, color }); renderAll(); return list; },
      rename: async (old, name) => { const list = await call('PATCH', { name: old, new_name: name }); renameHere(kind, old, name); return list; },
      remove: async name => { const list = await call('DELETE', null, `?name=${enc(name)}`); renameHere(kind, name, null); return list; },
      ...(kind !== 'labels' && {  // step names can be marked bad: steps that ideally aren't needed
        markBad: async (name, bad) => { const list = await call('PATCH', { name, bad }); S.drawKey = null; renderAll(); return list; },
      }),
    };
  }

  // The server renamed (or with name null, removed) a label or step name in every project; do the
  // same to this page's copy so its next save agrees.
  function renameHere(kind, old, name) {
    for (const a of S.anns) {
      if (kind === 'labels') {
        const tags = [];
        for (const t of a.tags) {
          if (t.name === old) { if (name == null) continue; t.name = name; }
          const same = tags.find(x => x.name.toLowerCase() === t.name.toLowerCase());
          if (same) same.score = Math.max(same.score, t.score);
          else tags.push(t);
        }
        a.tags = tags;
      } else {
        const type = kind === 'splits' ? 'split' : 'point';
        for (const d of a.drawings || []) if (d.name === old && d.type === type) { if (name == null) delete d.name; else d.name = name; }
      }
    }
    if (kind === 'labels' && S.f.tags.delete(old) && name) S.f.tags.add(name);
    S.drawKey = null;
    renderAll();
    scheduleSave();
  }

  function setupInspector() {
    const el = $('#inspector');
    el.addEventListener('click', e => {
      const b = e.target.closest('[data-act]');
      if (!b || b.tagName === 'INPUT' || b.tagName === 'SELECT') return;  // let fields and dropdowns open normally
      e.preventDefault();
      const a = selected(), i = Number(b.dataset.i);
      if (b.dataset.act === 'help') return $('#help-dlg').showModal();
      if (!a) return;
      ({
        kind: () => b.dataset.kind !== a.kind && change(() => { a.kind = b.dataset.kind; }),
        'set-in': () => setEdge('start'), 'set-out': () => setEdge('end'),
        confirm: toggleMaybe, play: () => playAnn(a.id), delete: deleteSel,
        untag: () => change(() => { a.tags.splice(i, 1); }),
        'clear-drawings': () => change(() => { a.drawings = []; }),
        step: () => selectStep(a.drawings[i]),
        'add-label': () => pickLabel(b),
        'name-step': () => {
          const d = a.drawings[i], kind = d.type === 'split' ? 'splits' : 'steps';  // split-step feet have their own names
          if (S.step !== d) selectStep(d);
          openPicker($(`#inspector [data-act=name-step][data-i="${i}"]`) || b, {
            list: S.vocab[kind], current: d.name, noneLabel: 'No name',
            placeholder: kind === 'splits' ? 'Search or create a split-step name…' : 'Search or create a step name…',
            pick: name => change(() => { if (name) d.name = name; else delete d.name; }), ...vocabOps(kind),
          });
        },
        unstep: () => {
          if (S.step === a.drawings[i]) S.step = null;
          change(() => { a.drawings = a.drawings.filter((_, k) => k !== i); });
        },
      })[b.dataset.act]?.();
      b.blur();
    });
    el.addEventListener('input', e => {
      if (e.target.dataset.act === 'score' && /^[1-5]$/.test(e.target.value)) return e.target.blur();  // one digit is a whole score: save it
      const a = selected();
      if (!a || e.target.dataset.act !== 'score-range') return;
      const i = Number(e.target.dataset.i), score = Number(e.target.value);
      change(() => { a.tags[i].score = score; }, `score:${a.id}:${i}`, { inspector: false });
      el.querySelector(`[data-act="score"][data-i="${i}"]`).value = score;
    });
    el.addEventListener('change', e => {
      const a = selected(), t = e.target;
      if (!a) return;
      if (t.dataset.act === 'score-range') t.blur();
      if (t.dataset.act === 'score') {
        const score = clamp(Math.round(Number(t.value) || 1), 1, 5), i = Number(t.dataset.i);
        change(() => { a.tags[i].score = score; }, `score:${a.id}:${i}`);
      }
      if (t.dataset.act === 'in' || t.dataset.act === 'out') {
        const v = parseTime(t.value);
        const ok = t.dataset.act === 'in' ? v >= 0 && v < a.end - 0.05 : v > a.start + 0.05 && v <= dur;
        if (ok) change(() => { a[t.dataset.act === 'in' ? 'start' : 'end'] = r3(v); });
        else { flash('That time is outside the other end or the video'); renderInspector(); }
      }
    });
    el.addEventListener('keydown', e => {
      const t = e.target;
      if (e.key !== 'Enter' || t.tagName !== 'INPUT') return;
      e.preventDefault();
      t.blur();  // commits the field
    });
  }

  // ---------------------------------------------------------------- side panel (list and filters)

  function renderPanel() {
    const el = $('#panel'), f = S.f;
    const present = new Set(S.anns.map(a => a.kind));
    const kinds = Object.keys(KINDS).filter(k => STROKES.includes(k) || present.has(k));
    const counts = {};
    for (const a of S.anns) for (const t of a.tags) counts[t.name] = (counts[t.name] || 0) + 1;
    const tags = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
    for (const t of f.tags) if (!counts[t]) f.tags.delete(t);
    const conf = S.listed.filter(a => !a.maybe), maybe = S.listed.filter(a => a.maybe);
    const filtered = f.kinds.size || f.tags.size || f.min || f.bad;
    const showStrength = f.sort === 'strength' || f.tags.size;
    const row = a => {
      const k = KINDS[a.kind], s = strength(a, f.tags);
      return `<li class="item${a.id === S.sel ? ' sel' : ''}" data-id="${a.id}" style="--c:${k.color}">
        <span class="kind">${esc(k.short)}</span>
        <span class="when">${fmt(a.start, true)}<span class="meta"> · ${(a.end - a.start).toFixed(1)}s</span></span>
        ${showStrength && s != null ? `<span class="strength" title="Strength">${s}</span>` : ''}
        <span class="acts">${a.maybe ? '<button class="icon" data-act="confirm" title="Confirm">✓</button>' : ''}<button class="icon" data-act="delete" title="Delete">×</button></span>
        ${a.tags.length ? `<span class="chips">${a.tags.map(t => `<span class="chip lbl${f.tags.has(t.name) ? ' on' : ''}" style="--c:${colorOf(S.vocab.labels, t.name)}">${esc(t.name)} <b>${t.score}</b></span>`).join('')}</span>` : ''}
        ${a.weak ? '<span class="chips"><span class="chip weak">weak</span></span>' : ''}
        ${badSteps(a) ? `<span class="chips"><span class="chip badc" title="Steps marked bad">⚠ ${badSteps(a)} bad step${badSteps(a) === 1 ? '' : 's'}</span></span>` : ''}
      </li>`;
    };
    setHTML(el, `
      <div class="panel-head"><strong>Annotations</strong><span class="meta">${S.anns.length - S.anns.filter(a => a.maybe).length} confirmed · ${S.anns.filter(a => a.maybe).length} maybe</span>
        <span class="grow"></span><button class="icon" data-act="close" title="Close (\\)">×</button></div>
      <div class="filter">
        <div class="frow"><span class="flabel">Kind</span><div class="chips">${kinds.map(k => `<button class="chip${f.kinds.has(k) ? ' on' : ''}"
          data-act="kind" data-kind="${k}" style="--c:${KINDS[k].color}">${esc(KINDS[k].short)}</button>`).join('')}</div></div>
        <div class="frow"><span class="flabel">Tags</span><div class="chips">${tags.map(t => `<button class="chip lbl${f.tags.has(t) ? ' on' : ''}"
          data-act="tag" data-tag="${esc(t)}" style="--c:${colorOf(S.vocab.labels, t)}">${esc(t)} <span class="meta">${counts[t]}</span></button>`).join('') || '<span class="meta">None yet</span>'}</div></div>
        <div class="frow">
          ${f.tags.size > 1 ? `<div class="seg small"><button data-act="mode" data-mode="any" class="${f.mode === 'any' ? 'on' : ''}">Any</button><button data-act="mode" data-mode="all" class="${f.mode === 'all' ? 'on' : ''}">All</button></div>` : ''}
          <label class="flabel">Min <input type="number" min="1" max="5" step="1" value="${f.min || ''}" placeholder="–" data-act="min" data-fk="min"></label>
          <button class="chip badf${f.bad ? ' on' : ''}" data-act="bad" title="Only strokes with steps marked bad">⚠ Bad steps</button>
          <div class="seg small"><button data-act="sort" data-sort="time" class="${f.sort === 'time' ? 'on' : ''}">By time</button><button data-act="sort" data-sort="strength" class="${f.sort === 'strength' ? 'on' : ''}">By strength</button></div>
          ${filtered ? '<button class="link" data-act="clear">Clear</button>' : ''}
        </div>
        <label class="play-only${S.regionsOnly ? ' on' : ''}" title="R"><input type="checkbox" data-act="regions" ${S.regionsOnly ? 'checked' : ''}>
          Play only these <span class="meta">${S.listed.length} listed · skips everything else · R</span></label>
      </div>
      <div class="lists">
        <details data-sec="confirmed" ${S.open.confirmed ? 'open' : ''}><summary>Confirmed <span class="meta">${conf.length}</span></summary>
          <ul>${conf.map(row).join('') || '<li class="empty">None' + (filtered ? ' match the filter' : '') + '.</li>'}</ul></details>
        <details data-sec="maybe" ${S.open.maybe ? 'open' : ''}><summary>Maybe <span class="meta">${maybe.length}</span>
          ${maybe.length ? '<button class="link" data-act="confirm-all">Confirm all shown</button>' : ''}</summary>
          <ul>${maybe.map(row).join('') || '<li class="empty">None.</li>'}</ul></details>
      </div>`);
  }

  function setupPanel() {
    const el = $('#panel'), f = S.f;
    const toggle = (set, v) => { set.has(v) ? set.delete(v) : set.add(v); };
    el.addEventListener('click', e => {
      const b = e.target.closest('[data-act]'), item = e.target.closest('.item');
      if (b && b.tagName !== 'INPUT') {
        e.preventDefault();
        const id = item?.dataset.id;
        ({
          close: togglePanel,
          kind: () => toggle(f.kinds, b.dataset.kind), tag: () => toggle(f.tags, b.dataset.tag),
          mode: () => { f.mode = b.dataset.mode; }, sort: () => { f.sort = b.dataset.sort; },
          clear: () => { f.kinds.clear(); f.tags.clear(); f.min = 0; f.bad = false; },
          bad: () => { f.bad = !f.bad; },
          confirm: () => change(() => { S.anns.find(a => a.id === id).maybe = false; }),
          delete: () => removeAnn(id),
          'confirm-all': () => {
            const shown = S.listed.filter(a => a.maybe);
            if (confirm(`Confirm all ${shown.length} maybes shown?`)) change(() => { for (const a of shown) a.maybe = false; });
          },
        })[b.dataset.act]?.();
        b.blur();
        renderAll({ inspector: false });
        return;
      }
      if (item) select(item.dataset.id, true);
    });
    el.addEventListener('dblclick', e => {
      const item = e.target.closest('.item');
      if (item && !e.target.closest('[data-act]')) playAnn(item.dataset.id);
    });
    el.addEventListener('change', e => {
      if (e.target.dataset.act === 'regions') { e.target.blur(); return setRegionsOnly(e.target.checked); }
      if (e.target.dataset.act !== 'min') return;
      f.min = e.target.value === '' ? 0 : clamp(Math.round(Number(e.target.value)) || 0, 0, 5);
      renderAll({ inspector: false });
    });
    el.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.target.blur(); });
    el.addEventListener('toggle', e => {
      const sec = e.target.dataset?.sec;
      if (sec) { S.open[sec] = e.target.open; saveView(); }
    }, true);
  }

  function togglePanel() {
    S.panel = !S.panel;
    store.set('panel', S.panel);
    $('.ed').classList.toggle('panel-closed', !S.panel);
  }

  // ---------------------------------------------------------------- editing

  function pushUndo() {
    S.undo.push(JSON.stringify(S.anns));
    if (S.undo.length > 300) S.undo.shift();
    S.redo = [];
    S.lastKey = null;
  }

  // Apply an edit with undo. Edits with the same key in quick succession (dragging a score) undo as one.
  function change(fn, key = null, opts) {
    const now = performance.now();
    if (!key || key !== S.lastKey || now - S.lastAt > 1500) pushUndo();
    S.lastKey = key;
    S.lastAt = now;
    fn();
    S.anns.sort((a, b) => a.start - b.start);
    renderAll(opts);
    scheduleSave();
  }

  function undoRedo(from, to, word) {
    if (!from.length) return flash(`Nothing to ${word}`);
    to.push(JSON.stringify(S.anns));
    S.anns = JSON.parse(from.pop());
    S.step = null;
    S.lastKey = null;
    if (!selected()) S.sel = null;
    renderAll();
    scheduleSave();
    flash(word === 'undo' ? 'Undone' : 'Redone', 900);
  }

  function select(id, seekTo) {
    S.sel = id;
    const a = selected();
    if (a && seekTo) { seek(a.start); tl.reveal(a.start, a.end); }
    renderAll();
    if (a) showInList(a.id);
  }

  // Scroll just the panel's list to an item. (scrollIntoView would also pan a pinch-zoomed page.)
  function showInList(id) {
    const list = $('#panel .lists'), item = $(`#panel .item[data-id="${id}"]`);
    if (!list || !item) return;
    const top = item.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + item.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + item.offsetHeight - list.clientHeight;
  }

  // Previous/next annotation in the panel's order, or by time from the playhead if none is selected.
  function neighbor(dir) {
    const list = S.listed;
    if (!list.length) return;
    let i = list.findIndex(a => a.id === S.sel);
    if (i < 0) {
      const t = vid.currentTime;
      i = dir > 0 ? list.findIndex(a => a.start > t + 0.05) : list.findLastIndex(a => a.start < t - 0.05);
      if (S.f.sort === 'strength' || i < 0) i = dir > 0 ? 0 : list.length - 1;
    } else i = clamp(i + dir, 0, list.length - 1);
    select(list[i].id, true);
  }

  function removeAnn(id) {
    change(() => { S.anns = S.anns.filter(a => a.id !== id); });
    if (S.sel === id) { S.sel = null; renderAll(); }
  }

  // ⌫: delete the selection (or, with none, the newest mark), then select the next newest mark,
  // so pressing it again keeps going back through what you marked.
  function deleteSel() {
    // a selected step or split-step foot on the stroke on screen goes first, then the one before it
    const owner = S.step && S.anns.find(a => a.drawings?.includes(S.step));
    if (owner && owner === drawTarget()) {
      const i = owner.drawings.indexOf(S.step);
      change(() => { owner.drawings = owner.drawings.filter(d => d !== S.step); });
      selectStep(owner.drawings[Math.min(i, owner.drawings.length) - 1] || null);
      return;
    }
    S.step = null;
    S.marks = S.marks.filter(m => S.anns.some(a => a.id === m.id));
    const id = S.sel || S.marks[S.marks.length - 1]?.id;
    if (!id) return flash('Nothing to delete');
    S.marks = S.marks.filter(m => m.id !== id);
    removeAnn(id);
    const prev = S.marks[S.marks.length - 1];
    if (prev) { S.sel = prev.id; renderAll(); }
  }

  function toggleMaybe() {
    const a = selected();
    if (a) change(() => { a.maybe = !a.maybe; });
  }

  function setEdge(edge) {
    const a = selected(), t = r3(vid.currentTime);
    if (!a) return;
    if (edge === 'start' ? t >= a.end - 0.05 : t <= a.start + 0.05) return flash(`The ${edge === 'start' ? 'in' : 'out'} point has to stay ${edge === 'start' ? 'before the out' : 'after the in'} point`);
    change(() => { a[edge] = t; });
  }

  // ---- marking by holding a key

  function markDown(e) {
    if (S.rec) finishMark();
    const kind = MARK_KEYS[e.code];
    S.rec = { code: e.code, kind, volley: e.shiftKey && kind !== 'serve', start: vid.currentTime };
    const rec = $('#rec');
    rec.hidden = false;
    rec.style.setProperty('--c', KINDS[S.rec.kind].color);
    rec.textContent = `● ${KINDS[S.rec.kind].label}${S.rec.volley ? ` · ${VOLLEY}` : ''}`;
  }

  function finishMark() {
    const r = S.rec;
    S.rec = null;
    $('#rec').hidden = true;
    let start = r.start, end = vid.currentTime;
    if (end - start < MIN_HOLD) { start = r.start - TAP_BEFORE; end = r.start + TAP_AFTER; }
    start = r3(clamp(start, 0, dur));
    end = r3(clamp(end, 0, dur));
    if (end - start < 0.1) return renderTimeline();
    const a = { id: newId(), kind: r.kind, start, end, maybe: false, tags: r.volley ? [{ name: VOLLEY, score: 5 }] : [], source: 'manual' };
    change(() => { S.anns.push(a); });
    S.marks.push({ id: a.id, at: r.start });
    S.sel = a.id;
    renderAll();
  }

  // Z: take back the last mark and rewind to just before its key went down, to mark it again.
  function undoMark() {
    if (S.rec) {
      const at = S.rec.start;
      S.rec = null;
      $('#rec').hidden = true;
      renderTimeline();
      seek(at - REWIND);
      return flash('Mark cancelled');
    }
    while (S.marks.length) {
      const m = S.marks.pop(), a = S.anns.find(x => x.id === m.id);
      if (!a) continue;
      removeAnn(a.id);
      seek(m.at - REWIND);
      return flash(`Removed ${KINDS[a.kind].label} · rewound`);
    }
    flash('No mark to take back');
  }

  // ---------------------------------------------------------------- footwork drawings
  // Marks on the video, stored on a stroke as fractions of the frame and shown while the playhead
  // is in that stroke: steps (type point, numbered in order) and the two feet at the split step.

  // The forehand or backhand the playhead is in (the later one where two overlap): the only one
  // whose drawings show, and the one new drawings go on. Paused outside any, the selected one.
  function strokeAt(t) {
    return S.anns.filter(a => FOOTWORK.includes(a.kind) && t >= a.start && t <= a.end).sort((a, b) => b.start - a.start)[0];
  }

  function drawTarget() {
    const sel = selected();
    return strokeAt(vid.currentTime) || (sel && FOOTWORK.includes(sel.kind) ? sel : undefined);
  }

  function setTool(tool) {
    S.tool = S.tool === tool ? null : tool;
    if (S.tool) {
      vid.pause();
      const a = drawTarget();
      if (!a) { S.tool = null; flash('Footwork goes on a forehand or backhand: select one or pause inside one'); }
      else if (S.sel !== a.id) select(a.id, false);
      if (S.tool) flash(`Click to place steps on ${KINDS[a.kind].label} · ⇧-click: lands with the previous · ⌥-click for split-step feet · Esc when done`, 2500);
    }
    $('#screen').classList.toggle('drawing', !!S.tool);
    document.querySelectorAll('.tools [data-t]').forEach(b => b.classList.toggle('on', b.dataset.t === S.tool));
    S.drawKey = null;
  }

  // Where the picture sits inside the video element (letterboxed by object-fit: contain).
  function picture() {
    const cw = vid.clientWidth, ch = vid.clientHeight, vw = vid.videoWidth || 16, vh = vid.videoHeight || 9;
    const scale = Math.min(cw / vw, ch / vh), w = vw * scale, h = vh * scale;
    return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
  }

  function renderDrawings() {
    const target = S.tool ? drawTarget() : strokeAt(vid.currentTime);
    const shown = target?.drawings?.length ? [target] : [];
    const p = picture();
    const key = JSON.stringify([shown.map(a => [a.id, a.drawings, a.drawings.indexOf(S.step)]), p, S.tool]);
    if (key === S.drawKey) return;
    S.drawKey = key;
    const X = x => p.x + x * p.w, Y = y => p.y + y * p.h;
    let html = '';
    for (const a of shown) {
      const nums = stepNumbers(a.drawings);
      let last = null, ties = '';
      a.drawings.forEach((d, i) => {
        const data = `data-ann="${a.id}" data-i="${i}"${d === S.step ? ' data-sel' : ''}`;
        if (d.type === 'point') {
          // a tied step lands together with the one before (a hop): same number, joined by a line
          if (d.tie && last) ties += `<line class="tie" x1="${X(last.x)}" y1="${Y(last.y)}" x2="${X(d.x)}" y2="${Y(d.y)}"/>`;
          last = d;
        }
        const title = `<title>${esc(d.type === 'split' ? `Split step${d.name ? `: ${d.name}` : ''}` : `${nums[i]}${d.name ? `. ${d.name}` : ''}`)}</title>`;
        const bad = badStep(d) ? ' bad' : '';
        if (d.type === 'split') html += `<g class="split${bad}" ${data}>${title}<circle class="hit" cx="${X(d.x)}" cy="${Y(d.y)}" r="10"/><circle cx="${X(d.x)}" cy="${Y(d.y)}" r="4.5"/><circle class="dot" cx="${X(d.x)}" cy="${Y(d.y)}" r="1.2"/></g>`;
        else html += `<g class="point${bad}" ${data}>${title}<circle class="hit" cx="${X(d.x)}" cy="${Y(d.y)}" r="10"/><circle cx="${X(d.x)}" cy="${Y(d.y)}" r="5"/><text x="${X(d.x)}" y="${Y(d.y)}">${nums[i]}</text></g>`;
      });
      html = ties + html;
    }
    $('#draw').innerHTML = html;
  }

  function setupDrawing() {
    const svg = $('#draw');
    const at = e => {
      const r = vid.getBoundingClientRect(), p = picture();
      const f = v => Math.round(clamp(v, 0, 1) * 10000) / 10000;
      return [f((e.clientX - r.left - p.x) / p.w), f((e.clientY - r.top - p.y) / p.h)];
    };
    const add = d => {
      const a = drawTarget();
      if (!a) return flash('Footwork goes on a forehand or backhand: move into one');
      if (S.sel !== a.id) S.sel = a.id;
      change(() => {
        let ds = [...(a.drawings || []), d];
        const splits = ds.filter(x => x.type === 'split');
        if (splits.length > 2) ds = ds.filter(x => x !== splits[0]);  // two feet: a third click replaces the oldest
        a.drawings = ds.slice(-60);
      });
      selectStep(d);  // so ⌫ takes it back
    };
    // Drag a step or foot to move it.
    const drag = (e, g) => {
      const a = S.anns.find(x => x.id === g.dataset.ann), d = a?.drawings[Number(g.dataset.i)];
      if (!d) return;
      selectStep(d);  // clicking a step selects it, for ⌫
      let moved = false;
      const move = ev => {
        if (!moved) { pushUndo(); moved = true; }
        [d.x, d.y] = at(ev);
        S.drawKey = null;
      };
      addEventListener('pointermove', move);
      addEventListener('pointerup', () => {
        removeEventListener('pointermove', move);
        if (moved) { renderAll(); scheduleSave(); }
      }, { once: true });
    };
    // ⌥-click, tool or not: a foot at the split step. With the step tool: a step.
    $('#screen').addEventListener('pointerdown', e => {
      const g = e.target.closest('#draw [data-ann]');
      if (g && e.button === 0 && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        vid.pause();
        return drag(e, g);
      }
      if (e.button !== 0 || !(e.altKey || (S.tool && e.target.closest('#draw')))) return;
      e.preventDefault();
      e.stopPropagation();
      vid.pause();
      const [x, y] = at(e);
      const tie = !e.altKey && e.shiftKey && drawTarget()?.drawings?.some(d => d.type === 'point');
      add({ type: e.altKey ? 'split' : 'point', x, y, ...(tie ? { tie: true } : {}) });
    }, true);
    svg.addEventListener('contextmenu', e => {
      const g = e.target.closest('[data-ann]');
      if (!g) return;
      e.preventDefault();
      const a = S.anns.find(x => x.id === g.dataset.ann), i = Number(g.dataset.i);
      if (a) change(() => { a.drawings = a.drawings.filter((_, k) => k !== i); });
    });
    new ResizeObserver(() => { S.drawKey = null; }).observe(vid);
  }

  // ---------------------------------------------------------------- playback

  function seek(t) {
    S.stopAt = null;
    vid.currentTime = clamp(t, 0, dur);
    tl?.setTime(vid.currentTime);
  }

  function togglePlay() {
    if (!vid.paused) return vid.pause();
    const t = vid.currentTime;
    if (S.regionsOnly && !S.playlist.some(w => w.end > t + 0.05)) {
      if (!S.playlist.length) return flash('Nothing listed to play. Check the filter.');
      seek(S.playlist[0].start);
    } else if (!S.regionsOnly && t >= dur - 0.05) seek(0);
    vid.play().catch(() => {});
  }

  function playAnn(id) {
    const a = S.anns.find(x => x.id === id);
    if (!a) return;
    if (S.sel !== id) select(id, false);
    seek(a.start);
    tl.reveal(a.start, a.end);
    S.stopAt = a.end;
    vid.play().catch(() => {});
  }

  function stepFrame(dir, seconds = null) {
    vid.pause();
    skip(dir * (seconds ?? 1 / (S.v.fps || 30)));
  }

  // Move the playhead by dt seconds. With Play only these on, time between the listed
  // annotations doesn't count: it moves through them as if they were joined end to end.
  function skip(dt) {
    const w = S.playlist, t = vid.currentTime;
    if (!S.regionsOnly || !w.length) return seek(t + dt);
    let reel = 0;  // where t is in the joined-up regions (a gap counts as the next region's start)
    for (const x of w) {
      if (t < x.start) break;
      if (t < x.end) { reel += t - x.start; break; }
      reel += x.end - x.start;
    }
    const total = w.reduce((s, x) => s + x.end - x.start, 0);
    let r = clamp(reel + dt, 0, total - 1e-3);
    for (const x of w) {
      if (r < x.end - x.start) return seek(x.start + r);
      r -= x.end - x.start;
    }
  }

  function setRegionsOnly(on) {
    S.regionsOnly = on;
    saveView();
    renderPanel();
    vid.loop = S.loop && !on;
    flash(on ? 'Playing marked regions only' : 'Playing everything', 1200);
  }

  function tick() {
    const t = vid.currentTime;
    if (!vid.paused && !vid.seeking) {
      if (S.stopAt != null && t >= S.stopAt) {
        vid.pause();
        S.stopAt = null;
      } else if (S.regionsOnly && S.stopAt == null) {
        // in a gap between listed annotations: jump to the next one
        if (!S.playlist.some(w => t >= w.start - 0.05 && t < w.end)) {
          const next = S.playlist.find(w => w.start > t);
          if (next) vid.currentTime = next.start;
          else if (S.loop && S.playlist.length) vid.currentTime = S.playlist[0].start;
          else vid.pause();
        }
      }
    }
    tl.setTime(t, !vid.paused);
    $('#time').textContent = `${fmt(t, true)} / ${fmt(dur, true)}`;
    $('#played').style.width = `${t / dur * 100}%`;
    if (S.rec) renderTimeline();
    followPlayhead(t);
    renderDrawings();
    raf = requestAnimationFrame(tick);
  }

  // Select the annotation under the playhead whenever the playhead moves into a different one
  // (a listed one first, then the later-starting one). A selection made by hand stays until then.
  function followPlayhead(t) {
    const under = S.anns.filter(a => t >= a.start && t < a.end)
      .sort((a, b) => S.dim.has(a.id) - S.dim.has(b.id) || b.start - a.start)[0]?.id ?? null;
    if (under === S.under) return;
    const typing = document.activeElement?.matches('#inspector input:not([type=range]), #inspector select') || document.querySelector('.picker');  // mid-edit on the selected one
    if (typing || S.rec || tl.dragging) return;  // try again once that's over
    S.under = under;
    if (under && under !== S.sel) select(under, false);
  }

  function setupScrubber() {
    const el = $('#scrubber');
    const at = e => { const r = el.getBoundingClientRect(); return clamp((e.clientX - r.left) / r.width, 0, 1) * dur; };
    el.addEventListener('pointerdown', e => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      S.wasPlaying = !vid.paused;
      vid.pause();
      seek(at(e));
      const move = ev => seek(at(ev));
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', () => {
        el.removeEventListener('pointermove', move);
        if (S.wasPlaying) vid.play().catch(() => {});
      }, { once: true });
    });
  }

  // ---------------------------------------------------------------- keys

  function onKeyDown(e) {
    if (!vid || document.querySelector('dialog[open]')) return;
    const t = e.target;
    if (t.matches?.('input:not([type=checkbox]):not([type=range]), textarea, select')) {
      // a number box (score, min) only takes numbers: any other key saves it and works as a shortcut
      const editing = /^[\d.]$|^(Backspace|Delete|Arrow\w+|Tab|Enter|Escape)$/.test(e.key) || e.metaKey || e.ctrlKey;
      if (!(t.type === 'number' && !editing)) {
        if (e.key === 'Escape') t.blur();
        return;
      }
      t.blur();
    }
    if (e.metaKey || e.ctrlKey) {
      if (e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) undoRedo(S.redo, S.undo, 'redo');
        else undoRedo(S.undo, S.redo, 'undo');
      }
      return;
    }
    if (e.altKey) return;
    if (MARK_KEYS[e.code]) {
      e.preventDefault();
      if (!e.repeat) markDown(e);
      return;
    }
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const fn = {
      ' ': togglePlay, k: togglePlay,
      ArrowLeft: () => stepFrame(-1, e.shiftKey ? 1 : null), ArrowRight: () => stepFrame(1, e.shiftKey ? 1 : null),
      ArrowUp: () => neighbor(-1), ArrowDown: () => neighbor(1),
      j: () => skip(-5), l: () => skip(5),
      z: undoMark, Enter: toggleMaybe, Backspace: deleteSel, Delete: deleteSel,
      i: () => setEdge('start'), o: () => setEdge('end'),
      p: () => S.sel && playAnn(S.sel), r: () => setRegionsOnly(!S.regionsOnly), m: () => { vid.muted = !vid.muted; },
      t: () => { const b = S.sel && $('#inspector .add-tag'); if (b) pickLabel(b); else flash('Select an annotation to tag it'); },
      '\\': togglePanel, '=': () => tl.zoomBy(1.6), '+': () => tl.zoomBy(1.6), '-': () => tl.zoomBy(1 / 1.6), 0: () => tl.fit(),
      d: () => setTool('point'),
      Escape: () => { if (S.step) selectStep(null); else if (S.tool) setTool(null); else if (S.sel) select(null); }, '?': () => $('#help-dlg').showModal(),
    }[k];
    if (!fn) return;
    e.preventDefault();
    if (t.closest?.('button, input')) t.blur();  // so Space doesn't also press a focused button
    fn();
  }

  function onKeyUp(e) {
    if (S.rec && e.code === S.rec.code) finishMark();
  }

  // ---------------------------------------------------------------- saving and syncing

  function scheduleSave() {
    S.dirty = true;
    setSaveState('Unsaved');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 600);
  }

  async function saveNow() {
    clearTimeout(saveTimer);
    if (S.saving) { S.dirty = true; return; }
    S.saving = true;
    S.dirty = false;
    setSaveState('Saving…');
    try {
      const r = await api(`${base}/annotations`, { method: 'PUT', json: { base_rev: S.rev, annotations: S.anns } });
      S.rev = r.rev;
      if (r.added.length || r.removed.length) {  // a plugin added or replaced some since we loaded
        const gone = new Set(r.removed), have = new Set(S.anns.map(a => a.id));
        S.anns = [...S.anns.filter(a => !gone.has(a.id)), ...r.added.filter(a => !have.has(a.id))].sort((a, b) => a.start - b.start);
        S.undo = [];
        S.redo = [];
        if (!selected()) S.sel = null;
        if (r.removed.length) S.dirty = true;  // the server already dropped them; save so the page agrees
        if (alive && vid) renderAll();
      }
      applyStatus(r);
      if (alive) setSaveState(S.dirty ? 'Unsaved' : 'Saved');
    } catch (e) {
      S.dirty = true;
      if (alive) setSaveState(`Couldn’t save: ${e.message}`);
    }
    S.saving = false;
    if (S.dirty && alive) scheduleSave();
  }

  function applyStatus(r) {
    if (!alive) return;
    const was = S.job;
    S.job = r.job;
    S.final = r.final;
    renderJob();
    if (vid) renderExport();
    if (jobRunning(was) && r.job?.stage === 'done' && r.job.result?.added != null) {
      flash(`${r.job.label}: found ${r.job.result.added}. They’re in Maybe.`, 4000);
    }
    if (jobRunning(r.job) || r.rev !== S.rev) poll();
  }

  function poll() {
    if (pollTimer) return;
    pollTimer = setTimeout(async () => {
      pollTimer = null;
      let r;
      try { r = await api(`${base}/status`); } catch { if (alive) poll(); return; }
      if (!alive) return;
      if (r.rev !== S.rev && !S.saving) saveNow();  // something else changed the project: merge it in
      else applyStatus(r);
    }, 1000);
  }

  async function startExport() {
    while (S.saving) await new Promise(r => setTimeout(r, 100));
    if (S.dirty) await saveNow();
    try { applyStatus(await api(`${base}/export`, { method: 'POST' })); } catch (e) { alert(e.message); }
  }

  // ---------------------------------------------------------------- timeline media

  async function loadMedia() {
    let m;
    try { m = await api(`${base}/media`); } catch (e) { return tl.setMediaNote(`No filmstrip: ${e.message}`); }
    if (!alive) return;
    if (m.error) return tl.setMediaNote(`No filmstrip: ${m.error}`);
    if (m.pending) {
      tl.setMediaNote('Making filmstrip and waveform…');
      mediaTimer = setTimeout(loadMedia, 1500);
      return;
    }
    tl.setMediaNote('');
    let wave = null;
    const film = new Image();
    film.onload = () => { if (alive) tl.setMedia(m, film, wave); };
    film.src = `${base}/filmstrip.jpg`;
    try { wave = new Uint8Array(await (await fetch(`${base}/wave.bin`)).arrayBuffer()); } catch {}
    if (alive) tl.setMedia(m, film, wave);
  }

  // ---------------------------------------------------------------- plugins

  function openPlugins() {
    const dlg = $('#plugins-dlg');
    let name = store.get('plugin', info.plugins[0]?.name);
    if (!info.plugins.some(p => p.name === name)) name = info.plugins[0]?.name;
    let box = null;
    const frame = document.createElement('canvas');  // the current frame, to draw the box on
    frame.width = vid.videoWidth || 1280;
    frame.height = vid.videoHeight || 720;
    try { frame.getContext('2d').drawImage(vid, 0, 0, frame.width, frame.height); } catch {}

    const render = () => {
      const p = info.plugins.find(x => x.name === name);
      const last = S.v.plugins?.[p.name] || {};
      if (p.needs_box && !box) box = last.far_box || info.last_far_box || null;
      dlg.innerHTML = `<form method="dialog">
        <h2>Plugins</h2>
        <p class="hint">What a plugin finds comes in as maybes for you to confirm. Running one again replaces its maybes you haven’t tagged.</p>
        <div class="plugin-list">${info.plugins.map(x => `<label class="plugin${x.name === name ? ' on' : ''}">
          <input type="radio" name="plugin" value="${x.name}" ${x.name === name ? 'checked' : ''}>
          <span><strong>${esc(x.label)}</strong> <span class="badge" style="--c:${KINDS[x.kind].color}">${esc(KINDS[x.kind].label)}</span>
          <span class="meta">${esc(x.about)}</span></span></label>`).join('')}</div>
        ${Object.entries(p.choices).map(([k, vals]) => `<label class="opt">${esc(k[0].toUpperCase() + k.slice(1))}
          <select data-opt="${k}">${vals.map(v => `<option ${v === (last[k] || vals[0]) ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>`).join('')}
        ${p.needs_box ? `<p class="hint">Drag a box around the far baseline on this frame: where the far player serves from, both sides of the
          center mark, with about two player-heights of room above for the toss.</p>
          <div class="boxer" id="boxer"><div class="sel" id="sel" hidden></div></div>` : ''}
        <div class="row end"><button class="btn" value="cancel">Cancel</button><button class="btn primary" id="run-plugin" value="run">Run</button></div>
      </form>`;
      dlg.querySelectorAll('input[name=plugin]').forEach(r => r.addEventListener('change', () => { name = r.value; store.set('plugin', name); render(); }));
      if (p.needs_box) setupBoxer();
      dlg.querySelector('#run-plugin').addEventListener('click', async e => {
        e.preventDefault();
        const options = {};
        dlg.querySelectorAll('[data-opt]').forEach(s => { options[s.dataset.opt] = s.value; });
        if (p.needs_box) options.far_box = box;
        try {
          applyStatus(await api(`${base}/plugins/${enc(p.name)}`, { method: 'POST', json: options }));
          S.v.plugins = { ...S.v.plugins, [p.name]: options };
          if (box) info.last_far_box = box;
          dlg.close();
        } catch (err) { alert(err.message); }
      });
    };

    // drag a rectangle on the frame; box is [x0, y0, x1, y1] fractions
    function setupBoxer() {
      const el = dlg.querySelector('#boxer'), sel = dlg.querySelector('#sel'), run = dlg.querySelector('#run-plugin');
      el.prepend(frame);
      const show = () => {
        run.disabled = !(box && box[2] - box[0] >= 0.05 && box[3] - box[1] >= 0.05);
        sel.hidden = !box;
        if (!box) return;
        const [x0, y0, x1, y1] = box;
        Object.assign(sel.style, { left: `${x0 * 100}%`, top: `${y0 * 100}%`, width: `${(x1 - x0) * 100}%`, height: `${(y1 - y0) * 100}%` });
      };
      const pt = e => {
        const r = el.getBoundingClientRect();
        return [clamp((e.clientX - r.left) / r.width, 0, 1), clamp((e.clientY - r.top) / r.height, 0, 1)];
      };
      let start = null;
      el.onpointerdown = e => { e.preventDefault(); el.setPointerCapture(e.pointerId); start = pt(e); box = [...start, ...start]; show(); };
      el.onpointermove = e => {
        if (!start) return;
        const p = pt(e);
        box = [Math.min(start[0], p[0]), Math.min(start[1], p[1]), Math.max(start[0], p[0]), Math.max(start[1], p[1])];
        show();
      };
      el.onpointerup = el.onpointercancel = () => { start = null; };
      show();
    }

    vid.pause();
    render();
    dlg.showModal();
  }

  return cleanup;
}
