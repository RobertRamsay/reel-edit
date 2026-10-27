'use strict';
/* ============================================================
   REEL EDIT — core: state, history, media, audio, playback, render
   ============================================================ */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const EPS = 1e-4;
let _n = 0;
const uid = p => p + Date.now().toString(36).slice(-4) + (++_n).toString(36) + Math.random().toString(36).slice(2, 4);
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k in e && typeof v !== 'string') e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) { if (k == null || k === false) continue; e.append(k.nodeType ? k : document.createTextNode(k)); }
  return e;
}
const groupBy = (arr, f) => { const m = new Map(); for (const x of arr) { const k = f(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; };
const easeOut = p => 1 - (1 - p) * (1 - p);
const backOut = p => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); };
const EASE = { linear: p => p, smooth: p => p * p * (3 - 2 * p), in: p => p * p, out: easeOut };

/* ---------- project state ---------- */
const P = {
  name: 'Untitled Reel',
  settings: { w: 1920, h: 1080, fps: 30, bg: '#000000', xfType: 'dissolve', xfDur: 0.5, imgDur: 3 },
  tracks: [], clips: [], markers: [], inPt: null, outPt: null,
};
const media = new Map();
const UI = {
  pps: 80, sx: 0, sy: 0, t: 0, playing: false, rate: 1,
  sel: new Set(), selXf: null, tool: 'select', snap: true, autoX: true, ripple: false, loop: false,
  pvScale: 1, guides: false, mode: 'timeline', src: null, targetV: null, targetA: null, binSel: null,
  proxy: true, tScale: 1, hover: null, snapLine: null, ghost: null, drag: null, clipboard: null, info: null, bladeT: null,
};
let dirtyPV = true, dirtyTL = true, EXP = null;

const fps = () => P.settings.fps;
const frame = () => 1 / P.settings.fps;
const q = t => Math.round(t * P.settings.fps) / P.settings.fps;
function fmtTC(t, f) {
  f = f || P.settings.fps; if (!isFinite(t)) t = 0; t = Math.max(0, t);
  const fr = Math.round(t * f), ff = fr % f, s = Math.floor(fr / f), hh = Math.floor(s / 3600), mm = Math.floor(s / 60) % 60, ss = s % 60;
  const p2 = n => String(n).padStart(2, '0');
  return (hh ? p2(hh) + ':' : '') + p2(mm) + ':' + p2(ss) + ':' + p2(ff);
}
function fmtS(t) {
  if (!isFinite(t)) return '∞';
  if (t < 60) return t.toFixed(t < 10 ? 2 : 1) + 's';
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return m + ':' + String(s).padStart(2, '0');
}

