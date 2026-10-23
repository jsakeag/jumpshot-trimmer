// Tennis court geometry and the ball's flight in 3D, from points clicked on one camera's video.
// World coordinates are meters: the origin is the middle of the net, x runs across the court
// (rightward as seen from the near end), y along it (away from the camera) and z up.

export const COURT = { length: 23.77, doubles: 10.97, singles: 8.23, service: 6.40, net: 0.914, post: 1.07, postOut: 0.914 };
const HALF = COURT.length / 2;
const G = 9.81;
const DRAG = 0.020;     // ½·ρ·Cd·A/m for a tennis ball, per meter: at 30 m/s the air slows it more than gravity does
const GROUND_W = 1;     // how hard a bounce is held to the ground, in image units per meter
const DT = 1 / 120;     // a fitted path is sampled this often (seconds of flight)

// The court's lines, as [[x0, y0], [x1, y1]] on the ground.
export function courtLines() {
  const d = COURT.doubles / 2, s = COURT.singles / 2, sv = COURT.service;
  return [
    [[-d, -HALF], [d, -HALF]], [[-d, HALF], [d, HALF]],      // baselines
    [[-d, -HALF], [-d, HALF]], [[d, -HALF], [d, HALF]],      // doubles sidelines
    [[-s, -HALF], [-s, HALF]], [[s, -HALF], [s, HALF]],      // singles sidelines
    [[-s, -sv], [s, -sv]], [[-s, sv], [s, sv]],              // service lines
    [[0, -sv], [0, sv]],                                      // center service line
    [[0, -HALF], [0, -HALF + 0.1]], [[0, HALF], [0, HALF - 0.1]],  // center marks
  ];
}

// Points on the court that are easy to find on the video, to calibrate the camera from: where
// lines cross, in order of the near baseline to the far one. Left and right are as seen from the camera.
export const LANDMARKS = (() => {
  const d = COURT.doubles / 2, s = COURT.singles / 2, sv = COURT.service, out = [];
  const cols = { dl: [-d, 'left doubles sideline'], sl: [-s, 'left singles sideline'], c: [0, 'center'], sr: [s, 'right singles sideline'], dr: [d, 'right doubles sideline'] };
  const row = (key, y, name, which) => which.forEach(c => out.push({ key: `${key}-${c}`, at: [cols[c][0], y], label: `${name} · ${c === 'c' ? (key.endsWith('svc') ? 'T' : 'center') : cols[c][1]}` }));
  row('near-base', -HALF, 'Near baseline', ['dl', 'sl', 'c', 'sr', 'dr']);
  row('near-svc', -sv, 'Near service line', ['sl', 'c', 'sr']);
  row('net', 0, 'Under the net', ['dl', 'sl', 'c', 'sr', 'dr']);
  row('far-svc', sv, 'Far service line', ['sl', 'c', 'sr']);
  row('far-base', HALF, 'Far baseline', ['dl', 'sl', 'c', 'sr', 'dr']);
  return out;
})();
const LANDMARK = Object.fromEntries(LANDMARKS.map(l => [l.key, l]));

// The net's height across the court: lowest in the middle, highest at the posts.
export const netHeight = x => COURT.net + (COURT.post - COURT.net) * Math.min(1, Math.abs(x) / (COURT.doubles / 2 + COURT.postOut));

// ---------------------------------------------------------------- small linear algebra

export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const sub = (a, b) => a.map((x, i) => x - b[i]);
export const unit = a => { const n = Math.hypot(...a); return a.map(x => x / n); };
const scale = (a, k) => a.map(x => x * k);
const sumsq = r => r.reduce((s, x) => s + x * x, 0);

// A x = b by Gaussian elimination with partial pivoting; null if A is singular.
function solve(A, b) {
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-14) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const k = M[r][c] / M[c][c];
      for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j];
    }
  }
  const x = new Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let j = r + 1; j < n; j++) s -= M[r][j] * x[j];
    x[r] = s / M[r][r];
  }
  return x;
}

// Least squares for rows·x ≈ rhs by the normal equations; damp adds Marquardt damping.
function lstsq(rows, rhs, damp = 0) {
  const n = rows[0].length;
  const A = Array.from({ length: n }, () => new Array(n).fill(0)), b = new Array(n).fill(0);
  rows.forEach((row, k) => {
    for (let i = 0; i < n; i++) {
      b[i] += row[i] * rhs[k];
      for (let j = 0; j < n; j++) A[i][j] += row[i] * row[j];
    }
  });
  for (let i = 0; i < n; i++) A[i][i] += damp * (A[i][i] || 1);
  return solve(A, b);
}

