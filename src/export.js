/* ============================================================
   frame-accurate offline export
   every output frame t = n/fps is composited from exactly-decoded source frames
   (WebCodecs), encoded H.264, audio mixed offline (OfflineAudioContext) and
   encoded AAC/Opus, then muxed into an MP4. Faster than real time, no dropped
   frames, works in a background tab.
   ============================================================ */
let EXPSRC = null; // clipId → drawable (VideoFrame / canvas / <video>) while exporting
const nextTick = () => new Promise(r => { const ch = new MessageChannel(); ch.port1.onmessage = () => r(); ch.port2.postMessage(0); });
function codecWait(codec, waiters) {
  return new Promise(r => {
    let done = false;
    const f = () => { if (done) return; done = true; codec.removeEventListener('dequeue', f); if (waiters) waiters.delete(f); clearTimeout(to); r(); };
    const to = setTimeout(f, 100); codec.addEventListener('dequeue', f); if (waiters) waiters.add(f);
  });
}
const even = v => Math.max(2, Math.round(v / 2) * 2);

/* ---------- frame readers ---------- */
class MP4Reader { // sequential WebCodecs decode from the keyframe before the clip's first frame
  constructor(m, srcStart) {
    const ix = this.ix = m._ix; this.m = m; this.frames = []; this.waiters = new Set(); this.err = null; this.flushed = false; this.wBuf = null; this.wStart = 0;
    let k = 0;
    for (let i = 0; i < ix.n; i++) { if (ix.pts[i] > srcStart + 10) break; if (ix.key[i] && ix.pts[i] <= srcStart + 1e-4) k = i; }
    this.next = k;
    const wake = () => { for (const w of [...this.waiters]) w(); };
    this.dec = new VideoDecoder({ output: f => { this.frames.push(f); wake(); }, error: e => { this.err = e; wake(); } });
    this.dec.configure({ codec: ix.codec, codedWidth: ix.cw, codedHeight: ix.ch, description: ix.description, hardwareAcceleration: 'prefer-hardware' });
  }
  async sample(i) {
    const o = this.ix.off[i], s = this.ix.size[i];
    if (!this.wBuf || o < this.wStart || o + s > this.wStart + this.wBuf.length) { this.wStart = o; this.wBuf = await readBytes(this.m.file, o, Math.min(this.m.file.size, o + Math.max(8 << 20, s))); }
    return this.wBuf.subarray(o - this.wStart, o - this.wStart + s);
  }
  async frameAt(st) { // latest frame with pts ≤ st
    const tol = 5e-4;
    for (; ;) {
      if (this.err) throw this.err;
      while (this.frames.length >= 2 && this.frames[1].timestamp / 1e6 <= st + tol) this.frames.shift().close();
      const last = this.frames[this.frames.length - 1];
      if ((last && last.timestamp / 1e6 > st + tol) || this.flushed) break;
      if (this.next >= this.ix.n) { await this.dec.flush(); this.flushed = true; continue; }
      if (this.dec.decodeQueueSize >= 4) { await codecWait(this.dec, this.waiters); continue; }
      const i = this.next++;
      this.dec.decode(new EncodedVideoChunk({ type: this.ix.key[i] ? 'key' : 'delta', timestamp: Math.round(this.ix.pts[i] * 1e6), data: await this.sample(i) }));
      if (this.dec.decodeQueueSize >= 2) await nextTick();
    }
    return this.frames[0] || null;
  }
  close() { for (const f of this.frames) f.close(); this.frames = []; try { this.dec.close(); } catch (e) { } }
}
class ElReader { // fallback for files we can't demux (WebM, rotated phone clips…): exact seek per frame
  constructor(m) { const el = this.el = document.createElement('video'); el.muted = true; el.preload = 'auto'; el.src = m.url; $('#mediaHost').append(el); this.ready = false; }
  async frameAt(st) {
    if (!this.ready) { await waitEv(this.el, 'loadeddata', 30000); this.ready = true; this.el.currentTime = st; await waitEv(this.el, 'seeked', 30000); return this.el; }
    if (Math.abs(this.el.currentTime - st) > 1e-4) { this.el.currentTime = st; await waitEv(this.el, 'seeked', 30000); }
    return this.el;
  }
  close() { this.el.removeAttribute('src'); this.el.load(); this.el.remove(); }
}
const canDecode = m => !!(m._ix && m._ix.codec && !m._ix.rotated && window.VideoDecoder);
function makeReader(m, st, c, OW, OH) {
  const r = canDecode(m) ? new MP4Reader(m, st) : new ElReader(m);
  // shrink big source frames on the GPU first — 2D drawImage of a 4K frame is the slow part
  const sc = Math.max(1, c.scale || 1) * (c.kb ? 1.13 : 1);
  let k = (c.fit === 'fill' || c.fit === 'stretch' ? Math.max : Math.min)(OW / m.w, OH / m.h) * sc;
  const tw = even(Math.min(m.w, m.w * k)), th = even(Math.min(m.h, m.h * k));
  if (tw * th < m.w * m.h * 0.6 && r instanceof MP4Reader) { const s = makeScaler(tw, th); r.scale = f => { s.draw(f); return s.canvas; }; }
  return r;
}