/* ---------- tracks & clips ---------- */
const newTrack = type => ({ id: uid('t'), type, name: '', hidden: false, muted: false, solo: false, locked: false });
function nameTracks() {
  let v = 0, a = 0;
  const vs = P.tracks.filter(t => t.type === 'video');
  for (let i = vs.length - 1; i >= 0; i--) vs[i].name = 'V' + (++v);
  for (const t of P.tracks) if (t.type === 'audio') t.name = 'A' + (++a);
}
function defaultTracks() {
  P.tracks = [newTrack('video'), newTrack('video'), newTrack('audio'), newTrack('audio')];
  nameTracks(); UI.targetV = P.tracks[1].id; UI.targetA = P.tracks[2].id;
}
function addTrack(type) {
  const t = newTrack(type);
  if (type === 'video') P.tracks.unshift(t); else P.tracks.push(t);
  nameTracks(); return t;
}
const trackById = id => P.tracks.find(t => t.id === id);
const trackIdx = id => P.tracks.findIndex(t => t.id === id);
const clipById = id => P.clips.find(c => c.id === id);
const cdur = c => (c.out - c.in) / c.speed;
const cend = c => c.start + (c.out - c.in) / c.speed;
const trackOf = c => trackById(c.track);
const clipsOn = tid => P.clips.filter(c => c.track === tid).sort((a, b) => a.start - b.start || cend(a) - cend(b));
const selClips = () => [...UI.sel].map(clipById).filter(Boolean);
const isVisualKind = k => k !== 'audio';
const tlEnd = () => P.clips.reduce((m, c) => Math.max(m, cend(c)), 0);
function srcLen(c) {
  if (c.kind === 'video' || c.kind === 'audio') { const m = media.get(c.media); return m && isFinite(m.duration) ? m.duration : Infinity; }
  return Infinity;
}
function ensureTargets() {
  if (!trackById(UI.targetV) || trackById(UI.targetV).type !== 'video') { const v = P.tracks.filter(t => t.type === 'video'); UI.targetV = v.length ? v[v.length - 1].id : null; }
  if (!trackById(UI.targetA) || trackById(UI.targetA).type !== 'audio') { const a = P.tracks.find(t => t.type === 'audio'); UI.targetA = a ? a.id : null; }
}
const xfDefault = () => ({ type: P.settings.xfType, curve: 'smooth' });
const defFx = () => ({ bri: 1, con: 1, sat: 1, hue: 0, blur: 0 });
function baseClip(kind, track, start, dur) {
  return { id: uid('c'), media: null, kind, track, start, in: 0, out: dur, speed: 1, volume: 1, muted: false, opacity: 1,
    fadeIn: 0, fadeOut: 0, x: 0, y: 0, scale: 1, rot: 0, fit: 'fit', kb: false, fx: defFx(), name: '', label: null, xf: null };
}
function makeClip(m, tid, start) {
  const tr = trackById(tid);
  const kind = tr && tr.type === 'audio' ? 'audio' : m.type;
  const fin = isFinite(m.duration);
  const mi = fin ? clamp(m.markIn || 0, 0, m.duration) : 0;
  let mo = fin ? (m.markOut != null ? m.markOut : m.duration) : P.settings.imgDur;
  if (mo - mi < frame()) mo = fin ? m.duration : P.settings.imgDur;
  const c = baseClip(kind, tid, start, mo);
  c.media = m.id; c.in = mi; c.out = mo; c.name = m.name;
  if (kind === 'video' && m.picOnly) c.muted = true; // its sound was separated out to its own file
  return c;
}
function makeText(tid, start) {
  const c = baseClip('text', tid, start, 3);
  c.name = 'Title';
  c.text = { str: 'Your Title', font: '"Segoe UI", system-ui, sans-serif', size: Math.round(P.settings.h * 0.1), weight: 800, color: '#ffffff', align: 'center', x: 0.5, y: 0.5,
    shadow: true, stroke: false, strokeColor: '#000000', bg: false, bgColor: '#000000', bgAlpha: 0.55, anim: 'fadeUp' };
  c.fadeOut = 0.3;
  return c;
}
function makeMatte(tid, start) { const c = baseClip('color', tid, start, P.settings.imgDur); c.name = 'Colour matte'; c.color = '#1b1e26'; return c; }
function removeClip(c) { P.clips = P.clips.filter(x => x !== c && x.id !== c.id); UI.sel.delete(c.id); if (UI.selXf === c.id) UI.selXf = null; }
function setEnd(c, t) { c.out = c.in + (t - c.start) * c.speed; c.fadeOut = Math.min(c.fadeOut || 0, cdur(c)); c.fadeIn = Math.min(c.fadeIn || 0, cdur(c)); }
function trimStartTo(c, t) { c.in += (t - c.start) * c.speed; c.start = t; c.fadeIn = Math.min(c.fadeIn || 0, cdur(c)); c.fadeOut = Math.min(c.fadeOut || 0, cdur(c)); }
function splitClip(c, t) {
  const r = structuredClone(c);
  r.id = uid('c'); r.start = t; r.in = c.in + (t - c.start) * c.speed; c.out = r.in;
  r.fadeIn = 0; c.fadeOut = 0; r.xf = null;
  P.clips.push(r); return r;
}
/* overlaps: only partial overlaps of 2 clips (cross-fades) are legal; never containment, never 3 deep */
function trackValid(tid, allowOverlap = UI.autoX) {
  const cs = clipsOn(tid);
  for (let i = 0; i < cs.length - 1; i++) {
    const a = cs[i], b = cs[i + 1], ae = cend(a);
    if (b.start < ae - EPS) {
      if (!allowOverlap) return false;
      if (b.start <= a.start + EPS || cend(b) <= ae + EPS) return false;
      const c = cs[i + 2]; if (c && c.start < ae - EPS) return false;
    }
  }
  return true;
}
function ensureXf(tids) {
  for (const tid of tids) { const cs = clipsOn(tid); for (let i = 1; i < cs.length; i++) if (cs[i].start < cend(cs[i - 1]) - EPS && !cs[i].xf) cs[i].xf = xfDefault(); }
}
/* overwrite: carve [s,e) out of a track */
function cutRange(tid, s, e, ids) {
  for (const o of clipsOn(tid)) {
    if (ids && ids.has(o.id)) continue;
    const os = o.start, oe = cend(o);
    if (oe <= s + EPS || os >= e - EPS) continue;
    if (os >= s - EPS && oe <= e + EPS) { removeClip(o); continue; }
    if (os < s && oe > e) { splitClip(o, e); setEnd(o, s); continue; }
    if (os < s) setEnd(o, s); else trimStartTo(o, e);
  }
}
/* auto-crossfade resolve: partial overlaps stay as fades; covered clips vanish; dropping inside a clip splits it with fades both sides */
function xfResolve(d, ids) {
  for (const o of clipsOn(d.track)) {
    if (ids.has(o.id)) continue;
    const os = o.start, oe = cend(o), ds = d.start, de = cend(d);
    if (oe <= ds + EPS || os >= de - EPS) continue;
    if (os >= ds - EPS && oe <= de + EPS) { removeClip(o); continue; }
    if (os < ds - EPS && oe > de + EPS) {
      const xd = Math.min(P.settings.xfDur, (de - ds) / 3);
      const r = splitClip(o, q(de - xd)); setEnd(o, q(ds + xd));
      d.xf = d.xf || xfDefault(); r.xf = xfDefault();
    }
  }
}
function resolveDrop(ids, mode) {
  const set = new Set(ids);
  const dropped = () => ids.map(clipById).filter(Boolean);
  if (mode === 'insert') {
    for (const [tid, cs] of groupBy(dropped(), c => c.track)) {
      const ip = Math.min(...cs.map(c => c.start)), span = Math.max(...cs.map(cend)) - ip;
      for (const o of clipsOn(tid)) {
        if (set.has(o.id)) continue;
        if (o.start >= ip - EPS) o.start += span;
        else if (cend(o) > ip + EPS) { const r = splitClip(o, ip); r.start += span; }
      }
    }
    return 'insert';
  }
  const tids = new Set(dropped().map(c => c.track));
  if (mode === 'xfade') {
    const mid = snapState();
    for (const d of dropped()) xfResolve(d, set);
    if ([...tids].every(t => trackValid(t, true))) { ensureXf(tids); return 'xfade'; }
    loadState(mid);
  }
  for (const d of dropped()) cutRange(d.track, d.start, cend(d), set);
  return 'overwrite';
}
function closeGapAt(tid, t) {
  const cs = clipsOn(tid);
  if (cs.some(c => c.start < t - EPS && cend(c) > t + EPS)) return 0;
  let g0 = 0, g1 = Infinity;
  for (const c of cs) { const e = cend(c); if (e <= t + EPS) g0 = Math.max(g0, e); if (c.start >= t - EPS) g1 = Math.min(g1, c.start); }
  if (!isFinite(g1) || g1 - g0 < EPS) return 0;
  const sh = g1 - g0;
  for (const c of cs) if (c.start >= g1 - EPS) c.start -= sh;
  return sh;
}
function closeGapInRange(tid, s, e) {
  const cs = clipsOn(tid);
  const pts = [s, ...cs.map(cend).filter(x => x > s && x < e)].sort((a, b) => a - b);
  for (const p of pts) { const tt = p + 0.002; if (tt >= e) break; if (!cs.some(c => c.start < tt && cend(c) > tt)) return closeGapAt(tid, tt); }
  return 0;
}
function editPoints() {
  const s = new Set([0]);
  for (const c of P.clips) { s.add(+c.start.toFixed(5)); s.add(+cend(c).toFixed(5)); }
  return [...s].sort((a, b) => a - b);
}

/* ---------- history ---------- */
const HIST = { undo: [], redo: [] };
function snapState() { return JSON.stringify({ name: P.name, settings: P.settings, tracks: P.tracks, clips: P.clips, markers: P.markers, inPt: P.inPt, outPt: P.outPt }); }
function loadState(s) { const o = JSON.parse(s); Object.assign(P, o); }
function commit(before) {
  if (before === snapState()) return false;
  HIST.undo.push(before); if (HIST.undo.length > 300) HIST.undo.shift(); HIST.redo.length = 0;
  scheduleAutosave(); updUndoBtns(); return true;
}
function edit(fn, msg) { const b = snapState(); const r = fn(); if (commit(b)) { changed(); if (msg) toast(typeof msg === 'function' ? msg(r) : msg); } else changed(); return r; }
function afterRestore() {
  UI.sel = new Set([...UI.sel].filter(id => clipById(id)));
  if (UI.selXf && !clipById(UI.selXf)) UI.selXf = null;
  ensureTargets(); $('#projName').value = P.name; resizePreview(); renderHeads(); changed();
}
function undo() { if (!HIST.undo.length) return toast('Nothing to undo'); HIST.redo.push(snapState()); loadState(HIST.undo.pop()); afterRestore(); scheduleAutosave(); updUndoBtns(); toast('Undo'); }
function redo() { if (!HIST.redo.length) return toast('Nothing to redo'); HIST.undo.push(snapState()); loadState(HIST.redo.pop()); afterRestore(); scheduleAutosave(); updUndoBtns(); toast('Redo'); }
function updUndoBtns() { $('#bUndo').disabled = !HIST.undo.length; $('#bRedo').disabled = !HIST.redo.length; }

