'use strict';

const app = document.getElementById('app');
const $ = (sel, el = document) => el.querySelector(sel);
const enc = encodeURIComponent;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const BACK = '<a class="back" href="#/">‹ Videos</a>';
// Finder buttons only make sense in a browser on the Mac running the server; set from /api/info
let onServerMac = false;
let macName = 'your Mac';
let inboxError = null;

const reveal = stem => api(`/api/reveal${stem ? `?stem=${enc(stem)}` : ''}`, { method: 'POST' })
  .catch(e => alert(e.message));

async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch {}
    throw new Error(msg);
  }
  return r.json();
}

const isExportJob = j => j && (j.stage === 'exporting' || j.next === 'exporting');

function jobText(j) {
  if (j.error) return `${isExportJob(j) ? 'Export' : 'Finding shots'} failed: ${j.error}`;
  if (j.stage === 'queued') return 'Waiting for another video to finish…';
  return `${isExportJob(j) ? 'Exporting' : 'Finding shots'}… ${Math.round(j.progress * 100)}%`;
}

// ---------------------------------------------------------------- routing

let cleanup = () => {};

function route() {
  cleanup();
  cleanup = () => {};
  const m = location.hash.match(/^#\/v\/(.+)$/);
  if (m) showProject(decodeURIComponent(m[1]));
  else showLibrary();
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', route);

// ---------------------------------------------------------------- library

function showLibrary() {
  app.innerHTML = `
    <section class="card">
      <strong>How it works</strong>
      <ol class="steps">
        <li>AirDrop session videos from your iPhone to <b>${esc(macName)}</b>. They show up below automatically.</li>
        <li>Open one, drop the clips that aren’t shots, and tap <b>Export</b>.</li>
        <li>On your Mac, AirDrop the <b>_final.mp4</b> from the out folder back to your iPhone.</li>
      </ol>
      ${onServerMac ? '<button class="btn" id="open-out" style="margin-top:12px">Show in Finder</button>' : ''}
      ${inboxError ? `<p class="hint error">${esc(inboxError)}</p>` : ''}
    </section>
    <h2>Videos</h2>
    <ul class="videos" id="videos"><li class="empty">Loading…</li></ul>`;

  $('#open-out')?.addEventListener('click', () => reveal());

  // keep checking, so AirDropped videos and job progress show up on their own
  let timer, alive = true;
  cleanup = () => { alive = false; clearTimeout(timer); };
  (async function refresh() {
    try {
      const vids = await api('/api/videos');
      if (!alive) return;
      $('#videos').innerHTML = vids.length
        ? vids.map(videoRow).join('')
        : '<li class="empty">No videos yet. AirDrop one from your iPhone.</li>';
    } catch (e) {
      if (alive) $('#videos').innerHTML = `<li class="error">${esc(e.message)}</li>`;
    }
    if (alive) timer = setTimeout(refresh, 2000);
  })();
}

function videoStatus(v) {
  if (v.job) return jobText(v.job);
  if (v.clips == null) return 'Not analyzed yet';
  const parts = [`${v.clips} clips`];
  if (v.maybes) parts.push(`${v.maybes} maybe`);
  if (v.dropped) parts.push(`${v.dropped} dropped`);
  if (v.final_current) parts.push('exported');
  return parts.join(' · ');
}

const videoRow = v => `
  <li class="video card">
    <a class="video-link" href="#/v/${enc(v.stem)}">
      <span class="name">${esc(v.name)}</span>
      <span class="meta">${esc(videoStatus(v))}</span>
    </a>
  </li>`;

// ---------------------------------------------------------------- project

function showProject(stem) {
  const base = `/api/videos/${enc(stem)}`;
  const S = { v: null, mode: null, idx: -1, filter: 'all', auto: true, dropped: new Set() };
  let alive = true, pollTimer = null, raf = null, saveTimer = null, clips = [], vid = null;

  app.innerHTML = `${BACK}<p class="hint">Loading…</p>`;
  cleanup = () => {
    alive = false;
    clearTimeout(pollTimer);
    cancelAnimationFrame(raf);
    document.removeEventListener('keydown', onKey);
    if (saveTimer) saveNow(true);
    if (vid) { vid.pause(); vid.removeAttribute('src'); vid.load(); }
  };
  document.addEventListener('keydown', onKey);

  api(base).then(v => {
    if (!alive) return;
    S.v = v;
    render();
    if (v.job && !v.job.error) poll();
  }).catch(e => { app.innerHTML = `${BACK}<p class="error">${esc(e.message)}</p>`; });

  const modeFor = v => (v.clips == null || (v.job && !isExportJob(v.job))) ? 'status' : 'review';

  function render() {
    S.mode = modeFor(S.v);
    if (S.mode === 'status') renderStatus();
    else renderReview();
  }

  function poll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      let v;
      try { v = await api(base); } catch { if (alive) poll(); return; }
      if (!alive) return;
      S.v = { ...S.v, ...v };
      if (modeFor(S.v) !== S.mode) render();
      else if (S.mode === 'status') renderStatus();
      else renderExport();
      if (v.job && !v.job.error) poll();
    }, 1200);
  }

  // ---- finding shots

  function renderStatus() {
    const j = S.v.job;
    let body = '<p>Not analyzed yet.</p>';
    if (j) {
      body = `<p>${esc(jobText(j))}</p>`;
      if (!j.error) {
        body += `<div class="bar"><div style="width:${j.progress * 100}%"></div></div>
          <p class="hint">Takes a few minutes the first time (about 4 for a 9-minute video).
          You can leave this page; it keeps going on your Mac.</p>`;
      }
    }
    const canStart = !j || j.error;
    app.innerHTML = `${BACK}<h1>${esc(S.v.name)}</h1>
      <section class="card" style="margin-top:12px">${body}
        ${canStart ? `<button class="btn primary big" id="detect" style="margin-top:12px">${j ? 'Try again' : 'Find shots'}</button>` : ''}
      </section>`;
    $('#detect')?.addEventListener('click', startDetect);
  }

  async function startDetect() {
    try {
      S.v = { ...S.v, ...(await api(`${base}/detect`, { method: 'POST' })) };
    } catch (e) { return alert(e.message); }
    render();
    poll();
  }

  // ---- review

  function renderReview() {
    clips = S.v.clip_list;
    S.dropped = new Set(S.v.dropped_list);
    app.innerHTML = `${BACK}
      <h1>${esc(S.v.name)}</h1>
      <p class="meta" id="summary"></p>
      <div class="layout">
        <div class="side">
        <section class="card player">
          <video id="vid" playsinline preload="metadata" src="${base}/source"></video>
          <div class="body">
            <div class="now" id="now"></div>
            <div class="controls">
              <button class="btn" id="prev">‹ Prev</button>
              <button class="btn" id="play">Play</button>
              <button class="btn" id="next">Next ›</button>
            </div>
            <button class="btn big toggle" id="toggle"></button>
            <label class="auto"><input type="checkbox" id="auto" ${S.auto ? 'checked' : ''}> Auto-play next clip</label>
            <p class="hint keys">Keys: space play/pause · ← → prev/next · D drop/keep</p>
          </div>
        </section>
        <div class="card export" id="export"></div>
        </div>
        <section>
          <div class="filters" id="filters"></div>
          <ul class="clips" id="clips"></ul>
          <details class="more"><summary>More</summary>
            <button class="btn" id="redetect">Re-run shot detection</button>
            <p class="hint">Finds clips again from scratch and clears your drops.</p>
          </details>
        </section>
      </div>`;

    vid = $('#vid');
    vid.addEventListener('click', togglePlay);
    vid.addEventListener('play', () => { $('#play').textContent = 'Pause'; });
    vid.addEventListener('pause', () => { $('#play').textContent = 'Play'; });
    vid.addEventListener('loadedmetadata', () => {
      const c = clips[S.idx];
      if (c && (vid.currentTime < c.start - 0.3 || vid.currentTime > c.end)) vid.currentTime = c.start;
    });
    vid.addEventListener('error', () => {
      $('#now').innerHTML = '<span class="error">This browser can’t play this video. Try Safari or Chrome.</span>';
    });
    $('#play').addEventListener('click', togglePlay);
    $('#prev').addEventListener('click', () => go(-1));
    $('#next').addEventListener('click', () => go(1));
    $('#toggle').addEventListener('click', () => clips[S.idx] && toggleDrop(clips[S.idx].n));
    $('#auto').addEventListener('change', e => { S.auto = e.target.checked; });
    $('#redetect').addEventListener('click', () => {
      if (confirm('Find clips again from scratch? This clears your drops.')) startDetect();
    });
    $('#filters').addEventListener('click', e => {
      const b = e.target.closest('button[data-f]');
      if (!b) return;
      S.filter = b.dataset.f;
      renderFilters();
      renderList();
      if (!visible().includes(clips[S.idx])) {
        const first = step(1, -1);
        if (first != null) select(first, false);
      }
    });
    $('#clips').addEventListener('click', e => {
      const row = e.target.closest('.clip');
      if (!row) return;
      const i = Number(row.dataset.i);
      if (e.target.closest('.drop-toggle')) toggleDrop(clips[i].n);
      else select(i, true);
    });

    renderSummary();
    renderFilters();
    if (clips.length) select(S.idx >= 0 && S.idx < clips.length ? S.idx : 0, false);
    else $('#now').textContent = 'No shots found in this video.';
    renderExport();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
  }

  const visible = () => clips.filter(c =>
    S.filter === 'maybe' ? c.maybe : S.filter === 'dropped' ? S.dropped.has(c.n) : true);

  // next (dir 1) or previous (dir -1) visible clip index after `from`
  function step(dir, from = S.idx) {
    const idxs = visible().map(c => clips.indexOf(c));
    return dir > 0 ? idxs.find(k => k > from) ?? null : idxs.reverse().find(k => k < from) ?? null;
  }

  function go(dir) {
    const n = step(dir);
    if (n != null) select(n, true);
  }

  function select(i, play) {
    S.idx = i;
    vid.currentTime = clips[i].start;
    if (play) vid.play().catch(() => {});
    renderNow();
    renderList();
    if (matchMedia('(min-width: 860px)').matches) {
      $(`.clip[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest' });
    }
  }

  function togglePlay() {
    const c = clips[S.idx];
    if (!c) return;
    if (!vid.paused) return vid.pause();
    if (vid.currentTime >= c.end - 0.05 || vid.currentTime < c.start - 0.3) vid.currentTime = c.start;
    vid.play().catch(() => {});
  }

  // stop (or move on) at the end of each clip
  function tick() {
    const c = clips[S.idx];
    if (c && !vid.paused && !vid.seeking && vid.currentTime >= c.end) {
      const n = S.auto ? step(1) : null;
      if (n != null) select(n, true);
      else vid.pause();
    }
    raf = requestAnimationFrame(tick);
  }

  function toggleDrop(n) {
    if (S.dropped.has(n)) S.dropped.delete(n);
    else S.dropped.add(n);
    renderNow();
    renderList();
    renderFilters();
    renderSummary();
    renderExport();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveNow(), 400);
  }

  const droppedList = () => [...S.dropped].sort((a, b) => a - b);

  async function saveNow(leaving = false) {
    clearTimeout(saveTimer);
    saveTimer = null;
    const req = api(`${base}/dropped`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dropped: droppedList() }),
      keepalive: leaving,
    });
    try {
      const v = await req;
      if (alive) { S.v = { ...S.v, ...v, dropped_list: droppedList() }; renderExport(); }
    } catch (e) {
      if (alive) alert(`Couldn’t save your drops: ${e.message}`);
    }
  }

  function renderSummary() {
    const maybes = clips.filter(c => c.maybe).length;
    $('#summary').textContent = `${clips.length} clips · ${maybes} maybe · ${S.dropped.size} dropped`;
  }

  function renderNow() {
    const c = clips[S.idx];
    if (!c) return;
    const dropped = S.dropped.has(c.n);
    $('#now').innerHTML = `Clip ${c.n} <span class="meta">· ${fmt(c.start)} in original</span>
      ${c.maybe ? '<span class="badge">maybe</span>' : ''}`;
    const t = $('#toggle');
    t.className = `btn big toggle ${dropped ? 'dropped' : 'keep'}`;
    t.textContent = dropped ? '✕ Dropped · tap to keep' : '✓ Keeping · tap to drop';
  }

  function renderFilters() {
    const counts = { all: clips.length, maybe: clips.filter(c => c.maybe).length, dropped: S.dropped.size };
    $('#filters').innerHTML = [['all', 'All'], ['maybe', 'Maybes'], ['dropped', 'Dropped']]
      .map(([f, label]) => `<button data-f="${f}" class="${S.filter === f ? 'on' : ''}">${label} (${counts[f]})</button>`)
      .join('');
  }

  function renderList() {
    const rows = visible().map(c => {
      const i = clips.indexOf(c), dropped = S.dropped.has(c.n);
      return `<li class="clip${dropped ? ' dropped' : ''}${i === S.idx ? ' current' : ''}" data-i="${i}">
        <button class="play-clip"><span class="n">#${c.n}</span><span class="t">${fmt(c.start)}</span>
          ${c.maybe ? '<span class="badge">maybe</span>' : ''}</button>
        <button class="drop-toggle" aria-pressed="${dropped}">${dropped ? 'Dropped' : 'Keep'}</button>
      </li>`;
    });
    $('#clips').innerHTML = rows.join('') || '<li class="empty">Nothing here.</li>';
  }

  function renderExport() {
    const el = $('#export');
    if (!el) return;
    const kept = clips.filter(c => !S.dropped.has(c.n));
    const dur = kept.reduce((s, c) => s + c.end - c.start, 0);
    const j = S.v.job && isExportJob(S.v.job) ? S.v.job : null;
    const final = S.v.final;
    const current = final && JSON.stringify(final.dropped) === JSON.stringify(droppedList());
    let html = `<div><strong>Final video</strong><p class="meta">${kept.length} clips · ${fmt(dur)}</p></div>`;

    if (j && !j.error) {
      html += `<div><p class="meta">${esc(jobText(j))}</p><div class="bar"><div style="width:${j.progress * 100}%"></div></div></div>`;
    } else {
      if (j?.error) html += `<p class="error">${esc(jobText(j))}</p>`;
      if (current) {
        const canShare = window.isSecureContext && navigator.canShare;
        html += `<p class="meta">✓ Exported with your current picks.</p>
          <div class="row">
            ${onServerMac ? '<button class="btn primary" id="reveal">Show in Finder</button>' : ''}
            <a class="btn${onServerMac ? '' : ' primary'}" href="${base}/final" download>Download</a>
            ${canShare ? '<button class="btn" id="share">Share…</button>' : ''}
          </div>
          ${onServerMac ? '<p class="hint">In Finder, right-click the video → Share → AirDrop → your iPhone.</p>' : ''}
          ${isIOS ? '<p class="hint">After downloading, tap the download icon in Safari’s address bar, open the video, then Share → Save Video.</p>' : ''}`;
      } else {
        html += `<button class="btn primary big" id="export-btn" ${kept.length ? '' : 'disabled'}>
            ${final ? 'Re-export with current picks' : 'Export final video'}</button>
          ${final ? '<p class="hint">Your picks changed since the last export.</p>' : ''}`;
      }
    }
    el.innerHTML = html;
    $('#export-btn')?.addEventListener('click', startExport);
    $('#share')?.addEventListener('click', share);
    $('#reveal')?.addEventListener('click', () => reveal(stem));
  }

  async function startExport() {
    if (saveTimer) await saveNow();
    try {
      S.v = { ...S.v, ...(await api(`${base}/export`, { method: 'POST' })) };
    } catch (e) { return alert(e.message); }
    renderExport();
    poll();
  }

  async function share() {
    const blob = await (await fetch(`${base}/final`)).blob();
    const file = new File([blob], `${stem}_final.mp4`, { type: 'video/mp4' });
    if (navigator.canShare({ files: [file] })) navigator.share({ files: [file] }).catch(() => {});
  }

  function onKey(e) {
    if (S.mode !== 'review' || !clips.length || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.matches('input, textarea')) return;
    const keys = {
      ' ': togglePlay, k: togglePlay,
      ArrowRight: () => go(1), ArrowLeft: () => go(-1),
      d: () => toggleDrop(clips[S.idx].n), x: () => toggleDrop(clips[S.idx].n),
    };
    const fn = keys[e.key];
    if (!fn) return;
    e.preventDefault();
    if (e.target.closest('button')) e.target.blur();  // so space doesn't also click it
    fn();
  }
}

api('/api/info')
  .then(info => {
    onServerMac = info.on_server_mac;
    macName = info.mac_name;
    inboxError = info.inbox_error;
  })
  .catch(() => {})
  .finally(route);