/* ---------- codec selection ---------- */
async function pickH264(w, h, fps, bps) {
  const mbs = Math.ceil(w / 16) * Math.ceil(h / 16), mbps = mbs * fps;
  const lvl = (mbs <= 8192 && mbps <= 245760) ? '29' : (mbs <= 36864 && mbps <= 983040) ? '33' : '34';
  for (const prof of ['6400', '4d00', '4200']) for (const hw of ['prefer-hardware', 'no-preference']) {
    const cfg = { codec: `avc1.${prof}${lvl}`, width: w, height: h, bitrate: bps, framerate: fps, hardwareAcceleration: hw, avc: { format: 'avc' } };
    try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg; } catch (e) { }
  }
  return null;
}
async function pickAudio(sr) {
  if (!window.AudioEncoder) return null;
  for (const codec of ['mp4a.40.2', 'opus']) {
    const cfg = { codec, sampleRate: sr, numberOfChannels: 2, bitrate: codec === 'opus' ? 160000 : 192000 };
    try { if ((await AudioEncoder.isConfigSupported(cfg)).supported) return cfg; } catch (e) { }
  }
  return null;
}
function webCodecsMissingReason() {
  if (window.VideoEncoder && window.VideoDecoder) return null;
  if (!window.isSecureContext) return 'this page is running in a sandboxed viewer (not a secure context), which hides the browser video encoder. Open ReelEdit.html directly in Chrome or Edge (double-click the file, or drag it onto a Chrome window).';
  return 'this browser has no WebCodecs support. Use a current Chrome or Edge.';
}
async function offlineSupported() {
  if (!(window.VideoEncoder && window.VideoDecoder && window.VideoFrame)) return false;
  return !!(await pickH264(P.settings.w, P.settings.h, P.settings.fps, 12e6));
}