/* ---------- media import ---------- */
const EXT = { video: ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'ogv', 'avi'], audio: ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus', 'weba'], image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'svg'] };
function mediaType(f) {
  const t = f.type || '';
  if (t.startsWith('video/')) return 'video'; if (t.startsWith('audio/')) return 'audio'; if (t.startsWith('image/')) return 'image';
  const ext = (f.name.split('.').pop() || '').toLowerCase();
  for (const k in EXT) if (EXT[k].includes(ext)) return k;
  return null;
}
function waitEv(el, ok, ms = 15000) {
  return new Promise((res, rej) => {
    const to = setTimeout(() => { cl(); rej(new Error('timeout')); }, ms);
    const f = () => { cl(); res(); }, g = () => { cl(); rej(new Error('media error')); };
    function cl() { clearTimeout(to); el.removeEventListener(ok, f); el.removeEventListener('error', g); }
    el.addEventListener(ok, f); el.addEventListener('error', g);
  });
}
async function probe(m) {
  if (m.type === 'image') {
    const img = new Image(); img.src = m.url;
    try { await img.decode(); } catch (e) { await waitEv(img, 'load'); }
    m.img = img; m.w = img.naturalWidth || 1920; m.h = img.naturalHeight || 1080; m.duration = Infinity;
    const c = document.createElement('canvas'); c.height = 72; c.width = Math.max(8, Math.round(72 * m.w / m.h));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); m.thumbs = [{ t: 0, c }];
    return;
  }
  const el = document.createElement('video'); el.preload = 'metadata'; el.muted = true; el.src = m.url;
  await waitEv(el, 'loadedmetadata');
  if (!isFinite(el.duration)) { // MediaRecorder webm files report Infinity until you seek to the end
    el.currentTime = 1e7;
    try { await waitEv(el, 'seeked', 8000); } catch (e) { }
  }
  m.duration = isFinite(el.duration) ? el.duration : 60;
  m.w = el.videoWidth; m.h = el.videoHeight;
  if (m.type === 'video' && !m.w) m.type = 'audio';
  if (!m.w) { m.w = 16; m.h = 9; }
  el.removeAttribute('src'); el.load();
}
let thumbChain = Promise.resolve();
function genThumbs(m) {
  if (m.type !== 'video') return;
  thumbChain = thumbChain.then(async () => {
    const el = document.createElement('video'); el.muted = true; el.preload = 'auto'; el.src = m.url;
    try { await waitEv(el, 'loadeddata'); } catch (e) { return; }
    const n = clamp(Math.ceil(m.duration / 1.5), 1, 80), th = 72, tw = Math.max(8, Math.round(th * m.w / m.h));
    const out = [];
    for (let i = 0; i < n; i++) {
      // don't compete with playback for the video decoder
      while (UI.playing || EXP) await new Promise(r => setTimeout(r, 300));
      const t = Math.min(m.duration - 0.05, (i + 0.5) * m.duration / n);
      el.currentTime = Math.max(0, t);
      try { await waitEv(el, 'seeked', 6000); } catch (e) { continue; }
      const c = document.createElement('canvas'); c.width = tw; c.height = th;
      c.getContext('2d').drawImage(el, 0, 0, tw, th); out.push({ t, c });
      if (i === 0 || i % 8 === 7) { m.thumbs = out.slice(); dirtyTL = true; drawBinThumb(m); }
    }
    m.thumbs = out; el.removeAttribute('src'); el.load(); dirtyTL = true; drawBinThumb(m);
  });
}
function wavBlob(chs, sr) {
  const nc = Math.min(2, chs.length), n = chs[0].length, parts = [], hdr = new DataView(new ArrayBuffer(44));
  const ws = (o, s) => { for (let i = 0; i < 4; i++) hdr.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); hdr.setUint32(4, 36 + n * nc * 2, true); ws(8, 'WAVE'); ws(12, 'fmt '); hdr.setUint32(16, 16, true); hdr.setUint16(20, 1, true);
  hdr.setUint16(22, nc, true); hdr.setUint32(24, sr, true); hdr.setUint32(28, sr * nc * 2, true); hdr.setUint16(32, nc * 2, true); hdr.setUint16(34, 16, true); ws(36, 'data'); hdr.setUint32(40, n * nc * 2, true);
  parts.push(hdr.buffer);
  for (let s = 0; s < n; s += 1 << 20) {
    const e = Math.min(n, s + (1 << 20)), out = new Int16Array((e - s) * nc);
    for (let i = s, k = 0; i < e; i++) for (let c = 0; c < nc; c++) { const v = chs[c][i]; out[k++] = v < -1 ? -32768 : v > 1 ? 32767 : v * 32767; }
    parts.push(out.buffer);
  }
  return new Blob(parts, { type: 'audio/wav' });
}
// a media file's sound as a WAV: the in-RAM copy analyzeAudio made, else decoded now
async function audioWav(m) {
  if (m.sndUrl) return (await fetch(m.sndUrl)).blob();
  const buf = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(await m.file.arrayBuffer());
  return wavBlob(Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i)), buf.sampleRate);
}
const audioName = m => m.name.replace(/\.[^.]+$/, '') + ' (audio).wav';
// video → its sound becomes its own audio file in the bin (and saved to disk); the video is used picture-only from then on
async function separateAudio(m) {
  if (m.hasAudio === false) return toast(m.name + ' has no sound', true);
  toast('Separating the audio from ' + m.name + '…');
  let wav;
  try { wav = await audioWav(m); } catch (e) { m.hasAudio = false; return toast('No sound found in ' + m.name, true); }
  const [a] = await importFiles([new File([wav], audioName(m), { type: 'audio/wav' })], { quiet: true });
  if (!a) return;
  const n = P.clips.filter(c => c.media === m.id && c.kind === 'video' && !c.muted).length;
  edit(() => { m.picOnly = true; for (const c of P.clips) if (c.media === m.id && c.kind === 'video') c.muted = true; });
  UI.binSel = a.id; renderBin();
  download(wav, a.name);
  toast(`Audio separated to “${a.name}” — ${m.name} now comes in muted` + (n ? ` (${n} clip${n > 1 ? 's' : ''} on the timeline muted)` : ''));
}
async function saveAudio(m) {
  try { download(await audioWav(m), m.type === 'audio' && /\.wav$/i.test(m.name) ? m.name : audioName(m)); } catch (e) { toast("Couldn't read the sound in " + m.name, true); }
}
// clip volume that brings its loudest moment to −1 dBFS (from the waveform peaks, loudest channel)
function normaliseGain(c) {
  const m = media.get(c.media); if (!m || !m.peaks) return null;
  const d = m.peaks.data, r = m.peaks.rate; let pk = 0;
  for (let i = Math.floor(c.in * r), e = Math.min(d.length, Math.ceil(c.out * r)); i < e; i++) if (d[i] > pk) pk = d[i];
  return pk > 1e-4 ? clamp(0.891 / pk, dbToVol(-40), dbToVol(12)) : null;
}
function cmdNormalise(cs) {
  cs = cs.filter(c => c.kind === 'audio' || c.kind === 'video');
  const gs = cs.map(normaliseGain);
  if (!gs.some(g => g != null)) return toast('No waveform yet — wait for the audio to finish analysing', true);
  edit(() => cs.forEach((c, i) => { if (gs[i] != null) c.volume = gs[i]; }), cs.length > 1 ? `Normalised ${gs.filter(g => g != null).length} clips to −1 dB peak` : `Normalised to −1 dB peak (${fmtDb(volToDb(gs[0]))})`);
}
async function analyzeAudio(m) {
  if (!(m.type === 'video' || m.type === 'audio') || !m.file) return;
  if (m.file.size > 600e6) { m.noPeaks = true; return; }
  try {
    const ab = await m.file.arrayBuffer();
    const buf = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(ab);
    const sr = buf.sampleRate, n = buf.length, chs = [];
    for (let i = 0; i < buf.numberOfChannels; i++) chs.push(buf.getChannelData(i));
    const PR = 100, per = sr / PR, peaks = new Float32Array(Math.ceil(n / per) + 1);
    const HOP = 512, env = new Float32Array(Math.ceil(n / HOP) + 1), nc = chs.length;
    let prev = 0;
    for (let i = 0; i < n; i++) {
      let s = 0, a = 0; for (let k = 0; k < nc; k++) { const v = chs[k][i]; s += v; if (v > a) a = v; else if (-v > a) a = -v; } s /= nc;
      const pi = (i / per) | 0; if (a > peaks[pi]) peaks[pi] = a; // loudest channel, so Normalise never clips
      const d = s - prev; prev = s; env[(i / HOP) | 0] += d * d;
    }
    for (let i = 0; i < env.length; i++) env[i] = Math.sqrt(env[i] / HOP);
    m.peaks = { rate: PR, data: peaks }; m.env = { rate: sr / HOP, data: env }; m.hasAudio = true;
    // video files: keep the sound as an in-RAM WAV. Seeking audio inside a long-GOP MP4 waits on
    // video keyframes (0.5–1 s here); a WAV seeks instantly. ~10 MB per stereo minute.
    if (m.type === 'video' && buf.duration <= 20 * 60) { if (m.sndUrl) URL.revokeObjectURL(m.sndUrl); m.sndUrl = URL.createObjectURL(wavBlob(chs, sr)); }
    dirtyTL = true; if (m.type === 'audio') drawBinThumb(m);
  } catch (e) { m.hasAudio = false; }
}
async function importFiles(files, opt = {}) {
  ensureAudio();
  const added = [];
  for (const f of files) {
    const type = mediaType(f);
    if (!type) { toast('Skipped ' + f.name + ' (unsupported)', true); continue; }
    let m = opt.relink || [...media.values()].find(x => x.offline && x.name === f.name && (!x.size || x.size === f.size));
    const relinked = !!m;
    if (!m) { m = { id: uid('m'), name: f.name, size: f.size, type, duration: 0 }; media.set(m.id, m); }
    opt.relink = null;
    releaseMedia(m.id);
    if (m.url) URL.revokeObjectURL(m.url);
    if (m.proxy) URL.revokeObjectURL(m.proxy.url);
    if (m.sndUrl) URL.revokeObjectURL(m.sndUrl);
    m.proxyGen = (m.proxyGen || 0) + 1; // a build for the old file must not finish onto the new one
    freeStrip(m);
    Object.assign(m, { file: f, url: URL.createObjectURL(f), offline: false, size: f.size, type, thumbs: null, peaks: null, env: null, proxy: null, proxyState: null, _ix: null, info: null, sndUrl: null });
    try { await probe(m); } catch (e) { toast('Could not read ' + f.name, true); media.delete(m.id); continue; }
    added.push(m); renderBin();
    if (m.type === 'video') prepVideo(m); analyzeAudio(m);
    if (relinked) toast('Relinked ' + m.name);
  }
  // empty timeline: shape the project to the footage (vertical phone clips → 9:16)
  const v = !P.clips.length && added.find(m => m.type === 'video'), fr = v && footageFrame([{ kind: 'video', media: v.id, start: 0, in: 0, out: 1, speed: 1 }]);
  if (fr && fr !== `${P.settings.w}x${P.settings.h}`) {
    const [w, hh] = fr.split('x').map(Number);
    edit(() => { P.settings.w = w; P.settings.h = hh; }); resizePreview();
    toast(`Project set to ${w}×${hh} to match ${v.name} — change it under Project`);
  } else if (added.length) { changed(); if (!opt.quiet) toast(`Imported ${added.length} item${added.length > 1 ? 's' : ''}`); }
  return added;
}

