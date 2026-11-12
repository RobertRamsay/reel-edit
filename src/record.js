/* ============================================================
   recording: talk, sing or beatbox along with the timeline or the audio editor.
   The backing plays sample-exactly from an AudioBuffer in the app's AudioContext and the mic is
   captured in that same context (an AudioWorklet tags every block with its frame number), so a take
   lines up with what you heard. The speaker + mic round trip is taken off automatically, plus a
   manual sync offset for setups that report it wrongly.
   ============================================================ */
let REC = null;
const RPREF = { dev: '', monitor: false, offsetMs: 0 };
try { Object.assign(RPREF, JSON.parse(localStorage.getItem('reeledit.rec') || '{}')); } catch (e) { }
const saveRecPrefs = () => { try { localStorage.setItem('reeledit.rec', JSON.stringify(RPREF)); } catch (e) { } };

// mono capture in blocks of ≥4096 frames; a block is only ever contiguous frames, so a dropout becomes silence, not a shift
const REC_WORKLET = `class ReelRec extends AudioWorkletProcessor {
  constructor() { super(); this.on = true; this.buf = []; this.n = 0; this.t0 = -1;
    this.port.onmessage = e => { if (e.data === 'stop') { this.flush(); this.on = false; this.port.postMessage({ done: true }); } }; }
  flush() { if (!this.n) return; const o = new Float32Array(this.n); let k = 0; for (const b of this.buf) { o.set(b, k); k += b.length; }
    this.port.postMessage({ t: this.t0, d: o }, [o.buffer]); this.buf = []; this.n = 0; this.t0 = -1; }
  process(ins) {
    const i = ins[0];
    if (!this.on || !i || !i[0]) return this.on;
    if (this.t0 >= 0 && currentFrame !== this.t0 + this.n) this.flush();
    if (this.t0 < 0) this.t0 = currentFrame;
    let m;
    if (i.length > 1) { m = new Float32Array(i[0].length); for (const c of i) for (let j = 0; j < m.length; j++) m[j] += c[j] / i.length; } else m = i[0].slice();
    this.buf.push(m); this.n += m.length; if (this.n >= 4096) this.flush();
    return true;
  }
}
registerProcessor('reel-rec', ReelRec);`;

async function recGetMic() {
  const base = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 }; // keep beatbox transients intact
  try { return await navigator.mediaDevices.getUserMedia({ audio: RPREF.dev ? { ...base, deviceId: { exact: RPREF.dev } } : base }); }
  catch (e) { if (!RPREF.dev) throw e; RPREF.dev = ''; saveRecPrefs(); return navigator.mediaDevices.getUserMedia({ audio: base }); }
}
const recSleep = ms => new Promise(r => setTimeout(r, ms));