/* ---------- audio ---------- */
async function mixAudio(start, end, sr) {
  const len = Math.ceil((end - start) * sr); if (len <= 0) return null;
  const ctx = new OfflineAudioContext(2, len, sr), cache = new Map(); let any = false;
  for (const c of P.clips) {
    if (!c.media || !(c.kind === 'audio' || c.kind === 'video') || cend(c) <= start || c.start >= end) continue;
    const m = media.get(c.media); if (!m || m.offline || m.hasAudio === false) continue;
    const tr = trackOf(c); if (!tr || tr.muted || c.muted) continue;
    if (!cache.has(m.id)) {
      let buf = null;
      try { const ab = await (m.sndUrl ? (await fetch(m.sndUrl)).arrayBuffer() : m.file.arrayBuffer()); buf = await ctx.decodeAudioData(ab); } catch (e) { buf = null; }
      cache.set(m.id, buf);
    }
    const buf = cache.get(m.id); if (!buf) continue;
    const s = Math.max(c.start, start), e = Math.min(cend(c), end);
    const src = ctx.createBufferSource(), gn = ctx.createGain();
    src.buffer = buf; src.playbackRate.value = c.speed; src.connect(gn); gn.connect(ctx.destination);
    gn.gain.setValueAtTime(clipGain(c, s), s - start);
    for (let t = s + 0.01; t < e; t += 0.01) gn.gain.linearRampToValueAtTime(clipGain(c, t), t - start);
    gn.gain.linearRampToValueAtTime(clipGain(c, e - 1e-4), e - start);
    src.start(s - start, c.in + (s - c.start) * c.speed, (e - s) * c.speed);
    any = true;
  }
  if (!any) return null;
  return ctx.startRendering();
}
async function encodeAudio(buf, cfg, onProg) {
  const out = []; let desc = null, err = null;
  const enc = new AudioEncoder({ output: (ch, meta) => { if (meta && meta.decoderConfig && meta.decoderConfig.description) desc = new Uint8Array(meta.decoderConfig.description); const d = new Uint8Array(ch.byteLength); ch.copyTo(d); out.push({ data: d, ts: ch.timestamp, dur: ch.duration }); }, error: e => { err = e; } });
  enc.configure(cfg);
  const sr = buf.sampleRate, n = buf.length, L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L, step = 4096;
  for (let s = 0; s < n; s += step) {
    if (err) throw err; if (EXP && EXP.cancelled) throw new Error('cancelled');
    const e = Math.min(n, s + step), len = e - s, data = new Float32Array(len * 2);
    data.set(L.subarray(s, e), 0); data.set(R.subarray(s, e), len);
    const ad = new AudioData({ format: 'f32-planar', sampleRate: sr, numberOfFrames: len, numberOfChannels: 2, timestamp: Math.round(s / sr * 1e6), data });
    while (enc.encodeQueueSize > 8) await codecWait(enc);
    enc.encode(ad); ad.close();
    if (onProg && (s / step) % 50 === 0) onProg(s / n);
  }
  await enc.flush(); enc.close(); if (err) throw err;
  return { chunks: out, desc, sr, codec: cfg.codec, bitrate: cfg.bitrate };
}
/* encoders add priming samples at the start; find how many by decoding back and correlating
   against the mix, then tell players to skip them (edit list) so sound lands on the frame */
async function measureAudioDelay(a, mix) {
  const x = mix.getChannelData(0), sr = mix.sampleRate, W = 8192, MAXL = 4096;
  let i0 = -1; for (let i = 0; i < Math.min(x.length - W - MAXL, sr * 30); i++) if (Math.abs(x[i]) > 0.02) { i0 = i; break; }
  if (i0 < 0 || !a.desc && a.codec !== 'opus') return null;
  const need = i0 + W + MAXL, parts = []; let have = 0, err = null;
  const dec = new AudioDecoder({ output: ad => { const t = new Float32Array(ad.numberOfFrames); ad.copyTo(t, { planeIndex: 0, format: 'f32-planar' }); parts.push(t); have += t.length; ad.close(); }, error: e => { err = e; } });
  const cfg = { codec: a.codec, sampleRate: a.sr, numberOfChannels: 2 }; if (a.desc) cfg.description = a.desc;
  try { dec.configure(cfg); } catch (e) { return null; }
  for (const ch of a.chunks) { if (err) break; dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: ch.ts, data: ch.data })); if (dec.decodeQueueSize > 8) await codecWait(dec); if (have >= need) break; }
  try { await dec.flush(); dec.close(); } catch (e) { }
  if (err || have < need) return null;
  const y = new Float32Array(have); let o = 0; for (const p of parts) { y.set(p, o); o += p.length; }
  let best = 0, bl = 0;
  for (let L = 0; L <= MAXL; L++) { let s = 0; for (let k = 0; k < W; k++) s += x[i0 + k] * y[i0 + k + L]; if (s > best) { best = s; bl = L; } }
  return bl;
}