/* ---------- audio graph ---------- */
let actx = null, master, monitor, analyser, recDest, meterBuf, meterPk = 0;
function ensureAudio() {
  if (actx) { if (actx.state === 'suspended') actx.resume(); return; }
  try {
    actx = new AudioContext({ latencyHint: 'interactive' });
    master = actx.createGain(); monitor = actx.createGain(); analyser = actx.createAnalyser(); analyser.fftSize = 1024;
    recDest = actx.createMediaStreamDestination();
    master.connect(analyser); master.connect(monitor); monitor.connect(actx.destination); master.connect(recDest);
    meterBuf = new Float32Array(analyser.fftSize);
    for (const p of pool) attachAudio(p);
  } catch (e) { console.warn(e); }
}
/* ---------- media element pool ---------- */
const pool = []; // {el, kind, mediaId, clipId, src, gain}
function attachAudio(p) {
  if (!actx || p.src || !(p.role === 'av' || p.role === 'snd')) return;
  try { p.src = actx.createMediaElementSource(p.el); p.gain = actx.createGain(); p.gain.gain.value = 0; p.src.connect(p.gain); p.gain.connect(master); } catch (e) { console.warn(e); }
}
/* Player roles per clip:
   av  – original video element: picture + sound (no proxy)
   pic – proxy video, picture only (muted)      ┐ used together when a proxy exists:
   snd – original file in an <audio> element     ┘ cheap picture, exact original sound
   hq  – original video, picture only, only while paused → full-quality still */