// Levenberg–Marquardt on resid(x), with a numeric Jacobian.
function refine(resid, x, iters = 40) {
  let r = resid(x), cost = sumsq(r), mu = 1e-3;
  for (let it = 0; it < iters; it++) {
    const J = r.map(() => []);
    x.forEach((_, j) => {
      const h = 1e-5 * Math.max(1, Math.abs(x[j]));
      resid(x.map((v, k) => k === j ? v + h : v)).forEach((v, i) => { J[i][j] = (v - r[i]) / h; });
    });
    let better = null;
    for (; mu < 1e10; mu *= 4) {
      const dx = lstsq(J, r.map(v => -v), mu);
      if (!dx) continue;
      const xn = x.map((v, j) => v + dx[j]), rn = resid(xn), cn = sumsq(rn);
      if (cn < cost) { better = { xn, rn, cn }; break; }
    }
    if (!better) break;
    const gain = cost - better.cn;
    ({ xn: x, rn: r, cn: cost } = better);
    mu = Math.max(mu / 3, 1e-9);
    if (gain < 1e-10 * (cost + 1e-12)) break;
  }
  return x;
}

// ---------------------------------------------------------------- the camera

// The camera, from court landmarks clicked on a W×H video ({k: landmark key, x, y} as fractions
// of the frame), or null with fewer than 4. Assumes square pixels and the lens centered on the
// frame, so the only unknown inside the camera is its focal length. A first guess comes from the
// ground's homography (the focal length that makes the court's two axes perpendicular and equally
// scaled), then focal length, rotation and position are refined so the landmarks land where they
// were clicked. Image points are measured from the frame's center in units of its longer side.
export function calibrate(points, W, H) {
  const s = Math.max(W, H), known = points.filter(p => LANDMARK[p.k]);
  if (known.length < 4) return null;
  const rows = [], rhs = [];
  for (const p of known) {
    const [X, Y] = LANDMARK[p.k].at.map(v => v / 10), u = (p.x - 0.5) * W / s, v = (p.y - 0.5) * H / s;  // tens of meters, for conditioning
    rows.push([X, Y, 1, 0, 0, 0, -u * X, -u * Y], [0, 0, 0, X, Y, 1, -v * X, -v * Y]);
    rhs.push(u, v);
  }
  const h = known.length === 4 ? solve(rows, rhs) : lstsq(rows, rhs);
  if (!h) return { error: 'Those points are all on one line: add one off it.' };
  let [a, b, c, d, e, f0, g, k] = h;  // the homography [[a b c] [d e f0] [g k 1]], ground to image
  [a, b, d, e, g, k] = [a, b, d, e, g, k].map(v => v / 10);    // back to meters
  // r1 ⟂ r2 and |r1| = |r2|, each as A/f² + B = 0, solved together for 1/f²
  const eqs = [[a * b + d * e, g * k], [a * a + d * d - b * b - e * e, g * g - k * k]];
  const w = -(eqs[0][0] * eqs[0][1] + eqs[1][0] * eqs[1][1]) / (eqs[0][0] ** 2 + eqs[1][0] ** 2);
  let f = 1 / Math.sqrt(w), guessed = false;
  if (!(f > 0.3 && f < 5)) { f = 0.8; guessed = true; }  // a phone's main camera, about 65° across
  const c1 = [a / f, d / f, g], c2 = [b / f, e / f, k], c3 = [c / f, f0 / f, 1];
  const lam = (Math.hypot(...c1) + Math.hypot(...c2)) / 2;
  const r1 = unit(c1), r2 = unit(sub(c2, scale(r1, dot(r1, c2)))), r3 = cross(r1, r2);
  const world = known.map(p => [...LANDMARK[p.k].at, 0]), obs = known.map(p => [(p.x - 0.5) * W / s, (p.y - 0.5) * H / s]);
  const M0 = [0, 1, 2].map(i => [r1[i], r2[i], r3[i]]);  // world to camera, as rows
  // x: [log f, rotation vector applied after M0, translation]
  const build = x => {
    const M = rotation(x.slice(1, 4)).map(row => [0, 1, 2].map(j => row[0] * M0[0][j] + row[1] * M0[1][j] + row[2] * M0[2][j]));
    return { f: Math.exp(x[0]), R: [0, 1, 2].map(j => M.map(row => row[j])), t: x.slice(4, 7) };
  };
  const resid = x => {
    const c = build(x);
    return world.flatMap((X, n) => { const q = toCam(c, X); return q[2] < 1e-3 ? [1, 1] : [c.f * q[0] / q[2] - obs[n][0], c.f * q[1] / q[2] - obs[n][1]]; });
  };
  let x = [Math.log(f), 0, 0, 0, ...scale(c3, 1 / lam)];
  const better = refine(resid, x, 100);
  if (Math.exp(better[0]) > 0.3 && Math.exp(better[0]) < 5) x = better;
  const { R, t } = build(x);
  const cam = { f: Math.exp(x[0]), guessed, R, t, W, H, s, center: R.map(r => -dot(r, t)) };
  if (cam.center[2] <= 0) return { error: 'The points look mirrored: left and right are as seen from the camera.' };
  const off = known.map(p => {
    const q = project(cam, [...LANDMARK[p.k].at, 0]);
    return q ? Math.hypot((q[0] - p.x) * W, (q[1] - p.y) * H) : 1e3;
  });
  cam.err = Math.sqrt(sumsq(off) / off.length);
  return cam;
}

