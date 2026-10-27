/* ============================================================
   audio tools: volume points, EQ / pan, auto-ducking, noise reduction, track meters
   ============================================================ */

/* ---------- volume points ----------
   c.env = [{ s, db }]: s is SOURCE time, so points stay on the sound through trims, splits and slips.
   The line is a gain on top of the clip's Volume; between points it ramps in dB. */
const ENV_TOP = 12, ENV_BOT = -40;
const srcAt = (c, t) => c.in + (t - c.start) * c.speed;
const tlAt = (c, s) => c.start + (s - c.in) / c.speed;
function envDb(c, s) {
  const e = c.env; if (!e || !e.length) return 0;
  if (s <= e[0].s) return e[0].db;
  const l = e[e.length - 1]; if (s >= l.s) return l.db;
  let i = 1; while (e[i].s < s) i++;
  const a = e[i - 1], b = e[i]; return a.db + (b.db - a.db) * (s - a.s) / ((b.s - a.s) || 1);
}
const envGain = (c, t) => c.env && c.env.length ? dbToVol(envDb(c, srcAt(c, t))) : 1;
const envY = (db, top, hh) => top + (ENV_TOP - db) / (ENV_TOP - ENV_BOT) * hh;
const envDbAtY = (y, top, hh) => clamp(ENV_TOP - (y - top) / hh * (ENV_TOP - ENV_BOT), ENV_BOT, ENV_TOP);
const hasEnvLine = c => c.kind === 'audio';
// keep points ordered, inside the clip's source range, and one per instant (the later one wins)
function tidyEnv(c) {
  const out = [];
  for (const p of (c.env || []).slice().sort((a, b) => a.s - b.s)) {
    const q2 = { s: clamp(p.s, c.in, c.out), db: clamp(p.db, ENV_BOT, ENV_TOP) };
    if (out.length && Math.abs(out[out.length - 1].s - q2.s) < 1e-4) out[out.length - 1] = q2; else out.push(q2);
  }
  c.env = out.length ? out : null;
}
function drawEnvTL(g, c, x0, x1, top, hh, sel) {
  const e = c.env || [], col = sel ? '#ffd166' : 'rgba(255,209,102,.7)';
  g.strokeStyle = col; g.lineWidth = 1.3; g.beginPath();
  const a = Math.max(x0, -2), b = Math.min(x1, TW + 2);
  if (!e.length) { const y = envY(0, top, hh); g.moveTo(a, y); g.lineTo(b, y); }
  else {
    g.moveTo(a, envY(envDb(c, srcAt(c, T(a))), top, hh));
    for (const p of e) { const x = X(tlAt(c, p.s)); if (x > a && x < b) g.lineTo(x, envY(p.db, top, hh)); }
    g.lineTo(b, envY(envDb(c, srcAt(c, T(b))), top, hh));
  }
  g.stroke();
  g.fillStyle = col;
  for (const p of e) { const x = X(tlAt(c, p.s)); if (x >= x0 - 3 && x <= x1 + 3) g.fillRect(x - 3, envY(p.db, top, hh) - 3, 6, 6); }
}
// where a clip's volume line is on screen (null when the clip has no line)
function envHit(c, lay, x, y) {
  if (!hasEnvLine(c)) return null;
  const top = lay.y + 2 + 14, hh = lay.h - 4 - 14; if (hh < 16) return null;
  const e = c.env || [];
  for (let i = 0; i < e.length; i++) { const px = X(tlAt(c, e[i].s)), py = envY(e[i].db, top, hh); if (Math.abs(px - x) <= 5 && Math.abs(py - y) <= 5) return { zone: 'envPt', i, top, hh }; }
  const ly = envY(envDb(c, srcAt(c, T(x))), top, hh);
  return Math.abs(ly - y) <= 4 ? { zone: 'env', top, hh } : null;
}

/* ---------- EQ and pan ----------
   every sound player (and each clip in an export mix) runs through high-pass → low shelf → mid
   bell → high shelf → pan; at flat settings it's transparent */