let exportSrcProxy = null; // during export: true = render from proxies, false = originals
function useProxyFor(m) { return !!(m && m.proxy && (exportSrcProxy != null ? exportSrcProxy : UI.proxy)); }
function clipRoles(c, m) { if (c.kind === 'audio') return ['snd']; if (c.kind !== 'video') return []; return useProxyFor(m) ? ['pic', 'snd'] : ['av']; }
function getEl(c, role) {
  const m = media.get(c.media); if (!m || m.offline || !m.url) return null;
  const url = role === 'pic' ? (m.proxy && m.proxy.url) : role === 'snd' ? (m.sndUrl || m.url) : m.url; if (!url) return null;
  let p = pool.find(p => p.clipId === c.id && p.role === role);
  if (p && p.url === url) return p;
  if (p) { p.clipId = null; p.el.pause(); if (p.gain) p.gain.gain.value = 0; } // a lighter source arrived — swap players
  const kind = role === 'snd' ? 'audio' : 'video';
  p = pool.find(p => !p.clipId && p.role === role && p.url === url);
  if (!p) {
    const el = document.createElement(kind);
    el.preload = 'auto'; el.playsInline = true; el.src = url; el.preservesPitch = true;
    if (role === 'pic' || role === 'hq') el.muted = true;
    el.addEventListener('seeked', () => { dirtyPV = true; if (!UI.playing) resyncSoon(); }); // re-check: a slow seek may have landed after the playhead moved on
    el.addEventListener('loadeddata', () => { dirtyPV = true; });
    if (kind === 'video' && el.requestVideoFrameCallback) { // track the frame actually presented (for the sync readout)
      const onFrame = (now, md) => { el._mt = md.mediaTime; el.requestVideoFrameCallback(onFrame); };
      el.requestVideoFrameCallback(onFrame);
    }
    $('#mediaHost').append(el);
    p = { el, kind, role, url, mediaId: m.id, clipId: null };
    if (role === 'av' || role === 'snd') attachAudio(p);
    pool.push(p);
  }
  p.clipId = c.id;
  return p;
}
function releaseMedia(mid) {
  for (let i = pool.length - 1; i >= 0; i--) {
    const p = pool[i]; if (p.mediaId !== mid) continue;
    p.el.pause(); p.el.removeAttribute('src'); p.el.load(); p.el.remove();
    try { p.gain && p.gain.disconnect(); p.src && p.src.disconnect(); } catch (e) { }
    pool.splice(i, 1);
  }
}
function trimPool() {
  const free = pool.filter(p => !p.clipId);
  if (free.length <= 4) return; // idle players still hold a video decoder each — keep only a few warm
  for (const p of free.slice(0, free.length - 4)) {
    p.el.removeAttribute('src'); p.el.load(); p.el.remove();
    try { p.gain && p.gain.disconnect(); p.src && p.src.disconnect(); } catch (e) { }
    pool.splice(pool.indexOf(p), 1);
  }
}
function neighbors(c) { const cs = clipsOn(c.track); const i = cs.indexOf(c); return [cs[i - 1], cs[i + 1]]; }
const xfIn = (p, type) => (type === 'dipBlack' || type === 'dipWhite') ? clamp(p * 2 - 1, 0, 1) : Math.sin(p * Math.PI / 2);
const xfOut = (p, type) => (type === 'dipBlack' || type === 'dipWhite') ? clamp(1 - p * 2, 0, 1) : Math.cos(p * Math.PI / 2);
function clipGain(c, t) {
  const tr = trackOf(c); if (!tr || tr.muted || c.muted) return 0;
  if (P.tracks.some(x => x.solo) && !tr.solo) return 0;
  let g = c.volume == null ? 1 : c.volume;
  const lt = t - c.start, rt = cend(c) - t;
  if (c.fadeIn > 0 && lt < c.fadeIn) g *= clamp(lt / c.fadeIn, 0, 1);
  if (c.fadeOut > 0 && rt < c.fadeOut) g *= clamp(rt / c.fadeOut, 0, 1);
  const [pr, nx] = neighbors(c);
  if (pr && cend(pr) > c.start + EPS && t < cend(pr)) g *= xfIn(clamp((t - c.start) / (cend(pr) - c.start), 0, 1), (c.xf || xfDefault()).type);
  if (nx && nx.start < cend(c) - EPS && t >= nx.start) g *= xfOut(clamp((t - nx.start) / (cend(c) - nx.start), 0, 1), (nx.xf || xfDefault()).type);
  return Math.max(0, g);
}
let lastScrub = 0, hqTimer = 0, resyncQueued = false;
function resyncSoon() { if (resyncQueued) return; resyncQueued = true; setTimeout(() => { resyncQueued = false; if (!UI.playing) syncMedia(UI.t, false); }, 0); }
function scheduleHQ() { lastScrub = performance.now(); clearTimeout(hqTimer); hqTimer = setTimeout(() => { if (!UI.playing) { syncMedia(UI.t, false); dirtyPV = true; } }, 320); }
function syncMedia(t, playing) {
  const need = new Map(), look = playing ? 1.5 : 0, hqOk = !playing && exportSrcProxy == null && performance.now() - lastScrub > 280;
  for (const c of P.clips) {
    if (!c.media || !(c.kind === 'video' || c.kind === 'audio')) continue;
    const s = c.start, e = cend(c);
    if (!(t >= s - look - EPS && t < e)) continue;
    const m = media.get(c.media), active = t >= s - EPS;
    for (const role of clipRoles(c, m)) need.set(c.id + '|' + role, { c, m, role, active });
    if (hqOk && active && c.kind === 'video' && useProxyFor(m)) need.set(c.id + '|hq', { c, m, role: 'hq', active });
  }
  for (const p of pool) if (p.clipId && !need.has(p.clipId + '|' + p.role)) { p.clipId = null; if (!p.el.paused) p.el.pause(); if (p.gain) p.gain.gain.value = 0; }
  for (const { c, m, role, active } of need.values()) {
    const p = getEl(c, role); if (!p) continue;
    const el = p.el;
    const target = active ? Math.min(c.in + (t - c.start) * c.speed, c.out - 0.001) : c.in;
    if (playing && active) {
      const r = clamp(c.speed * UI.rate, 0.0625, 16);
      if (el.playbackRate !== r) el.playbackRate = r;
      // proxies seek in a blink; long-GOP originals take seconds, so correct those far less eagerly
      const tol = role === 'pic' ? 0.1 : (m && m._ix && m._ix.gopSec > 1 ? 0.6 : 0.2);
      if (el.paused) {
        if (!el.seeking && Math.abs(el.currentTime - target) > 0.04) el.currentTime = target;
        const pr = el.play(); if (pr) pr.catch(() => { });
      } else if (!el.seeking && Math.abs(el.currentTime - target) > tol * Math.max(1, r)) el.currentTime = target;
    } else {
      if (!el.paused) el.pause();
      if (!el.seeking && Math.abs(el.currentTime - target) > 0.5 / fps()) el.currentTime = target;
    }
    if (p.gain && actx) {
      const g = (playing && active) ? clipGain(c, t) : 0;
      p.gain.gain.setTargetAtTime(g, actx.currentTime, 0.012);
    }
  }
}