// The rotation by rotation vector w (Rodrigues), as rows.
function rotation(w) {
  const th = Math.hypot(...w);
  if (th < 1e-12) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const [x, y, z] = w.map(v => v / th), c = Math.cos(th), s = Math.sin(th), C = 1 - c;
  return [[c + x * x * C, x * y * C - z * s, x * z * C + y * s],
    [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
    [z * x * C - y * s, z * y * C + x * s, c + z * z * C]];
}

// Camera coordinates of a world point: R's columns are the world axes as the camera sees them.
const toCam = (cam, X) => { const [r1, r2, r3] = cam.R; return [0, 1, 2].map(i => r1[i] * X[0] + r2[i] * X[1] + r3[i] * X[2] + cam.t[i]); };

// A world point on the video, as fractions of the frame; null if it's behind the camera.
export function project(cam, X) {
  const c = toCam(cam, X);
  if (c[2] < 1e-3) return null;
  return [cam.f * c[0] / c[2] * cam.s / cam.W + 0.5, cam.f * c[1] / c[2] * cam.s / cam.H + 0.5];
}

// Where the line of sight through a point on the video meets the ground; null if it doesn't.
export function ground(cam, { x, y }) {
  const q = [(x - 0.5) * cam.W / cam.s / cam.f, (y - 0.5) * cam.H / cam.s / cam.f, 1];
  const [r1, r2, r3] = cam.R, d = [dot(r1, q), dot(r2, q), dot(r3, q)];
  if (d[2] >= -1e-9) return null;
  const k = -cam.center[2] / d[2];
  return [cam.center[0] + k * d[0], cam.center[1] + k * d[1], 0];
}

// Where the camera's lens points at the ground (or the court's middle, if it points above it).
export function aimPoint(cam) {
  const d = cam.R.map(r => r[2]);
  if (d[2] >= -1e-6) return [0, 0, 0];
  const k = -cam.center[2] / d[2];
  return [cam.center[0] + k * d[0], cam.center[1] + k * d[1], 0];
}

// ---------------------------------------------------------------- the ball's flight

// The ball's state [x, y, z, vx, vy, vz] at each of taus (seconds from s0, before it too), from
// state s0, under gravity and air drag (spin is left out), by RK4.
function fly(s0, taus, step = 1 / 500) {
  const deriv = s => { const k = DRAG * Math.hypot(s[3], s[4], s[5]); return [s[3], s[4], s[5], -k * s[3], -k * s[4], -G - k * s[5]]; };
  const add = (s, d, h) => s.map((x, i) => x + d[i] * h);
  const out = new Array(taus.length);
  for (const dir of [1, -1]) {  // forward to the later times, back to the earlier ones
    const order = taus.map((_, i) => i).filter(i => dir > 0 ? taus[i] >= 0 : taus[i] < 0).sort((i, j) => dir * (taus[i] - taus[j]));
    let s = s0, t = 0;
    for (const i of order) {
      while (dir * (taus[i] - t) > 1e-9) {
        const h = dir * Math.min(step, dir * (taus[i] - t));
        const k1 = deriv(s), k2 = deriv(add(s, k1, h / 2)), k3 = deriv(add(s, k2, h / 2)), k4 = deriv(add(s, k3, h));
        s = s.map((x, j) => x + h / 6 * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j]));
        t += h;
      }
      out[i] = s;
    }
  }
  return out;
}