const EQ0 = { hp: 0, low: 0, mid: 0, high: 0 };
const EQ_PRESETS = { Flat: EQ0, Voice: { hp: 100, low: -2, mid: 2, high: 3 }, Warm: { hp: 0, low: 3, mid: 0, high: -2 }, Bright: { hp: 60, low: -1, mid: 0, high: 4 }, 'Music bed': { hp: 40, low: 0, mid: -4, high: 0 } };
function makeChain(ctx) {
  const bq = (type, f, q2) => { const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = f; if (q2 != null) n.Q.value = q2; return n; };
  // a high-pass filter's Q is in dB here: −3 dB is Butterworth, flat with no bump at the cutoff
  const hp = bq('highpass', 10, -3.0103), lo = bq('lowshelf', 150), mi = bq('peaking', 1200, 0.8), hi = bq('highshelf', 6000), pan = ctx.createStereoPanner();
  hp.connect(lo); lo.connect(mi); mi.connect(hi); hi.connect(pan);
  let key = '';
  return { input: hp, output: pan, set(c) {
    const q2 = c.eq || EQ0, k = `${q2.hp}|${q2.low}|${q2.mid}|${q2.high}|${c.pan || 0}`; if (k === key) return; key = k;
    hp.frequency.value = q2.hp || 10; lo.gain.value = q2.low || 0; mi.gain.value = q2.mid || 0; hi.gain.value = q2.high || 0; pan.pan.value = c.pan || 0;
  } };
}
const eqOn = c => !!(c.eq && (c.eq.hp || c.eq.low || c.eq.mid || c.eq.high)) || !!c.pan;

/* ---------- auto-ducking ---------- */
// timeline spans where any clip outside `exclude` is audible above −30 dB (from the waveform peaks)
function soundSpans(exclude) {
  const step = 0.05, n = Math.ceil(tlEnd() / step) + 1, lv = new Float32Array(n);
  for (const c of P.clips) {
    if (exclude.has(c.id) || !c.media || !(c.kind === 'audio' || c.kind === 'video')) continue;
    const m = media.get(c.media); if (!m || !m.peaks || m.offline) continue;
    const d = m.peaks.data, r = m.peaks.rate;
    for (let i = Math.max(0, Math.floor(c.start / step)); i < n && i * step < cend(c); i++) {
      const t = i * step, gn = clipGain(c, t); if (!gn) continue;
      const s = srcAt(c, t); let pk = 0;
      for (let j = Math.floor(s * r), j1 = Math.ceil((s + step * c.speed) * r); j < j1 && j < d.length; j++) if (d[j] > pk) pk = d[j];
      if (pk * gn > lv[i]) lv[i] = pk * gn;
    }
  }
  const spans = [];
  for (let i = 0; i < n; i++) {
    if (lv[i] < 0.032) continue;
    const t = i * step, l = spans[spans.length - 1];
    if (l && t - l[1] < 0.9) l[1] = t + step; else spans.push([t, t + step]); // bridge pauses between words
  }
  return spans.filter(([a, b]) => b - a >= 0.2);
}
function cmdDuck(cs, db = -12) {
  cs = cs.filter(c => c.kind === 'audio');
  if (!cs.length) return toast('Select the music clip(s) to duck — audio clips on an audio track', true);
  const spans = soundSpans(new Set(cs.map(c => c.id)));
  if (!spans.length) return toast('No speech or other sound found on the other tracks to duck under', true);
  let hits = 0;
  edit(() => {
    for (const c of cs) {
      const pts = [];
      for (const [a, b] of spans) {
        if (b + 0.6 <= c.start || a - 0.3 >= cend(c)) continue;
        hits++;
        pts.push({ t: a - 0.3, db: 0 }, { t: a, db }, { t: b, db }, { t: b + 0.6, db: 0 });
      }
      c.env = pts.map(p => ({ s: srcAt(c, clamp(p.t, c.start, cend(c))), db: p.db })); tidyEnv(c);
    }
  }, () => hits ? `Ducked ${fmtDb(db)} under ${hits} passage${hits > 1 ? 's' : ''} — drag the yellow points to fine-tune` : 'Nothing to duck under inside the selected clips');
}