/* ---------- MP4 muxer (H.264 + AAC/Opus, moov first) ---------- */
const mu8 = (...a) => Uint8Array.from(a);
const mu16 = v => mu8(v >> 8 & 255, v & 255);
const mu32 = v => mu8(v >>> 24 & 255, v >>> 16 & 255, v >>> 8 & 255, v & 255);
const mu64 = v => catU8([mu32(Math.floor(v / 4294967296)), mu32(v >>> 0)]);
const m4 = s => Uint8Array.from([...s].map(ch => ch.charCodeAt(0)));
const mbox = (type, ...parts) => { const body = catU8(parts); return catU8([mu32(body.length + 8), m4(type), body]); };
const mfull = (type, v, flags, ...parts) => mbox(type, mu8(v, flags >> 16 & 255, flags >> 8 & 255, flags & 255), ...parts);
const MATRIX = catU8([0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000].map(mu32));
function tbl(arr, bytes, signed) { const b = new Uint8Array(arr.length * bytes), dv = new DataView(b.buffer); arr.forEach((v, i) => { if (bytes === 8) { dv.setUint32(i * 8, Math.floor(v / 4294967296)); dv.setUint32(i * 8 + 4, v >>> 0); } else if (signed) dv.setInt32(i * 4, v); else dv.setUint32(i * 4, v); }); return b; }
function runs(vals) { const r = []; for (const v of vals) { const l = r[r.length - 1]; if (l && l[1] === v) l[0]++; else r.push([1, v]); } return r; }
function esdsBox(asc, br) {
  const dsi = catU8([mu8(0x05, asc.length), asc]);
  const dcd = catU8([mu8(0x04, 13 + dsi.length, 0x40, 0x15, 0, 0, 0), mu32(br), mu32(br), dsi]);
  const sl = mu8(0x06, 1, 0x02);
  return mfull('esds', 0, 0, mu8(0x03, 3 + dcd.length + sl.length), mu16(1), mu8(0), dcd, sl);
}
function stblBox(entry, durs, sizes, offsets, keys, ctts) {
  const parts = [mfull('stsd', 0, 0, mu32(1), entry)];
  const r = runs(durs); parts.push(mfull('stts', 0, 0, mu32(r.length), tbl(r.flat(), 4)));
  if (ctts) { const c = runs(ctts); parts.push(mfull('ctts', 1, 0, mu32(c.length), tbl(c.flat(), 4, true))); }
  if (keys) parts.push(mfull('stss', 0, 0, mu32(keys.length), tbl(keys, 4)));
  parts.push(mfull('stsc', 0, 0, mu32(1), mu32(1), mu32(1), mu32(1)));
  parts.push(mfull('stsz', 0, 0, mu32(0), mu32(sizes.length), tbl(sizes, 4)));
  parts.push(mfull('co64', 0, 0, mu32(offsets.length), tbl(offsets, 8)));
  return mbox('stbl', ...parts);
}
function trakBox(id, isV, ts, mediaDur, durMs, w, h, entry, durs, sizes, offsets, keys, ctts, delay) {
  const tkhd = mfull('tkhd', 0, 3, mu32(0), mu32(0), mu32(id), mu32(0), mu32(durMs), mu32(0), mu32(0), mu16(0), mu16(isV ? 0 : 1), mu16(isV ? 0 : 0x100), mu16(0), MATRIX, mu32(w * 65536), mu32(h * 65536));
  const edts = delay ? mbox('edts', mfull('elst', 0, 0, mu32(1), mu32(durMs), mu32(delay), mu32(0x10000))) : new Uint8Array(0);
  const mdhd = mfull('mdhd', 0, 0, mu32(0), mu32(0), mu32(ts), mu32(mediaDur), mu16(0x55c4), mu16(0));
  const hdlr = mfull('hdlr', 0, 0, mu32(0), m4(isV ? 'vide' : 'soun'), mu32(0), mu32(0), mu32(0), m4(isV ? 'VideoHandler' : 'SoundHandler'), mu8(0));
  const xmhd = isV ? mfull('vmhd', 0, 1, mu16(0), mu16(0), mu16(0), mu16(0)) : mfull('smhd', 0, 0, mu16(0), mu16(0));
  const dinf = mbox('dinf', mfull('dref', 0, 0, mu32(1), mfull('url ', 0, 1)));
  return mbox('trak', tkhd, edts, mbox('mdia', mdhd, hdlr, mbox('minf', xmhd, dinf, stblBox(entry, durs, sizes, offsets, keys, ctts))));
}
function muxMP4(v, a) {
  // v: {w,h,fps,avcC,samples:[{data,key,ts}]}  a: {sr,codec,desc,bitrate,chunks:[{data,dur}],delay,preSkip} | null
  const vts = v.fps * 1000, fd = 1000;
  const pts = v.samples.map(s => Math.round(s.ts * vts / 1e6));
  const sorted = [...pts].sort((x, y) => x - y), mono = pts.every((p, i) => p === sorted[i]);
  const dts = mono ? pts : sorted, ctts = mono ? null : pts.map((p, i) => p - dts[i]);
  const vdurs = dts.map((d, i) => i + 1 < dts.length ? dts[i + 1] - d : fd);
  const vDurTicks = dts.length ? dts[dts.length - 1] + fd - dts[0] : 0, durMs = Math.round(vDurTicks / vts * 1000);
  const vsizes = v.samples.map(s => s.data.length), vkeys = []; v.samples.forEach((s, i) => { if (s.key) vkeys.push(i + 1); });
  const avc1 = mbox('avc1', mu8(0, 0, 0, 0, 0, 0), mu16(1), mu16(0), mu16(0), mu32(0), mu32(0), mu32(0), mu16(v.w), mu16(v.h), mu32(0x480000), mu32(0x480000), mu32(0), mu16(1), new Uint8Array(32), mu16(0x18), mu16(0xffff), mbox('avcC', v.avcC));
  let aentry = null, adurs = null, asizes = null, aDur = 0;
  if (a) {
    const isOpus = a.codec === 'opus';
    const tail = isOpus ? mbox('dOps', mu8(0, 2), mu16(a.preSkip || 312), mu32(a.sr), mu16(0), mu8(0)) : esdsBox(a.desc, a.bitrate);
    aentry = mbox(isOpus ? 'Opus' : 'mp4a', mu8(0, 0, 0, 0, 0, 0), mu16(1), mu32(0), mu32(0), mu16(2), mu16(16), mu16(0), mu16(0), mu32(a.sr * 65536), tail);
    const dflt = isOpus ? 960 : 1024;
    adurs = a.chunks.map(c => c.dur ? Math.round(c.dur * a.sr / 1e6) || dflt : dflt); asizes = a.chunks.map(c => c.data.length);
    aDur = adurs.reduce((s, x) => s + x, 0);
  }
  const ftyp = mbox('ftyp', m4('isom'), mu32(0x200), m4('isom'), m4('iso2'), m4('avc1'), m4('mp41'));
  const build = (vo, ao) => mbox('moov',
    mfull('mvhd', 0, 0, mu32(0), mu32(0), mu32(1000), mu32(durMs), mu32(0x10000), mu16(0x100), new Uint8Array(10), MATRIX, new Uint8Array(24), mu32(a ? 3 : 2)),
    trakBox(1, true, vts, vDurTicks, durMs, v.w, v.h, avc1, vdurs, vsizes, vo, vkeys, ctts, 0),
    a ? trakBox(2, false, a.sr, aDur, Math.min(durMs, Math.round(aDur / a.sr * 1000)), 0, 0, aentry, adurs, asizes, ao, null, null, a.codec === 'opus' ? 0 : (a.delay || 0)) : new Uint8Array(0));
  const zeros = n => new Array(n).fill(0);
  const moovLen = build(zeros(vsizes.length), a ? zeros(asizes.length) : []).length;
  let off = ftyp.length + moovLen + 16; const vo = [], ao = [];
  for (const s of vsizes) { vo.push(off); off += s; }
  if (a) for (const s of asizes) { ao.push(off); off += s; }
  const moov = build(vo, ao), mdatLen = off - ftyp.length - moovLen;
  const mdatHdr = catU8([mu32(1), m4('mdat'), mu64(mdatLen)]);
  return new Blob([ftyp, moov, mdatHdr, ...v.samples.map(s => s.data), ...(a ? a.chunks.map(c => c.data) : [])], { type: 'video/mp4' });
}