// backing: an AudioBuffer played from its start (or null to record over silence); onStop(take Float32Array | null, sampleRate)
async function recStart({ backing, maxSecs, label, onStop }) {
  if (REC) return null;
  ensureAudio(); if (!actx) { toast('No audio output available', true); return null; }
  try { await actx.resume(); } catch (e) { }
  if (!navigator.mediaDevices || !window.AudioWorkletNode) { toast('Recording needs a current Chrome or Edge', true); return null; }
  let stream;
  try { stream = await recGetMic(); }
  catch (e) {
    toast(e.name === 'NotAllowedError' ? 'Microphone blocked — allow it for Reel Edit (Windows: Settings → Privacy → Microphone)' : e.name === 'NotFoundError' ? 'No microphone found' : "Couldn't open the microphone: " + e.message, true);
    return null;
  }
  try { if (!recStart.ready) { const u = URL.createObjectURL(new Blob([REC_WORKLET], { type: 'text/javascript' })); await actx.audioWorklet.addModule(u); URL.revokeObjectURL(u); recStart.ready = true; } }
  catch (e) { stream.getTracks().forEach(t => t.stop()); toast("Couldn't start the recorder: " + e.message, true); return null; }
  const sr = actx.sampleRate, src = actx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(actx, 'reel-rec', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  const sink = actx.createGain(); sink.gain.value = 0; src.connect(node); node.connect(sink); sink.connect(actx.destination); // keeps the worklet pulled
  const mon = actx.createGain(); mon.gain.value = RPREF.monitor ? 1 : 0; src.connect(mon); mon.connect(actx.destination);
  const an = actx.createAnalyser(); an.fftSize = 1024; src.connect(an);
  const when = actx.currentTime + 0.25;
  let bsrc = null;
  if (backing) { bsrc = actx.createBufferSource(); bsrc.buffer = backing; bsrc.connect(actx.destination); bsrc.start(when); }
  const trk = stream.getAudioTracks()[0], inLat = (trk.getSettings && trk.getSettings().latency) || 0;
  const R = REC = { stream, src, node, sink, mon, an, chunks: [], when, sr, bsrc, lat: (actx.outputLatency || actx.baseLatency || 0) + inLat, label, onStop, stopping: false, dev: trk.label };
  R.done = new Promise(r => { node.port.onmessage = e => { if (e.data.d) R.chunks.push(e.data); else if (e.data.done) r(); }; });
  if (maxSecs) R.timer = setTimeout(() => recStop(), (when - actx.currentTime + maxSecs) * 1000 + 50);
  recHud(R);
  return R;
}
async function recStop(cancel) {
  const R = REC; if (!R || R.stopping) return; R.stopping = true;
  clearTimeout(R.timer);
  const tEnd = Math.max(R.when, actx.currentTime), L = R.lat + RPREF.offsetMs / 1000;
  if (R.bsrc) try { R.bsrc.stop(); } catch (e) { }
  if (!cancel && L > 0) await recSleep(L * 1000 + 30); // the last sounds you made are still on their way in
  R.node.port.postMessage('stop'); await Promise.race([R.done, recSleep(600)]);
  for (const n of [R.src, R.node, R.sink, R.mon, R.an]) try { n.disconnect(); } catch (e) { }
  R.stream.getTracks().forEach(t => t.stop());
  $('#recHud') && $('#recHud').remove(); REC = null;
  if (cancel) { toast('Recording cancelled'); return R.onStop(null, R.sr); }
  // sample j of the take = what came in L seconds after backing sample j was sent out
  const len = Math.max(0, Math.round((tEnd - R.when) * R.sr)), out = new Float32Array(len), w0 = Math.round(R.when * R.sr) + Math.round(L * R.sr);
  for (const c of R.chunks) {
    const a = c.t - w0, s = Math.max(0, -a), e = Math.min(c.d.length, len - a);
    if (e > s) out.set(c.d.subarray(s, e), a + s);
  }
  if (len < R.sr * 0.05) toast('Stopped before the recording started — nothing kept', true);
  R.onStop(len >= R.sr * 0.05 ? out : null, R.sr);
}
function recHud(R) {
  const t = h('b', { class: 'rect' }, '0:00.0'), lv = h('i', { class: 'reclv' });
  const hud = h('div', { id: 'recHud' }, h('span', { class: 'recdot' }), h('span', {}, 'REC · ' + R.label), t, h('span', { class: 'recmeter' }, lv),
    h('button', { class: 'primary', onclick: () => recStop() }, '■ Stop (Space)'), h('button', { onclick: () => recStop(true) }, 'Cancel (Esc)'));
  document.body.append(hud);
  const buf = new Float32Array(R.an.fftSize); let pk = 0;
  const tick = () => {
    if (REC !== R) return;
    const s = actx.currentTime - R.when; t.textContent = s < 0 ? 'get ready…' : aeTime(s).replace(/\d$/, '');
    R.an.getFloatTimeDomainData(buf); let p = 0; for (const v of buf) { const a = v < 0 ? -v : v; if (a > p) p = a; } pk = Math.max(p, pk * 0.9);
    const k = clamp((20 * Math.log10(pk + 1e-9) + 60) / 60, 0, 1); lv.style.width = (k * 100).toFixed(1) + '%'; lv.classList.toggle('hot', pk > 0.95);
    requestAnimationFrame(tick);
  };
  tick();
}
// Space stops (and keeps the take), Esc cancels — before the editor's or timeline's own keys
addEventListener('keydown', e => {
  if (!REC) return;
  if (e.key === ' ' || e.key === 'Escape') { e.preventDefault(); recStop(e.key === 'Escape'); }
  e.stopImmediatePropagation();
}, true);
// the take into another sample rate (the editor may run at the file's rate)
async function recResample(a, from, to) {
  if (from === to) return a;
  const n = Math.max(1, Math.round(a.length * to / from)), ctx = new OfflineAudioContext(1, n, to), b = ctx.createBuffer(1, a.length, from);
  b.copyToChannel(a, 0); const s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination); s.start();
  return new Float32Array((await ctx.startRendering()).getChannelData(0));
}
function recName(base) { const names = new Set([...media.values()].map(x => x.name)); for (let i = 1; ; i++) { const nm = `${base} ${i}.wav`; if (!names.has(nm)) return nm; } }

/* ---------- timeline: record over the edit from the playhead ---------- */
async function recTimeline() {
  if (REC) return recStop();
  if (EXP || AE) return;
  if (UI.playing) pause(); if (UI.mode !== 'timeline') setMode('timeline');
  ensureAudio();
  const start = q(UI.t), end = tlEnd(), sr = actx ? actx.sampleRate : 48000;
  let backing = null;
  if (end > start + 0.05) { toast('Preparing the backing track…'); try { backing = await mixAudio(start, end, sr); } catch (e) { backing = null; } }
  monitor.gain.value = 0; // you hear the exact backing mix, not the preview players
  const R = await recStart({ backing, maxSecs: backing ? backing.duration : 600, label: 'timeline', onStop: async take => {
    if (UI.playing) pause(); monitor.gain.value = 1; setTime(start);
    if (take) await placeTake(take, sr, start);
  } });
  if (!R) { monitor.gain.value = 1; return; }
  // the picture follows along (it's only a guide — the take is timed against the audio clock)
  if (end > start + 0.05) setTimeout(() => { if (REC === R) { setTime(start); play(1); } }, Math.max(0, (R.when - actx.currentTime) * 1000));
}
async function placeTake(take, sr, start) {
  const [a] = await importFiles([new File([wavBlob([take], sr)], recName('Voice'), { type: 'audio/wav' })], { quiet: true });
  if (!a) return;
  const end = start + a.duration, free = tr => !clipsOn(tr.id).some(c => c.start < end - EPS && cend(c) > start + EPS);
  let tid;
  edit(() => {
    ensureTargets();
    const t0 = trackById(UI.targetA);
    tid = (t0 && free(t0) ? t0 : P.tracks.find(t => t.type === 'audio' && free(t)) || addTrack('audio')).id;
    const c = makeClip(a, tid, start); P.clips.push(c); UI.sel = new Set([c.id]); UI.selXf = null;
  });
  renderHeads(); renderBin();
  toast(`Take “${a.name}” (${fmtS(a.duration)}) placed on ${trackById(tid).name} at ${fmtTC(start)}`);
}

