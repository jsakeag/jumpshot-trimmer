import { $, api, enc, esc, jobText } from './util.js';
import { openEditor } from './editor.js';

const app = $('#app');
let info = { plugins: [], kinds: {}, last_far_box: null, data_dir: 'data/' };

// ---------------------------------------------------------------- routing

let cleanup = () => {};

function route() {
  cleanup();
  cleanup = () => {};
  const m = location.hash.match(/^#\/v\/(.+)$/);
  document.body.classList.toggle('editing', !!m);
  if (m) cleanup = openEditor(app, decodeURIComponent(m[1]), info);
  else showLibrary();
}

window.addEventListener('hashchange', route);

// ---------------------------------------------------------------- library

function showLibrary() {
  document.title = 'Mock Premiere Lite';
  app.innerHTML = `
    <div class="library">
      <section class="card">
        <strong>How it works</strong>
        <ol class="steps">
          <li>Put session videos in <code>${esc(info.data_dir)}</code>. They show up below.</li>
          <li>Open one and hold <kbd>F</kbd> <kbd>B</kbd> <kbd>;</kbd> (serve; <kbd>⇧F</kbd> <kbd>⇧B</kbd> tags a volley) while it plays to mark strokes. Tag them and score each tag 1–5.</li>
          <li>Or run a plugin to find serves, points or shots; they come in as maybes to confirm.</li>
          <li>Export joins the confirmed annotations into one video.</li>
        </ol>
        <button class="btn" id="open-data">Open data folder</button>
      </section>
      <h2>Videos</h2>
      <ul class="videos" id="videos"><li class="empty">Loading…</li></ul>
      <button class="btn danger" id="clear-all" hidden>Clear all videos</button>
    </div>`;

  $('#open-data').addEventListener('click', () => api('/api/reveal', { method: 'POST' }).catch(e => alert(e.message)));
  $('#clear-all').addEventListener('click', async () => {
    const n = $('#videos').querySelectorAll('.video').length;
    if (!confirm(`Move all ${n} videos and their annotations and exports to the Trash?`)) return;
    try { await api('/api/clear', { method: 'POST' }); } catch (e) { return alert(e.message); }
    refresh();
  });

  // keep checking, so new videos and job progress show up on their own
  let timer, alive = true;
  cleanup = () => { alive = false; clearTimeout(timer); };
  async function refresh() {
    clearTimeout(timer);
    try {
      const vids = await api('/api/videos');
      if (!alive) return;
      $('#videos').innerHTML = vids.length
        ? vids.map(videoRow).join('')
        : `<li class="empty">No videos yet. Put some in <code>${esc(info.data_dir)}</code>.</li>`;
      $('#clear-all').hidden = !vids.length;
    } catch (e) {
      if (alive) $('#videos').innerHTML = `<li class="error">${esc(e.message)}</li>`;
    }
    if (alive) timer = setTimeout(refresh, 3000);
  }
  refresh();
}

function videoStatus(v) {
  const parts = [];
  if (v.annotations || v.maybes) parts.push(`${v.annotations} annotated`);
  if (v.maybes) parts.push(`${v.maybes} maybe`);
  if (v.exported) parts.push('exported');
  if (v.job && v.job.stage !== 'done') parts.push(jobText(v.job));
  return parts.join(' · ') || 'Not annotated yet';
}

const videoRow = v => `
  <li class="video card">
    <a class="video-link" href="#/v/${enc(v.stem)}">
      <span class="name">${esc(v.name)}</span>
      <span class="meta">${esc(videoStatus(v))}</span>
    </a>
  </li>`;

api('/api/info')
  .then(i => { info = i; })
  .catch(() => {})
  .finally(route);