/* ---------- pixels → encoder ---------- */
// Chrome's encoder shifts hue slightly when it converts CPU-side RGB frames itself (blue −6 levels on test
// footage), so composited frames are converted to NV12 here: BT.709 limited range, 2×2-averaged chroma
const BT709 = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false };
function toNV12(px, W, H, out) {
  for (let i = 0, n = W * H; i < n; i++) { const k = i << 2; out[i] = (47 * px[k] + 157 * px[k + 1] + 16 * px[k + 2] + 4224) >> 8; }
  let o = W * H;
  for (let y = 0; y < H; y += 2) {
    const r0 = y * W << 2, r1 = r0 + (W << 2);
    for (let x = 0; x < W; x += 2) {
      const a = r0 + (x << 2), b = r1 + (x << 2);
      const R = px[a] + px[a + 4] + px[b] + px[b + 4], G = px[a + 1] + px[a + 5] + px[b + 1] + px[b + 5], B = px[a + 2] + px[a + 6] + px[b + 2] + px[b + 6];
      out[o++] = (-26 * R - 87 * G + 113 * B + 131584) >> 10;
      out[o++] = (112 * R - 102 * G - 10 * B + 131584) >> 10;
    }
  }
  return out;
}
// ~21 ms a 1080p frame in JS, so it runs on a few workers while the main thread composites the next frames
function makeNV12Pool(W, H, k = 3) {
  const url = URL.createObjectURL(new Blob([`${toNV12}\nonmessage = e => { const out = new Uint8Array(${W * H * 3 / 2}); toNV12(new Uint8Array(e.data.buf), ${W}, ${H}, out); postMessage({ id: e.data.id, out }, [out.buffer]); };`], { type: 'text/javascript' }));
  const wait = new Map(); let seq = 0;
  const fail = e => { for (const p of wait.values()) p.rej(new Error('pixel converter failed: ' + (e.message || e))); wait.clear(); };
  const ws = Array.from({ length: k }, () => { const w = new Worker(url); w.onmessage = e => { const p = wait.get(e.data.id); wait.delete(e.data.id); if (p) p.res(e.data.out); }; w.onerror = fail; return w; });
  return {
    run(px) { const id = seq++; return new Promise((res, rej) => { wait.set(id, { res, rej }); ws[id % k].postMessage({ id, buf: px.buffer }, [px.buffer]); }); },
    close() { ws.forEach(w => w.terminate()); URL.revokeObjectURL(url); fail('closed'); },
  };
}