/* ---------- audio editor: record along with the file, then mix in or replace ---------- */
async function aeRecord() {
  if (REC) return recStop();
  if (!AE || AE.busy) return;
  aeStop();
  const a = AE.sel ? AE.sel[0] : AE.cur >= AE.n - 10 ? 0 : AE.cur;
  ensureAudio(); if (!actx) return;
  const backing = actx.createBuffer(AE.ch.length, Math.max(1, AE.n - a), AE.sr);
  AE.ch.forEach((x, i) => backing.copyToChannel(x.subarray(a), i));
  AE.busy = true; $('#aeRec').classList.add('recon'); $('#aeRec').textContent = '■ Stop';
  const R = await recStart({ backing, maxSecs: (AE.n - a) / AE.sr, label: AE.m.name, onStop: async (take, sr) => {
    if (!AE) return;
    AE.busy = false; AE.play = null; $('#aeRec').classList.remove('recon'); $('#aeRec').textContent = '● Record';
    if (take) aeTakePanel(await recResample(take, sr, AE.sr), a); else aeDraw();
  } });
  if (!R) { AE.busy = false; $('#aeRec').classList.remove('recon'); $('#aeRec').textContent = '● Record'; return; }
  AE.play = { src: R.bsrc, a, b: AE.n, t: R.when, loop: false }; // the playhead runs with the backing
  const tick = () => { if (!AE || REC !== R) return; aeDrawNow(); requestAnimationFrame(tick); }; tick();
}
function aeTakePanel(take, a) {
  const len = Math.min(take.length, AE.n - a); take = take.subarray(0, len);
  let pk = 0; for (const v of take) { const x = v < 0 ? -v : v; if (x > pk) pk = x; }
  const db = h('input', { type: 'range', min: -18, max: 12, step: 0.5, value: 0 }), dbv = h('span', { class: 'val' }, '0 dB');
  db.oninput = () => { dbv.textContent = (+db.value > 0 ? '+' : '') + db.value + ' dB'; };
  const keep = h('input', { type: 'checkbox', checked: true });
  const close = () => { panel.remove(); AE.busy = false; aeDraw(); };
  const keepTake = async () => { if (keep.checked) await importFiles([new File([wavBlob([take.slice()], AE.sr)], recName(AE.m.name.replace(/\.[^.]+$/, '') + ' take'), { type: 'audio/wav' })], { quiet: true }); };
  const apply = async mix => {
    const g = Math.pow(10, db.value / 20);
    const ch = AE.ch.map(x => { const o = x.slice(); for (let j = 0; j < len; j++) o[a + j] = mix ? o[a + j] + take[j] * g : take[j] * g; return o; });
    close(); aeCommit(ch, [a, a + len], a); await keepTake();
    let p = 0; for (const x of ch) for (let j = a; j < a + len; j++) { const v = x[j] < 0 ? -x[j] : x[j]; if (v > p) p = v; }
    toast((mix ? 'Take mixed in' : 'Take replaced that part') + (keep.checked ? ' — the take is also in the media bin' : '') + (p > 1 ? '. Some peaks are over 0 dB — Normalise fixes that' : ''), p > 1);
  };
  AE.busy = true;
  AE.sel = [a, a + len]; aeDraw();
  const panel = h('div', { class: 'aetake' },
    h('b', {}, `Take ready · ${aeTime(len / AE.sr)}`), h('span', { class: 'note' }, `peak ${pk > 0 ? (20 * Math.log10(pk)).toFixed(1) : '−∞'} dB`),
    h('label', {}, 'Level'), db, dbv,
    h('button', { class: 'primary', onclick: () => apply(true), title: 'Layer the take on top of the sound (overdub)' }, 'Mix in'),
    h('button', { onclick: () => apply(false), title: 'Swap that part of the sound for the take (punch-in)' }, 'Replace'),
    h('button', { onclick: async () => { const k = keep.checked; keep.checked = true; await keepTake(); keep.checked = k; close(); toast('Take saved to the media bin'); } }, 'Only save the take'),
    h('button', { onclick: () => { close(); toast('Take discarded'); } }, 'Discard'),
    h('label', { class: 'aechk' }, keep, 'Also keep the take in the bin'));
  $('#aed').insertBefore(panel, $('#aed .aefoot'));
}