// A track's flights: it's split at each hit and bounce, which ends one flight and starts the next.
function flights(points) {
  const out = [];
  let cur = [];
  for (const q of points) {
    cur.push(q);
    if (q.ev && cur.length > 1) { out.push(cur); cur = [q]; }
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

// One flight fitted to its clicked points: the launch position and velocity that best land on
// them on the video. A bounce at either end also has to touch the ground, within a frame or so of
// the one clicked (the nearest frame is rarely the moment it lands). Needs 3 points or more.
function fitFlight(cam, pts, slowmo, fps) {
  const t0 = pts[0].t, taus = pts.map(q => (q.t - t0) / slowmo), near = 0.75 / fps / slowmo;
  const obs = pts.map(({ x, y }) => [(x - 0.5) * cam.W / cam.s, (y - 0.5) * cam.H / cam.s]);
  const bounce = pts.map(q => q.ev === 'bounce');
  // first guess without drag, which makes it linear in the launch state: each point on the video
  // puts the ball on a line of sight, two equations (f·Xc - u·Zc = 0, f·Yc - v·Zc = 0)
  const [r1, r2, r3] = cam.R, rowR = i => [r1[i], r2[i], r3[i]];
  const rows = [], rhs = [];
  taus.forEach((tau, n) => {
    for (const i of [0, 1]) {
      const a = sub(scale(rowR(i), cam.f), scale(rowR(2), obs[n][i]));
      rows.push([...a, ...scale(a, tau)]);
      rhs.push(obs[n][i] * cam.t[2] - cam.f * cam.t[i] + 0.5 * G * tau * tau * a[2]);
    }
    if (bounce[n]) { rows.push([0, 0, 10, 0, 0, 10 * tau]); rhs.push(10 * 0.5 * G * tau * tau); }
  });
  const guess = lstsq(rows, rhs);
  if (!guess) return null;
  const edges = taus.flatMap((tau, n) => bounce[n] ? [tau - near, tau + near] : []);
  const resid = (x, imageOnly = false) => {
    const states = fly(x, [...taus, ...edges]), r = [];
    let e = taus.length;
    taus.forEach((_, n) => {
      const c = toCam(cam, states[n]);
      if (c[2] < 0.1) r.push(1, 1);
      else r.push(cam.f * c[0] / c[2] - obs[n][0], cam.f * c[1] / c[2] - obs[n][1]);
      if (!bounce[n]) return;
      const z0 = states[e++][2], z1 = states[e++][2];  // it reaches the ground between these, or as near as it gets
      if (!imageOnly) r.push(z0 * z1 <= 0 ? 0 : Math.min(Math.abs(z0), Math.abs(z1)) * GROUND_W);
    });
    return r;
  };
  const s0 = refine(resid, guess);
  const fit = { pts, t0, t1: pts.at(-1).t, slowmo, s0, from: pts[0].ev || null, to: pts.at(-1).ev || null };
  fit.rms = Math.sqrt(sumsq(resid(s0, true)) / (2 * pts.length)) * cam.s;  // pixels
  const T = (fit.t1 - t0) / slowmo;
  fit.path = fly(s0, Array.from({ length: Math.ceil(T / DT) + 1 }, (_, k) => Math.min(k * DT, T)));
  return Object.assign(fit, stats(fit.path));
}

// Speed off the start and at the end (km/h), the highest point, and how far above the net it
// crossed (null if it didn't cross).
function stats(path) {
  const kmh = s => Math.hypot(s[3], s[4], s[5]) * 3.6;
  let peak = 0, net = null;
  path.forEach((s, i) => {
    peak = Math.max(peak, s[2]);
    const p = path[i - 1];
    if (p && p[1] * s[1] < 0) {
      const k = p[1] / (p[1] - s[1]);
      net = p[2] + k * (s[2] - p[2]) - netHeight(p[0] + k * (s[0] - p[0]));
    }
  });
  return { speed: kmh(path[0]), endSpeed: kmh(path.at(-1)), peak, net };
}

// A track's flights, each fitted, or {pts} alone if it couldn't be.
export function fitTrack(cam, points, slowmo, fps) {
  return flights(points).map(pts => (pts.length >= 3 && fitFlight(cam, pts, slowmo, fps)) || { pts });
}

// Where a fitted flight has the ball at video time t; null outside the flight.
export function ballAt(fit, t) {
  if (!fit.path || t < fit.t0 || t > fit.t1) return null;
  const i = (t - fit.t0) / fit.slowmo / DT, n = Math.floor(i), a = fit.path[n], b = fit.path[Math.min(n + 1, fit.path.length - 1)];
  return [0, 1, 2].map(j => a[j] + (b[j] - a[j]) * (i - n));
}
