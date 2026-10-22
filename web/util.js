export const $ = (sel, el = document) => el.querySelector(sel);
export const enc = encodeURIComponent;
export const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// 83.4 -> "1:23"; with frac, "1:23.4"
export function fmt(s, frac = false) {
  s = Math.max(0, s);
  const m = Math.floor(s / 60), sec = s - m * 60;
  return `${m}:${frac ? sec.toFixed(1).padStart(4, '0') : String(Math.floor(sec)).padStart(2, '0')}`;
}

// "1:23.4" or "83.4" -> 83.4 (NaN if neither)
export function parseTime(str) {
  const parts = String(str).trim().split(':').map(Number);
  if (!parts.length || parts.some(Number.isNaN)) return NaN;
  return parts.reduce((t, p) => t * 60 + p, 0);
}

export async function api(path, opts = {}) {
  if (opts.json !== undefined) {
    opts = { ...opts, body: JSON.stringify(opts.json), headers: { 'Content-Type': 'application/json' } };
    delete opts.json;
  }
  const r = await fetch(path, opts);
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch {}
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return r.json();
}

// The strokes you mark by holding a key, then what plugins find.
export const KINDS = {
  fh: { label: 'Forehand', short: 'FH', key: 'F', color: '#4f9cf7' },
  bh: { label: 'Backhand', short: 'BH', key: 'B', color: '#f2994a' },
  serve: { label: 'Serve', short: 'SRV', key: ';', color: '#56c98a' },
  point: { label: 'Point', short: 'PT', color: '#8a94a6' },
  shot: { label: 'Shot', short: 'SHOT', color: '#d6b84a' },
};

// Hold-to-mark keys, by e.code. With Shift, a forehand or backhand is also tagged as a volley.
export const MARK_KEYS = { KeyF: 'fh', KeyB: 'bh', Semicolon: 'serve' };
export const VOLLEY = 'volley';

// How strongly an annotation shows the given tags (or any tag): its highest score among them.
export function strength(a, tags) {
  const scores = a.tags.filter(t => !tags.size || tags.has(t.name)).map(t => t.score);
  return scores.length ? Math.max(...scores) : null;
}

export function jobText(j) {
  if (j.error) return `${j.label} failed: ${j.error}`;
  if (j.stage === 'queued') return `${j.label}: waiting for another video…`;
  if (j.stage === 'done') return `${j.label}: done`;
  return `${j.label}… ${Math.round(j.progress * 100)}%`;
}

export const jobRunning = j => j && !j.error && j.stage !== 'done';