/* ---------- noise reduction ----------
   spectral gating: learn the noise spectrum from the quietest 10% of the recording, then turn each
   frequency down where it's no louder than that noise. Runs in a worker; the result is a new WAV. */
function denoiseWork(L, R, beta, floor, prog) {
  const N = 2048, Hp = 512, n = L.length, half = N / 2, lg = Math.log2(N);
  const rev = new Uint32Array(N); for (let i = 0; i < N; i++) { let r = 0; for (let b = 0; b < lg; b++) r |= ((i >> b) & 1) << (lg - 1 - b); rev[i] = r; }
  const cs = new Float64Array(half), sn = new Float64Array(half); for (let i = 0; i < half; i++) { cs[i] = Math.cos(2 * Math.PI * i / N); sn[i] = -Math.sin(2 * Math.PI * i / N); }
  const fft = (re, im) => {
    for (let i = 0; i < N; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let sz = 2; sz <= N; sz <<= 1) {
      const hs = sz >> 1, st = N / sz;
      for (let i = 0; i < N; i += sz) for (let j = 0, k = 0; j < hs; j++, k += st) {
        const a = i + j, b = a + hs, tr = re[b] * cs[k] - im[b] * sn[k], ti = re[b] * sn[k] + im[b] * cs[k];
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  };
  const win = new Float64Array(N); for (let i = 0; i < N; i++) win[i] = Math.sqrt(0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
  const F = Math.ceil((n + N) / Hp), re = new Float64Array(N), im = new Float64Array(N);
  // both channels in one complex FFT: left in the real part, right in the imaginary part
  const load = f => { const p0 = f * Hp - N; for (let j = 0; j < N; j++) { const i = p0 + j, w = win[j]; re[j] = i >= 0 && i < n ? L[i] * w : 0; im[j] = R && i >= 0 && i < n ? R[i] * w : 0; } };
  const pow = k => { const k2 = (N - k) % N, ar = (re[k] + re[k2]) / 2, ai = (im[k] - im[k2]) / 2, br = (im[k] + im[k2]) / 2, bi = (re[k2] - re[k]) / 2; return ar * ar + ai * ai + br * br + bi * bi; };
  const en = new Float64Array(F);
  for (let f = 0; f < F; f++) { const p0 = f * Hp - N; let s = 0; for (let j = 0; j < N; j++) { const i = p0 + j; if (i >= 0 && i < n) { const v = L[i]; s += v * v; if (R) s += R[i] * R[i]; } } en[f] = s; }
  const live = [...en.keys()].filter(f => en[f] > 1e-10).sort((a, b) => en[a] - en[b]);
  const quiet = live.slice(0, Math.max(1, Math.floor(live.length * 0.1)));
  const noise = new Float64Array(half + 1);
  for (const f of quiet) { load(f); fft(re, im); for (let k = 0; k <= half; k++) noise[k] += pow(k) / quiet.length; }
  const outL = new Float32Array(n), outR = R ? new Float32Array(n) : null, gs = new Float64Array(half + 1).fill(1), gk = new Float64Array(half + 1);
  for (let f = 0; f < F; f++) {
    load(f); fft(re, im);
    for (let k = 0; k <= half; k++) { const g = Math.max(floor, 1 - beta * noise[k] / (pow(k) + 1e-20)); gs[k] = g > gs[k] ? g : 0.5 * g + 0.5 * gs[k]; } // quick to open, slower to close: less "musical" noise
    for (let k = 0; k <= half; k++) gk[k] = (gs[Math.max(0, k - 1)] + gs[k] + gs[Math.min(half, k + 1)]) / 3;
    for (let k = 0; k < N; k++) { const g = gk[k <= half ? k : N - k]; re[k] *= g; im[k] *= g; }
    for (let k = 0; k < N; k++) im[k] = -im[k]; fft(re, im); // inverse FFT via conjugation
    const p0 = f * Hp - N;
    for (let j = 0; j < N; j++) { const i = p0 + j; if (i < 0 || i >= n) continue; const w = win[j] / (N * 2); outL[i] += re[j] * w; if (outR) outR[i] -= im[j] * w; }
    if (f % 500 === 0) prog(f / F);
  }
  return outR ? [outL, outR] : [outL];
}
const NR_LEVELS = { light: [1.5, 0.3], medium: [2.5, 0.15], strong: [4, 0.07] };
async function cleanAudio(m, level = 'medium') {
  if (m.offline) return null;
  const bar = h('i'), lab = h('div', { class: 'note' }, 'Reading the sound…');
  openModal(h('div', {}, h('h2', {}, 'Reducing noise · ' + m.name), h('div', { class: 'pbar' }, bar), lab));
  const url = URL.createObjectURL(new Blob([`${denoiseWork}\nonmessage = e => { const o = denoiseWork(e.data.L, e.data.R, e.data.beta, e.data.floor, p => postMessage({ p })); postMessage({ out: o }, o.map(a => a.buffer)); };`], { type: 'text/javascript' }));
  const w = new Worker(url);
  try {
    const buf = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(await (m.sndUrl ? (await fetch(m.sndUrl)).arrayBuffer() : m.file.arrayBuffer()));
    const L = new Float32Array(buf.getChannelData(0)), R = buf.numberOfChannels > 1 ? new Float32Array(buf.getChannelData(1)) : null;
    const [beta, floor] = NR_LEVELS[level] || NR_LEVELS.medium;
    lab.textContent = 'Learning the background noise and cleaning…';
    const out = await new Promise((res, rej) => {
      w.onmessage = e => { if (e.data.out) res(e.data.out); else bar.style.width = (e.data.p * 100).toFixed(1) + '%'; };
      w.onerror = e => rej(new Error(e.message || 'worker failed'));
      w.postMessage({ L, R, beta, floor }, [L.buffer].concat(R ? [R.buffer] : []));
    });
    const name = m.name.replace(/( \((audio|clean)\))*\.[^.]+$/, '') + ' (clean).wav';
    const [a] = await importFiles([new File([wavBlob(out, buf.sampleRate)], name, { type: 'audio/wav' })], { quiet: true });
    return a || null;
  } catch (e) { toast("Couldn't reduce noise: " + e.message, true); return null; }
  finally { w.terminate(); URL.revokeObjectURL(url); $('#modal').hidden = true; }
}
// clip: audio clips switch to the cleaned file; a video clip's sound goes to an audio track as the clean copy
async function cmdDenoise(c, level) {
  const m = media.get(c.media); if (!m) return;
  if (c.kind === 'video' && m.hasAudio === false) return toast('This clip has no sound', true);
  const a = await cleanAudio(m, level); if (!a) return;
  if (c.kind === 'audio') edit(() => { c.media = a.id; c.name = a.name; }, 'Noise reduced — the clip now plays ' + a.name);
  else detachAudio(c, a.id);
  renderBin();
}

/* ---------- track meters ---------- */
// per-track level from the waveform peaks and each clip's gain (pre-EQ), drawn in the track heads
const TMET = new Map(); // track id → { el, v }
function updTrackMeters(t, playing) {
  const lv = new Map();
  if (playing) for (const c of P.clips) {
    if (!c.media || !(c.kind === 'audio' || c.kind === 'video') || t < c.start || t >= cend(c)) continue;
    const m = media.get(c.media); if (!m || !m.peaks) continue;
    const d = m.peaks.data, r = m.peaks.rate, i = Math.floor(srcAt(c, t) * r);
    let pk = 0; for (let j = Math.max(0, i - 2); j <= i + 2 && j < d.length; j++) if (d[j] > pk) pk = d[j];
    const v = pk * clipGain(c, t); if (v > (lv.get(c.track) || 0)) lv.set(c.track, v);
  }
  for (const [tid, o] of TMET) {
    const v = Math.max(lv.get(tid) || 0, o.v * 0.88); if (Math.abs(v - o.v) < 1e-4 && v < 1e-3) continue;
    o.v = v; const k = clamp((20 * Math.log10(v + 1e-9) + 60) / 60, 0, 1);
    o.el.style.clipPath = `inset(0 ${((1 - k) * 100).toFixed(1)}% 0 0)`; o.el.classList.toggle('clip', v >= 0.99);
  }
}