/* ---------- the export ---------- */
// the frame is exactly one untouched, full-frame video clip → its decoded picture can go straight to the encoder
function soloClip(t) {
  let solo = null;
  for (const tr of P.tracks) {
    if (tr.type !== 'video' || tr.hidden) continue;
    for (const c of clipsOn(tr.id)) {
      if (!(t >= c.start - EPS && t < cend(c) - EPS)) continue;
      if (solo) return null; solo = c;
    }
  }
  if (!solo || solo.kind !== 'video' || clipAlpha(solo, t) < 1 || filterStr(solo, 1, 0)) return null;
  if ((solo.scale || 1) !== 1 || solo.x || solo.y || solo.rot || solo.kb) return null;
  const m = media.get(solo.media);
  return m && Math.abs(m.w / m.h - P.settings.w / P.settings.h) < 0.002 ? solo : null;
}
async function exportOffline(o, ui) {
  const end0 = tlEnd(), start = o.range === 'io' ? (P.inPt ?? 0) : 0, end = o.range === 'io' ? (P.outPt ?? end0) : end0;
  const fpsO = P.settings.fps, N = Math.max(1, Math.round((end - start) * fpsO));
  const OW = even(P.settings.w * o.scale), OH = even(P.settings.h * o.scale), S = OW / P.settings.w;
  const vcfg = await pickH264(OW, OH, fpsO, o.vbps); if (!vcfg) throw new Error('no H.264 encoder available');
  const SR = 48000, acfg = await pickAudio(SR);
  const cv = document.createElement('canvas'); cv.width = OW; cv.height = OH;
  const g = cv.getContext('2d', { alpha: false });
  const vs = []; let avcC = null, vErr = null;
  const venc = new VideoEncoder({ output: (ch, meta) => { if (meta && meta.decoderConfig && meta.decoderConfig.description) avcC = new Uint8Array(meta.decoderConfig.description); const d = new Uint8Array(ch.byteLength); ch.copyTo(d); vs.push({ data: d, key: ch.type === 'key', ts: ch.timestamp }); }, error: e => { vErr = e; } });
  venc.configure(vcfg);
  const readers = new Map(), srcMap = new Map(), t0 = performance.now(); let fastFrames = 0;
  let conv = null; try { conv = makeNV12Pool(OW, OH); } catch (e) { conv = null; }
  const pend = []; // frames in flight (pixel conversion runs in workers), encoded strictly in order
  const drain = async max => { while (pend.length > max) { const it = pend.shift(); const f = await it.vf; venc.encode(f, { keyFrame: it.key }); f.close(); } };
  EXPSRC = srcMap;
  try {
    for (let n = 0; n < N; n++) {
      if (EXP.cancelled) throw new Error('cancelled'); if (vErr) throw vErr;
      const t = start + n / fpsO;
      srcMap.clear();
      for (const tr of P.tracks) {
        if (tr.type !== 'video' || tr.hidden) continue;
        for (const c of clipsOn(tr.id)) {
          if (c.kind !== 'video' || !c.media || !(t >= c.start - EPS && t < cend(c) - EPS)) continue;
          const m = media.get(c.media); if (!m || m.offline) continue;
          const st = Math.min(c.in + (t - c.start) * c.speed, c.out - 1e-3);
          let r = readers.get(c.id); if (!r) { r = makeReader(m, st, c, OW, OH); readers.set(c.id, r); }
          let fr = await r.frameAt(st);
          if (fr && r.scale) fr = r.scale(fr);
          if (fr) srcMap.set(c.id, fr);
        }
      }
      for (const [id, r] of readers) { const c = clipById(id); if (!c || t >= cend(c) - EPS) { r.close(); readers.delete(id); } }
      while (venc.encodeQueueSize > 4) await codecWait(venc);
      const ts = { timestamp: Math.round(n * 1e6 / fpsO), duration: Math.round(1e6 / fpsO) };
      const solo = soloClip(t), sf = solo && srcMap.get(solo.id);
      let vf;
      if (sf && (sf.width ?? sf.displayWidth) === OW && (sf.height ?? sf.displayHeight) === OH) {
        // fast path: the GPU-scaled (or native-size) decoded frame goes straight in, no compositing — ~85 vs ~35 fps at 4K→1080p
        vf = new VideoFrame(sf, ts); fastFrames++;
      } else {
        g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.filter = 'none'; g.fillStyle = P.settings.bg; g.fillRect(0, 0, OW, OH);
        renderTimelineFrame(g, t, S);
        // hand the encoder plain pixels: frames built straight from a 2D GPU canvas hit a slow ~10 fps
        // path in Chrome's encoders; reading back first measured ~5× faster (48 vs 10 fps at 1080p)
        const px = g.getImageData(0, 0, OW, OH).data;
        vf = conv ? conv.run(px).then(b => new VideoFrame(b, { format: 'NV12', codedWidth: OW, codedHeight: OH, colorSpace: BT709, ...ts }))
          : new VideoFrame(px, { format: 'RGBX', codedWidth: OW, codedHeight: OH, ...ts });
      }
      pend.push({ vf, key: n % (fpsO * 2) === 0 });
      await drain(2);
      if (n % 3 === 0 || n === N - 1) { const el = (performance.now() - t0) / 1000, rate = (n + 1) / el; ui.prog((n + 1) / N * 0.9, `Video frame ${n + 1} / ${N} · ${rate.toFixed(0)} fps · ${(rate / fpsO).toFixed(1)}× real time · ~${Math.ceil((N - n - 1) / rate)} s left`); }
    }
    await drain(0); await venc.flush(); venc.close();
  } finally {
    EXPSRC = null; for (const r of readers.values()) r.close(); try { if (venc.state !== 'closed') venc.close(); } catch (e) { }
    for (const it of pend) Promise.resolve(it.vf).then(f => f.close(), () => { }); if (conv) conv.close();
  }
  if (vErr) throw vErr; if (!avcC) throw new Error('encoder gave no H.264 config');
  let audio = null;
  if (acfg) {
    ui.prog(0.91, 'Mixing audio…');
    const mix = await mixAudio(start, end, SR);
    if (EXP.cancelled) throw new Error('cancelled');
    if (mix) {
      audio = await encodeAudio(mix, acfg, p => ui.prog(0.92 + p * 0.05, 'Encoding audio…'));
      if (audio.codec === 'opus') audio.preSkip = audio.desc && audio.desc.length >= 12 ? audio.desc[10] | (audio.desc[11] << 8) : 312;
      else { ui.prog(0.97, 'Aligning audio…'); const d = await measureAudioDelay(audio, mix); audio.delay = d == null ? 0 : d; }
    }
  }
  ui.prog(0.99, 'Writing MP4…');
  const blob = muxMP4({ w: OW, h: OH, fps: fpsO, avcC, samples: vs }, audio);
  return { blob, frames: vs.length, fastFrames, secs: (performance.now() - t0) / 1000, audio: audio && audio.codec, delay: audio && (audio.delay || audio.preSkip) };
}
