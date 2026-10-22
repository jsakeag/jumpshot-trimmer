import { clamp, esc } from './util.js';

export const PALETTE = ['#4f9cf7', '#f2994a', '#56c98a', '#9b7bf2', '#ef6b8a', '#3cc6d0', '#d6b84a', '#8a94a6'];

// A name's color: the one picked for it, else one of the palette chosen from the name itself.
export function colorOf(list, name) {
  const picked = list.find(x => x.name === name)?.color;
  if (picked) return picked;
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

let open = null;  // the picker on screen, if any

/*
 * A popover under anchor for picking a name from a list (tag labels or step names): type to
 * search, ↑↓ and Enter to pick, or create a new one. Each name can also be renamed, recolored or
 * deleted, which the callbacks do everywhere and answer with the new list.
 *   list: [{name, count, color}]   current: the name picked now, if any   exclude: names to leave out
 *   pick(name), with null for "none" when noneLabel is given
 *   create(name), rename(old, new), recolor(name, color), remove(name), and if given rate(name, 'bad' | 'good' | null):
 *   each resolves to the new list
 */
export function openPicker(anchor, opts) {
  open?.close();
  let list = opts.list, query = '', hi = 0, editing = null;
  const el = document.createElement('div');
  el.className = 'picker';
  el.innerHTML = `<input class="search" placeholder="${esc(opts.placeholder || 'Search or create…')}" spellcheck="false">
    <ul></ul><p class="foot">↑↓ ↵ pick · click a dot to recolor${opts.rate ? ' · ⚠ bad, again ✓ good' : ''} · ✎ rename · × delete</p>`;
  document.body.appendChild(el);
  const search = el.querySelector('input'), ul = el.querySelector('ul');

  const place = () => {
    if (!anchor.isConnected) return;  // re-rendered away: stay where it is
    const r = anchor.getBoundingClientRect(), h = el.offsetHeight, w = el.offsetWidth;
    const below = r.bottom + 4 + h <= innerHeight - 8;
    el.style.left = `${clamp(r.left, 8, innerWidth - w - 8)}px`;
    el.style.top = `${below ? r.bottom + 4 : Math.max(8, r.top - 4 - h)}px`;
  };

  // the rows: none, then matching names, then "create" if nothing matches exactly
  const rows = () => {
    const q = query.trim().toLowerCase();
    const out = [];
    if (opts.noneLabel && opts.current && !q) out.push({ none: true });
    for (const x of list) {
      if (opts.exclude?.includes(x.name)) continue;
      if (!q || x.name.toLowerCase().includes(q)) out.push(x);
    }
    if (q && !list.some(x => x.name.toLowerCase() === q)) out.push({ create: query.split(/\s+/).join(' ').trim() });
    return out;
  };

  function render() {
    const rs = rows();
    hi = clamp(hi, 0, Math.max(0, rs.length - 1));
    ul.innerHTML = rs.map((x, i) => {
      const cls = `opt${i === hi ? ' hi' : ''}`;
      if (x.none) return `<li class="${cls}" data-i="${i}"><span class="none">${esc(opts.noneLabel)}</span></li>`;
      if (x.create) return `<li class="${cls}" data-i="${i}"><span class="create">+ Create “${esc(x.create)}”</span></li>`;
      const c = colorOf(list, x.name);
      if (editing === x.name) {
        return `<li class="${cls} editing" data-i="${i}"><input class="rename" value="${esc(x.name)}" spellcheck="false"></li>`;
      }
      const mark = x.bad ? '⚠ ' : x.good ? '✓ ' : '';
      return `<li class="${cls}${x.name === opts.current ? ' cur' : ''}${x.bad ? ' bad' : ''}${x.good ? ' good' : ''}" data-i="${i}" style="--c:${c}">
        <button class="dot" data-a="color" title="Change color"></button>
        <span class="pchip">${mark}${esc(x.name)}</span><span class="count">${x.count || ''}</span>
        ${opts.rate ? `<button class="pa rate${x.bad ? ' on' : x.good ? ' on good' : ''}" data-a="rate" title="${
          x.bad ? 'Bad: ideally not needed. Click to mark good' : x.good ? 'Good. Click to unmark' : 'Mark as bad (ideally not needed); click again for good'}">${x.good ? '✓' : '⚠'}</button>` : ''}
        <button class="pa" data-a="rename" title="Rename everywhere">✎</button>
        <button class="pa" data-a="delete" title="Delete everywhere">×</button></li>`;
    }).join('') || '<li class="empty">Nothing yet: type a name to create one</li>';
    ul.querySelector('.hi')?.scrollIntoView?.({ block: 'nearest' });
    const ren = ul.querySelector('.rename');
    if (ren) { ren.focus(); ren.select(); }
    place();
  }

  const fail = err => alert(err.message || err);

  async function choose(x) {
    if (!x) return;
    if (x.none) return finish(null);
    if (x.create) {
      try { list = await opts.create(x.create); } catch (err) { return fail(err); }
      return finish(list.find(y => y.name.toLowerCase() === x.create.toLowerCase())?.name || x.create);
    }
    finish(x.name);
  }

  function finish(name) {
    close();
    opts.pick(name);
  }

  async function rename(old, input) {
    const name = input.split(/\s+/).join(' ').trim();
    editing = null;
    if (!name || name === old) return render();
    const into = list.find(x => x.name.toLowerCase() === name.toLowerCase() && x.name !== old);
    if (into && !confirm(`“${into.name}” already exists. Merge “${old}” into it everywhere?`)) return render();
    try { list = await opts.rename(old, into ? into.name : name); } catch (err) { fail(err); }
    render();
    search.focus();
  }

  ul.addEventListener('pointerdown', e => { if (!e.target.closest('input')) e.preventDefault(); });  // keep the search box focused
  ul.addEventListener('click', async e => {
    const li = e.target.closest('li[data-i]');
    if (!li || li.classList.contains('editing')) return;
    const x = rows()[Number(li.dataset.i)], a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return choose(x);
    if (a === 'rename') { editing = x.name; return render(); }
    if (a === 'rate') {  // neither → bad → good → neither
      try { list = await opts.rate(x.name, x.bad ? 'good' : x.good ? null : 'bad'); } catch (err) { fail(err); }
      return render();
    }
    if (a === 'color') {
      const now = colorOf(list, x.name), next = PALETTE[(PALETTE.indexOf(now) + 1) % PALETTE.length];
      try { list = await opts.recolor(x.name, next); } catch (err) { fail(err); }
      return render();
    }
    if (a === 'delete') {
      const uses = x.count ? ` It’s used ${x.count} time${x.count === 1 ? '' : 's'}; ${x.count === 1 ? 'that' : 'those'} will be cleared.` : '';
      if (!confirm(`Delete “${x.name}” everywhere?${uses}`)) return;
      try { list = await opts.remove(x.name); } catch (err) { fail(err); }
      render();
      search.focus();
    }
  });
  search.addEventListener('input', () => { query = search.value; hi = 0; render(); });
  el.addEventListener('keydown', e => {
    e.stopPropagation();  // the editor's shortcuts stay out of it
    if (e.target.classList.contains('rename')) {
      if (e.key === 'Enter') { e.preventDefault(); rename(editing, e.target.value); }
      if (e.key === 'Escape') { e.preventDefault(); editing = null; render(); search.focus(); }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); hi += e.key === 'ArrowDown' ? 1 : -1; render(); }
    if (e.key === 'Enter') { e.preventDefault(); choose(rows()[hi]); }
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  el.addEventListener('focusout', e => {
    if (e.target.classList.contains('rename') && editing && !el.contains(e.relatedTarget)) rename(editing, e.target.value);
  });
  const outside = e => { if (!el.contains(e.target) && !anchor.contains(e.target)) close(); };
  document.addEventListener('pointerdown', outside, true);
  addEventListener('resize', close);

  function close() {
    if (open !== api) return;
    open = null;
    el.remove();
    document.removeEventListener('pointerdown', outside, true);
    removeEventListener('resize', close);
    document.activeElement?.blur?.();  // hand the keys back to the editor
    opts.onClose?.();
  }

  const api = { close };
  open = api;
  render();
  search.focus();
  return api;
}