/* ---------- playback ---------- */
let t0 = 0, p0 = 0;
const playStart = () => (UI.loop && P.inPt != null) ? P.inPt : 0;
const playEnd = () => (UI.loop && P.outPt != null) ? P.outPt : tlEnd();
function setTime(t) {
  UI.t = Math.max(0, t);
  if (UI.playing) { t0 = UI.t; p0 = performance.now(); } else scheduleHQ();
  syncMedia(UI.t, UI.playing && UI.rate > 0);
  dirtyPV = dirtyTL = true;
}
function play(rate = 1) {
  ensureAudio();
  if (UI.mode === 'source') return srcPlay(rate);
  if (!UI.playing && rate > 0) { const e = playEnd(); if (e <= 0) return toast('Timeline is empty — import some media first'); if (UI.t >= e - frame()) UI.t = playStart(); }
  UI.rate = rate; UI.playing = true; t0 = UI.t; p0 = performance.now();
  syncMedia(UI.t, rate > 0); updPlayBtn();
}
function pause() {
  if (UI.mode === 'source' && srcEl) { srcEl.pause(); updPlayBtn(); return; }
  UI.playing = false; UI.rate = 1; scheduleHQ(); syncMedia(UI.t, false); updPlayBtn(); dirtyPV = dirtyTL = true;
}
function togglePlay() {
  if (UI.mode === 'source') { if (srcEl && !srcEl.paused) pause(); else play(1); return; }
  UI.playing ? pause() : play(1);
}
function shuttle(dir) {
  if (UI.mode === 'source') { if (!srcEl) return; if (dir < 0) { srcStep(-fps()); return; } srcEl.playbackRate = srcEl.paused ? 1 : Math.min(srcEl.playbackRate * 2, 8); srcEl.play(); updPlayBtn(); return; }
  if (!UI.playing || Math.sign(UI.rate) !== dir) play(dir);
  else { UI.rate = clamp(UI.rate * 2, -8, 8); t0 = UI.t; p0 = performance.now(); syncMedia(UI.t, UI.rate > 0); }
  toast((UI.rate > 0 ? '▶ ' : '◀ ') + Math.abs(UI.rate) + '×');
}
function updPlayBtn() {
  const playing = UI.mode === 'source' ? (srcEl && !srcEl.paused) : UI.playing;
  $('#tPlay').textContent = playing ? '❚❚' : '▶';
}
function followPlayhead() {
  if (UI.drag) return;
  const x = X(UI.t);
  if (x > TW - 40 || x < 0) { UI.sx = Math.max(0, UI.t * UI.pps - 60); dirtyTL = true; }
}

/* ---------- preview render ---------- */
const pv = $('#pv'), pg = pv.getContext('2d', { alpha: false });
function resizePreview() {
  pv.width = Math.round(P.settings.w * UI.pvScale); pv.height = Math.round(P.settings.h * UI.pvScale);
  fitStage(); buildGuides(); dirtyPV = true; updInfo();
}
function fitStage() {
  const wrap = $('#stageWrap'), st = $('#stage');
  const W = wrap.clientWidth - 40, H = wrap.clientHeight - 20, ar = P.settings.w / P.settings.h;
  let w = W, hh = W / ar; if (hh > H) { hh = H; w = H * ar; }
  st.style.width = Math.max(10, w) + 'px'; st.style.height = Math.max(10, hh) + 'px';
}
function filterStr(c, S, extraBlur) {
  const f = c.fx, parts = [];
  if (f) {
    if (f.bri !== 1) parts.push(`brightness(${f.bri})`);
    if (f.con !== 1) parts.push(`contrast(${f.con})`);
    if (f.sat !== 1) parts.push(`saturate(${f.sat})`);
    if (f.hue) parts.push(`hue-rotate(${f.hue}deg)`);
    if (f.blur > 0) parts.push(`blur(${f.blur * S}px)`);
  }
  if (extraBlur > 0.3) parts.push(`blur(${extraBlur}px)`);
  return parts.join(' ');
}
function clipAlpha(c, t) {
  let a = c.opacity == null ? 1 : c.opacity;
  const lt = t - c.start, rt = cend(c) - t;
  if (c.fadeIn > 0 && lt < c.fadeIn) a *= clamp(lt / c.fadeIn, 0, 1);
  if (c.fadeOut > 0 && rt < c.fadeOut) a *= clamp(rt / c.fadeOut, 0, 1);
  return a;
}
function drawOffline(g, W, H) {
  g.fillStyle = '#3a0d14'; g.fillRect(0, 0, W, H);
  g.strokeStyle = 'rgba(255,77,94,.35)'; g.lineWidth = W / 80;
  for (let x = -H; x < W; x += W / 12) { g.beginPath(); g.moveTo(x, H); g.lineTo(x + H, 0); g.stroke(); }
  g.fillStyle = '#ff4d5e'; g.font = `800 ${H / 12}px "Segoe UI",sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('MEDIA OFFLINE', W / 2, H / 2);
}
function drawText(g, c, t, S, o) {
  const T = c.text, W = P.settings.w * S, H = P.settings.h * S, lt = t - c.start;
  let alpha = 1, dx = 0, dy = 0, sc = 1, str = T.str || '';
  switch (T.anim) {
    case 'fadeUp': { const k = easeOut(clamp(lt / 0.45, 0, 1)); alpha = k; dy = (1 - k) * 0.04 * H; break; }
    case 'pop': { const k = clamp(lt / 0.35, 0, 1); sc = 0.6 + 0.4 * backOut(k); alpha = clamp(lt / 0.1, 0, 1); break; }
    case 'slide': { const k = easeOut(clamp(lt / 0.45, 0, 1)); alpha = k; dx = -(1 - k) * 0.08 * W; break; }
    case 'type': { const ch = [...str], k = clamp(lt / Math.max(0.4, ch.length * 0.045), 0, 1); str = ch.slice(0, Math.round(ch.length * k)).join(''); break; }
  }
  if (alpha <= 0) return;
  g.globalAlpha *= alpha;
  const fs = T.size * S; g.font = `${T.weight || 700} ${fs}px ${T.font}`; g.textAlign = T.align || 'center'; g.textBaseline = 'middle';
  const lines = str.split('\n'), lh = fs * 1.18, y0 = -(lines.length - 1) * lh / 2;
  g.translate(T.x * W + dx + (o.dx || 0), T.y * H + dy + (o.dy || 0)); if (sc !== 1) g.scale(sc, sc);
  if (T.bg) {
    const mw = Math.max(1, ...lines.map(l => g.measureText(l).width)), pad = fs * 0.32;
    const bx = T.align === 'left' ? -pad : T.align === 'right' ? -mw - pad : -mw / 2 - pad;
    g.save(); g.globalAlpha *= T.bgAlpha == null ? 0.55 : T.bgAlpha; g.fillStyle = T.bgColor || '#000';
    g.beginPath(); g.roundRect(bx, y0 - lh / 2 - pad * 0.35, mw + pad * 2, lh * lines.length + pad * 0.7, fs * 0.12); g.fill(); g.restore();
  }
  if (T.shadow) { g.shadowColor = 'rgba(0,0,0,.55)'; g.shadowBlur = fs * 0.15; g.shadowOffsetY = fs * 0.04; }
  if (T.stroke) { g.lineWidth = fs * 0.08; g.strokeStyle = T.strokeColor || '#000'; g.lineJoin = 'round'; lines.forEach((l, i) => g.strokeText(l, 0, y0 + i * lh)); g.shadowColor = 'transparent'; }
  g.fillStyle = T.color; lines.forEach((l, i) => g.fillText(l, 0, y0 + i * lh));
}
function drawVisual(g, c, t, S, alpha = 1, o = {}) {
  const a = clipAlpha(c, t) * alpha; if (a <= 0.002) return;
  const W = P.settings.w * S, H = P.settings.h * S;
  g.save();
  if (o.clip) { g.beginPath(); o.clip(g, W, H); g.clip(); }
  g.globalAlpha = a;
  const f = filterStr(c, S, o.blur || 0); if (f) g.filter = f;
  if (c.kind === 'color') { g.fillStyle = c.color || '#000'; g.fillRect(o.dx || 0, o.dy || 0, W, H); }
  else if (c.kind === 'text') drawText(g, c, t, S, o);
  else {
    const m = media.get(c.media);
    if (!m || m.offline) { g.translate(o.dx || 0, o.dy || 0); drawOffline(g, W, H); }
    else {
      let src, sw, sh;
      if (c.kind === 'image') { src = m.img; sw = m.w; sh = m.h; }
      else if (EXPSRC) { // offline export: exact decoded frame for this clip
        src = EXPSRC.get(c.id); if (!src) { g.restore(); return; } sw = m.w; sh = m.h;
      }
      else {
        // picture source: proxy/original, upgraded to the full-quality 'hq' frame once it has landed on the right time
        let p = pool.find(p => p.clipId === c.id && (p.role === 'pic' || p.role === 'av'));
        const hq = !UI.playing && pool.find(p => p.clipId === c.id && p.role === 'hq');
        const want = c.in + (t - c.start) * c.speed;
        if (hq && hq.el.readyState >= 2 && !hq.el.seeking && Math.abs(hq.el.currentTime - want) < 0.6 / fps()) p = hq;
        // player not on this frame yet (a seek in flight while scrubbing): show the RAM strip's nearest small frame meanwhile
        const behind = !p || p.el.readyState < 2 || (!UI.playing && (p.el.seeking || Math.abs(p.el.currentTime - Math.min(want, c.out - 0.001)) > 1.5 / fps()));
        const sb = behind && stripAt(m, want);
        if (sb) { src = sb; frameQual = 'proxy'; }
        else if (!p || p.el.readyState < 2) { g.restore(); return; }
        else { if (p.role === 'pic') frameQual = 'proxy'; else if (m.proxy && frameQual !== 'proxy') frameQual = 'full'; src = p.el; }
        sw = m.w; sh = m.h; // lay out in source dimensions so proxy, strip and original frame identically
      }
      let kx = W / sw, ky = H / sh;
      if (c.fit === 'fill') kx = ky = Math.max(kx, ky); else if (c.fit !== 'stretch') kx = ky = Math.min(kx, ky);
      let k = (c.scale || 1) * (o.scale || 1), px = 0;
      if (c.kb) { const p = clamp((t - c.start) / cdur(c), 0, 1); k *= 1 + 0.12 * p; px = (p - 0.5) * 0.03 * W * (c.kbDir || 1); }
      g.translate(W / 2 + (c.x || 0) * S + (o.dx || 0) + px, H / 2 + (c.y || 0) * S + (o.dy || 0));
      if (c.rot) g.rotate(c.rot * Math.PI / 180);
      g.scale(kx * k, ky * k);
      g.drawImage(src, -sw / 2, -sh / 2, sw, sh);
    }
  }
  g.restore();
}
const XF = {
  dissolve: 'Cross dissolve', dipBlack: 'Dip to black', dipWhite: 'Dip to white', blur: 'Blur dissolve', zoom: 'Zoom through', whip: 'Whip pan',
  slideL: 'Push left', slideR: 'Push right', wipeL: 'Wipe →', wipeR: 'Wipe ←', wipeU: 'Wipe ↑', iris: 'Iris',
};
const XF_SHORT = { dissolve: 'Dissolve', dipBlack: 'Dip', dipWhite: 'Dip W', blur: 'Blur', zoom: 'Zoom', whip: 'Whip', slideL: 'Push', slideR: 'Push', wipeL: 'Wipe', wipeR: 'Wipe', wipeU: 'Wipe', iris: 'Iris' };
function renderXf(g, A, B, t, S) {
  const W = P.settings.w * S, H = P.settings.h * S, span = cend(A) - B.start;
  const xf = B.xf || xfDefault(), e = (EASE[xf.curve] || EASE.smooth)(clamp(span > 0 ? (t - B.start) / span : 1, 0, 1));
  const veil = (col, a) => { g.save(); g.globalAlpha = clamp(a, 0, 1); g.fillStyle = col; g.fillRect(0, 0, W, H); g.restore(); };
  switch (xf.type) {
    case 'dipBlack': case 'dipWhite': { const col = xf.type === 'dipBlack' ? '#000' : '#fff'; if (e < 0.5) { drawVisual(g, A, t, S); veil(col, e * 2); } else { drawVisual(g, B, t, S); veil(col, (1 - e) * 2); } break; }
    case 'wipeL': drawVisual(g, A, t, S); drawVisual(g, B, t, S, 1, { clip: (c) => c.rect(0, 0, W * e, H) }); break;
    case 'wipeR': drawVisual(g, A, t, S); drawVisual(g, B, t, S, 1, { clip: (c) => c.rect(W * (1 - e), 0, W * e, H) }); break;
    case 'wipeU': drawVisual(g, A, t, S); drawVisual(g, B, t, S, 1, { clip: (c) => c.rect(0, H * (1 - e), W, H * e) }); break;
    case 'slideL': drawVisual(g, A, t, S, 1, { dx: -W * e }); drawVisual(g, B, t, S, 1, { dx: W * (1 - e) }); break;
    case 'slideR': drawVisual(g, A, t, S, 1, { dx: W * e }); drawVisual(g, B, t, S, 1, { dx: -W * (1 - e) }); break;
    case 'zoom': drawVisual(g, A, t, S, 1, { scale: 1 + e * 0.3, blur: e * 10 * S }); drawVisual(g, B, t, S, e, { scale: 1.3 - 0.3 * e, blur: (1 - e) * 10 * S }); break;
    case 'iris': drawVisual(g, A, t, S); drawVisual(g, B, t, S, 1, { clip: (c) => c.arc(W / 2, H / 2, Math.hypot(W, H) / 2 * e, 0, Math.PI * 2) }); break;
    case 'blur': drawVisual(g, A, t, S, 1, { blur: e * 22 * S }); drawVisual(g, B, t, S, e, { blur: (1 - e) * 22 * S }); break;
    case 'whip': { const mb = Math.sin(e * Math.PI) * 38 * S; drawVisual(g, A, t, S, 1, { dx: -W * e, blur: mb }); drawVisual(g, B, t, S, 1, { dx: W * (1 - e), blur: mb }); break; }
    default: drawVisual(g, A, t, S); drawVisual(g, B, t, S, e);
  }
}
function renderTimelineFrame(g, t, S) {
  const vts = P.tracks.filter(tr => tr.type === 'video');
  for (let i = vts.length - 1; i >= 0; i--) {
    const tr = vts[i]; if (tr.hidden) continue;
    const act = clipsOn(tr.id).filter(c => t >= c.start - EPS && t < cend(c) - EPS);
    if (act.length >= 2) renderXf(g, act[act.length - 2], act[act.length - 1], t, S);
    else if (act.length) drawVisual(g, act[0], t, S);
  }
}
function renderPreview() {
  updBuildNote();
  const g = pg, W = pv.width, H = pv.height;
  g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.filter = 'none';
  g.fillStyle = P.settings.bg; g.fillRect(0, 0, W, H);
  if (UI.mode === 'source') return renderSource(g, W, H);
  const t0 = performance.now();
  frameQual = null;
  renderTimelineFrame(g, UI.t, W / P.settings.w);
  updQual();
  pvDrawMs = pvDrawMs * 0.85 + (performance.now() - t0) * 0.15;
}
let pvDrawMs = 0, frameQual = null, shownQual = undefined;
// playhead on a part of a clip its proxy hasn't reached yet → say so (the preview falls back to the slow original there)
function updBuildNote() {
  let txt = '';
  if (UI.mode !== 'source' && !EXP && UI.proxy) for (const c of P.clips) {
    if (c.kind !== 'video' || !(UI.t >= c.start - EPS && UI.t < cend(c) - EPS)) continue;
    const m = media.get(c.media), st = m && m.proxyState; if (!st || !/building|queued/.test(st.status)) continue;
    if (st.status === 'queued') { txt = 'Proxy queued…'; break; }
    if (c.in + (UI.t - c.start) * c.speed > st.p * m.duration) { txt = `Building proxy… ${Math.floor(st.p * 100)}%`; break; }
  }
  const el = $('#pnote'); if (el.textContent !== txt) el.textContent = txt; el.hidden = !txt;
}
function updQual() {
  if (frameQual === shownQual) return; shownQual = frameQual;
  const el = $('#qual'); el.hidden = !frameQual || !!EXP;
  el.textContent = frameQual === 'proxy' ? 'PROXY' : 'FULL QUALITY'; el.className = frameQual || '';
}

/* ---------- source viewer ---------- */
let srcEl = null;
function openSource(m) {
  if (!m || m.offline) return;
  if (UI.playing) pause();
  UI.src = m;
  if (srcEl) { srcEl.pause(); srcEl.remove(); srcEl = null; }
  if (m.type !== 'image') {
    srcEl = document.createElement(m.type === 'audio' ? 'audio' : 'video');
    srcEl.preload = 'auto'; srcEl.src = m.url;
    srcEl.addEventListener('seeked', () => { dirtyPV = true; drawSrcBar(); });
    srcEl.addEventListener('loadeddata', () => { dirtyPV = true; drawSrcBar(); });
    srcEl.addEventListener('pause', updPlayBtn); srcEl.addEventListener('play', updPlayBtn);
    $('#mediaHost').append(srcEl);
    srcEl.currentTime = m.markIn || 0;
  }
  const tab = $('#tabSrc'); tab.disabled = false; tab.textContent = 'Source · ' + (m.name.length > 22 ? m.name.slice(0, 20) + '…' : m.name);
  setMode('source');
}
function setMode(mode) {
  if (mode === 'source' && !UI.src) return;
  if (UI.mode === mode) return;
  if (UI.playing) pause();
  if (srcEl && !srcEl.paused) srcEl.pause();
  UI.mode = mode;
  $('#viewer').classList.toggle('source', mode === 'source');
  $('#tabTL').classList.toggle('on', mode === 'timeline'); $('#tabSrc').classList.toggle('on', mode === 'source');
  if (mode === 'source') { sizeSrcBar(); drawSrcBar(); }
  updPlayBtn(); dirtyPV = true; updInfo();
}
const srcT = () => srcEl ? srcEl.currentTime : 0;
function srcPlay(rate) { if (!srcEl) return; srcEl.playbackRate = Math.max(0.25, Math.abs(rate)); const pr = srcEl.play(); if (pr) pr.catch(() => { }); updPlayBtn(); }
function srcSeek(t) { if (!srcEl || !UI.src) return; srcEl.currentTime = clamp(t, 0, UI.src.duration); dirtyPV = true; drawSrcBar(); }
function srcStep(n) { srcSeek(srcT() + n / fps()); }
function renderSource(g, W, H) {
  const m = UI.src; if (!m) return;
  let src = null, sw = m.w, sh = m.h;
  if (m.type === 'image') src = m.img;
  else if (m.type === 'video' && srcEl && srcEl.readyState >= 2) src = srcEl;
  if (src) { const k = Math.min(W / sw, H / sh); g.drawImage(src, (W - sw * k) / 2, (H - sh * k) / 2, sw * k, sh * k); }
  else if (m.type === 'audio') {
    g.fillStyle = '#0f1a15'; g.fillRect(0, 0, W, H);
    if (m.peaks) drawWaveGeneric(g, m, 0, m.duration, 0, H * 0.25, W, H * 0.5, '#36946d');
    g.fillStyle = '#5bd18b'; g.font = `600 ${H / 22}px "Segoe UI",sans-serif`; g.textAlign = 'center'; g.fillText(m.name, W / 2, H * 0.15);
    const x = srcT() / m.duration * W; g.fillStyle = '#ff8a3d'; g.fillRect(x - 1, H * 0.2, 3, H * 0.6);
  }
}
function drawWaveGeneric(g, m, t0, t1, x, y, w, hh, col) {
  const d = m.peaks.data, r = m.peaks.rate; g.fillStyle = col;
  const mid = y + hh / 2; g.beginPath();
  for (let px = 0; px < w; px++) {
    const a = t0 + (t1 - t0) * px / w, b = t0 + (t1 - t0) * (px + 1) / w;
    let i0 = Math.floor(a * r), i1 = Math.max(i0 + 1, Math.ceil(b * r)), pk = 0;
    for (let i = i0; i < i1 && i < d.length; i++) if (d[i] > pk) pk = d[i];
    const v = Math.pow(pk, 0.7) * hh / 2; g.rect(x + px, mid - v, 1, Math.max(1, v * 2));
  }
  g.fill();
}
const sb = $('#srcBar'), sbg = sb.getContext('2d');
function sizeSrcBar() { const r = sb.getBoundingClientRect(); sb.width = Math.max(10, r.width * devicePixelRatio); sb.height = 26 * devicePixelRatio; }
function drawSrcBar() {
  if (UI.mode !== 'source' || !UI.src) return;
  const m = UI.src, W = sb.width, H = sb.height, d = isFinite(m.duration) ? m.duration : 1, k = devicePixelRatio;
  sbg.fillStyle = '#101216'; sbg.fillRect(0, 0, W, H);
  if (m.thumbs && m.thumbs.length && m.type === 'video') {
    const tw = H * m.w / m.h; sbg.globalAlpha = 0.35;
    for (let x = 0; x < W; x += tw) { const th = m.thumbs[Math.min(m.thumbs.length - 1, Math.floor(x / W * m.thumbs.length))]; sbg.drawImage(th.c, x, 0, tw, H); }
    sbg.globalAlpha = 1;
  } else if (m.peaks) drawWaveGeneric(sbg, m, 0, d, 0, 2 * k, W, H - 4 * k, 'rgba(91,209,139,.5)');
  const a = (m.markIn || 0) / d * W, b = (m.markOut != null ? m.markOut : d) / d * W;
  sbg.fillStyle = 'rgba(76,201,240,.22)'; sbg.fillRect(a, 0, b - a, H);
  sbg.fillStyle = '#4cc9f0'; sbg.fillRect(a, 0, 2 * k, H); sbg.fillRect(b - 2 * k, 0, 2 * k, H);
  const x = srcT() / d * W; sbg.fillStyle = '#ff8a3d'; sbg.fillRect(x - k, 0, 2 * k, H);
}
