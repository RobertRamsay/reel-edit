/* ============================================================
   audio editor: double-click an audio file in the bin (or "Edit audio…" on a clip or video).
   Edits a decoded copy of the sound — the original file is never touched. The result is saved
   into the project as a new file (optionally swapping the timeline's clips to it) or exported.
   ============================================================ */
let AE = null;
const AE_SR = 48000, AE_BLK = 256, AE_UNDO_FLOATS = 120e6; // undo keeps up to ~480 MB of old sound
const aeTime = s => { s = Math.max(0, s); const m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(3).padStart(6, '0')}`; };

async function openAudioEditor(m, srcSel) {
  if (AE) return;
  if (m.offline) return toast(m.name + ' is offline — relink it first', true);
  if (m.hasAudio === false || !(m.type === 'audio' || m.type === 'video')) return toast(m.name + ' has no sound to edit', true);
  if (UI.playing) pause();
  toast('Opening ' + m.name + ' in the audio editor…');
  let buf;
  try { buf = await new OfflineAudioContext(1, 1, AE_SR).decodeAudioData(await (m.sndUrl ? (await fetch(m.sndUrl)).arrayBuffer() : m.file.arrayBuffer())); }
  catch (e) { return toast("Couldn't read the sound in " + m.name, true); }
  const ch = Array.from({ length: Math.min(2, buf.numberOfChannels) }, (_, i) => new Float32Array(buf.getChannelData(i)));
  AE = { m, sr: buf.sampleRate, ch, n: ch[0].length, undo: [], redo: [], clip: null, dirty: false, cur: 0, sel: null, t0: 0, spp: 1, play: null, loop: false, busy: false, drawQ: false };
  if (srcSel) AE.sel = [clamp(Math.round(srcSel[0] * AE.sr), 0, AE.n), clamp(Math.round(srcSel[1] * AE.sr), 0, AE.n)];
  aeBuildUI(); aeMip(); aeFit();
  if (AE.sel) { AE.cur = AE.sel[0]; }
  addEventListener('keydown', aeKey, true);
  aeDraw();
}

/* ---------- layout ---------- */
function aeBuildUI() {
  const b = (label, act, title, cls) => h('button', { class: cls || null, title, onclick: () => { if (!AE.busy) act(); } }, label);
  const grp = (name, ...kids) => h('div', { class: 'aegrp' }, h('span', { class: 'aelab' }, name), ...kids);
  const fx = (name, chipsList) => h('div', { class: 'aefx' }, h('span', { class: 'aelab' }, name), ...chipsList.map(([l, act, t]) => b(l, act, t)));
  const root = h('div', { id: 'aed' },
    h('div', { class: 'aehead' },
      h('div', { class: 'aetitle' }, h('b', {}, 'Audio editor'), h('span', { id: 'aeName' })),
      h('div', { class: 'spacer' }),
      h('span', { id: 'aeBusy', class: 'aebusy', hidden: true }),
      b('Close', aeClose, 'Close the editor (Esc)')),
    h('div', { class: 'aebar' },
      grp('Play', b('▶ Play', aePlayToggle, 'Play the selection, or from the cursor (Space)', 'primary'),
        h('button', { id: 'aeRec', class: 'rec', title: 'Record along: the file plays from the cursor while your mic records — then mix the take in. Use headphones.', onclick: () => aeRecord() }, '● Record'), h('button', { id: 'aeLoop', title: 'Loop the selection while playing', onclick: () => { AE.loop = !AE.loop; $('#aeLoop').classList.toggle('on', AE.loop); if (AE.play) { aeStop(); aePlay(); } } }, '⟲ Loop')),
      grp('View', b('−', () => aeZoom(2), 'Zoom out'), b('+', () => aeZoom(0.5), 'Zoom in (or scroll on the waveform)'), b('Fit', aeFit, 'Show the whole file'), b('Zoom to selection', aeZoomSel, 'Fill the view with the selection')),
      grp('Select', b('All', () => { AE.sel = [0, AE.n]; aeDraw(); }, 'Select everything (Ctrl+A)'), b('None', () => { AE.sel = null; aeDraw(); }, 'Clear the selection — effects then apply to the whole file')),
      grp('Edit', b('Undo', aeUndo, 'Ctrl+Z'), b('Redo', aeRedo, 'Ctrl+Y'), b('Cut', aeCut, 'Ctrl+X'), b('Copy', aeCopy, 'Ctrl+C'), b('Paste', aePaste, 'Ctrl+V — replaces the selection, or inserts at the cursor'),
        b('Delete', aeDelete, 'Delete the selection (Del)'), b('Trim to selection', aeTrim, 'Keep only the selection'), b('Silence', aeSilence, 'Make the selection silent'), b('Insert silence…', aeInsertSilence, 'Add silence at the cursor'), b('Reverse', aeReverse, 'Play the selection (or everything) backwards'))),
    h('div', { class: 'aebar aefxbar' },
      fx('Level', [['Normalise', () => aeNormalise(), 'Loudest peak to −1 dB'], ['−6 dB', () => aeGain(-6)], ['−3 dB', () => aeGain(-3)], ['+3 dB', () => aeGain(3)], ['+6 dB', () => aeGain(6)]]),
      fx('Fade', [['Fade in', () => aeFade(true), 'Over the selection'], ['Fade out', () => aeFade(false), 'Over the selection']]),
      fx('EQ', [['Low cut', () => aeEq({ hp: 100, low: 0, mid: 0, high: 0 }), 'Removes rumble below ~100 Hz'], ...['Voice', 'Warm', 'Bright', 'Music bed'].map(k => [k, () => aeEq(EQ_PRESETS[k])]), ['Phone', () => aeEq({ hp: 300, low: 0, mid: 4, high: -12 }), 'Thin telephone sound']]),
      fx('Dynamics', [['Gentle', () => aeComp(-18, 2.5), 'Compressor: evens out the level a little'], ['Voice', () => aeComp(-24, 4), 'Compressor: steady, present speech'], ['Heavy', () => aeComp(-32, 8), 'Compressor: loud and flat']]),
      fx('Space', [['Echo', () => aeEcho(0.25, 0.35), 'Quarter-second echo'], ['Slap', () => aeEcho(0.11, 0.2), 'Short slapback'], ['Room', () => aeReverb(0.6), 'Small room reverb'], ['Hall', () => aeReverb(2.2), 'Big hall reverb']]),
      fx('Speed', [['0.5×', () => aeSpeed(0.5)], ['0.75×', () => aeSpeed(0.75)], ['1.25×', () => aeSpeed(1.25)], ['1.5×', () => aeSpeed(1.5)], ['2×', () => aeSpeed(2)]]),
      fx('Noise reduction', [['Light', () => aeDenoise('light'), 'Learns the hiss from the quietest parts and removes it'], ['Medium', () => aeDenoise('medium')], ['Strong', () => aeDenoise('strong')]])),
    h('div', { class: 'aewave' }, h('canvas', { id: 'aeCv' })),
    h('canvas', { id: 'aeOv', title: 'Whole file — click or drag to move the view' }),
    h('div', { class: 'aefoot' },
      h('span', { id: 'aeStat', class: 'aestat' }),
      h('div', { class: 'spacer' }),
      h('label', { class: 'aechk', title: 'Clips on the timeline that use the original file switch to the edited copy' }, h('input', { type: 'checkbox', id: 'aeReplace' }), 'Use it in the timeline'),
      b('Save as copy in project', () => aeSave($('#aeReplace').checked), 'Adds the edited sound to the media bin as a new file', 'primary'),
      h('select', { id: 'aeFmt' }, h('option', { value: 'wav' }, 'WAV'), window.AudioEncoder ? h('option', { value: 'm4a' }, 'M4A (AAC)') : null),
      b('Export file…', aeExport, 'Save the edited sound as a file for use elsewhere')));
  document.body.append(root);
  $('#aeName').textContent = AE.m.name;
  $('#aeReplace').checked = AE.m.type === 'audio' && P.clips.some(c => c.media === AE.m.id && c.kind === 'audio');
  $('#aeReplace').parentElement.hidden = AE.m.type !== 'audio';
  aeWire();
  AE.ro = new ResizeObserver(() => aeDraw()); AE.ro.observe(root);
}

/* ---------- waveform drawing (a min/max mipmap keeps long files fast) ---------- */
function aeMip() {
  AE.mip = AE.ch.map(a => {
    const nb = Math.ceil(a.length / AE_BLK), mn = new Float32Array(nb), mx = new Float32Array(nb);
    for (let b = 0; b < nb; b++) { let lo = 1, hi = -1; for (let i = b * AE_BLK, e = Math.min(a.length, i + AE_BLK); i < e; i++) { const v = a[i]; if (v < lo) lo = v; if (v > hi) hi = v; } mn[b] = lo; mx[b] = hi; }
    return { mn, mx };
  });
  AE.ovImg = null;
}
function aeRange(c, s0, s1) { // min/max of channel c over samples [s0, s1)
  const a = AE.ch[c]; let lo = 1, hi = -1;
  if (s1 - s0 > AE_BLK * 2) {
    const { mn, mx } = AE.mip[c], b0 = Math.ceil(s0 / AE_BLK), b1 = Math.floor(s1 / AE_BLK);
    for (let i = s0; i < b0 * AE_BLK; i++) { const v = a[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    for (let b = b0; b < b1; b++) { if (mn[b] < lo) lo = mn[b]; if (mx[b] > hi) hi = mx[b]; }
    for (let i = b1 * AE_BLK; i < s1; i++) { const v = a[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
  } else for (let i = s0; i < s1; i++) { const v = a[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
  return lo > hi ? [0, 0] : [lo, hi];
}
const AE_RULER = 22;
function aeDraw() { if (AE && !AE.drawQ) { AE.drawQ = true; requestAnimationFrame(aeDrawNow); } }
function aeDrawNow() {
  if (!AE) return; AE.drawQ = false;
  const cv = $('#aeCv'), box = cv.parentElement.getBoundingClientRect(), dpr = devicePixelRatio || 1, W = box.width, H = box.height;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); aeClampView(); }
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#0c0d10'; g.fillRect(0, 0, W, H);
  const xs = s => (s - AE.t0) / AE.spp, nc = AE.ch.length, laneH = (H - AE_RULER) / nc;
  if (AE.sel) { const a = xs(AE.sel[0]), b = xs(AE.sel[1]); g.fillStyle = 'rgba(255,138,61,.18)'; g.fillRect(a, AE_RULER, Math.max(1, b - a), H - AE_RULER); }
  for (let c = 0; c < nc; c++) {
    const top = AE_RULER + c * laneH, mid = top + laneH / 2, amp = laneH / 2 - 4;
    g.fillStyle = '#14171d'; g.fillRect(0, top, W, 1);
    g.fillStyle = 'rgba(255,255,255,.08)'; g.fillRect(0, Math.round(mid), W, 1);
    g.fillStyle = '#5bd18b';
    if (AE.spp >= 1) {
      for (let x = 0; x < W; x++) {
        const s0 = Math.floor(AE.t0 + x * AE.spp), s1 = Math.min(AE.n, Math.max(s0 + 1, Math.floor(AE.t0 + (x + 1) * AE.spp)));
        if (s0 >= AE.n) break;
        const [lo, hi] = aeRange(c, s0, s1); g.fillRect(x, mid - hi * amp, 1, Math.max(1, (hi - lo) * amp));
      }
    } else { // zoomed past one sample per pixel: join the samples
      g.strokeStyle = '#5bd18b'; g.lineWidth = 1.2; g.beginPath();
      const a = AE.ch[c], i0 = Math.max(0, Math.floor(AE.t0)), i1 = Math.min(AE.n - 1, Math.ceil(AE.t0 + W * AE.spp));
      for (let i = i0; i <= i1; i++) { const x = xs(i), y = mid - a[i] * amp; if (i === i0) g.moveTo(x, y); else g.lineTo(x, y); }
      g.stroke();
    }
    g.fillStyle = 'rgba(255,255,255,.3)'; g.font = '10px "Segoe UI",sans-serif'; g.fillText(nc > 1 ? (c ? 'R' : 'L') : 'Mono', 6, top + 13);
  }
  // ruler
  g.fillStyle = '#181b21'; g.fillRect(0, 0, W, AE_RULER);
  const secPx = AE.sr / AE.spp, step = [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300].find(s => s * secPx >= 90) || 600;
  g.fillStyle = '#8a92a2'; g.font = '10px ui-monospace,Consolas,monospace';
  for (let t = Math.floor(AE.t0 / AE.sr / step) * step; ; t += step) {
    const x = xs(t * AE.sr); if (x > W) break; if (x < -60) continue;
    const lab = t < 60 ? +t.toFixed(3) + 's' : `${Math.floor(t / 60)}:${String(+(t % 60).toFixed(2)).padStart(2, '0')}`;
    g.fillRect(Math.round(x), 12, 1, AE_RULER - 12); g.fillText(lab, Math.round(x) + 3, 10);
  }
  // cursor and playhead
  const cx = Math.round(xs(AE.cur)) + 0.5; g.fillStyle = '#ffd166'; g.fillRect(cx - 0.5, 0, 1.5, H);
  if (AE.play) { const px = Math.round(xs(aePlayPos())) + 0.5; g.fillStyle = '#fff'; g.fillRect(px - 0.5, 0, 1.5, H); }
  aeDrawOverview(); aeStatus();
}
function aeDrawOverview() {
  const cv = $('#aeOv'), dpr = devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr) || !AE.ovImg) {
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    const o = document.createElement('canvas'); o.width = cv.width; o.height = cv.height; const g = o.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#101216'; g.fillRect(0, 0, W, H); g.fillStyle = 'rgba(91,209,139,.55)';
    const spp = AE.n / W;
    for (let x = 0; x < W; x++) { const s0 = Math.floor(x * spp), s1 = Math.max(s0 + 1, Math.floor((x + 1) * spp)); let hi = 0; for (let c = 0; c < AE.ch.length; c++) { const [lo, h2] = aeRange(c, s0, Math.min(AE.n, s1)); hi = Math.max(hi, h2, -lo); } g.fillRect(x, H / 2 - hi * (H / 2 - 2), 1, Math.max(1, hi * (H - 4))); }
    AE.ovImg = o;
  }
  const g = cv.getContext('2d'); g.setTransform(1, 0, 0, 1, 0, 0); g.drawImage(AE.ovImg, 0, 0); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const k = W / AE.n, vw = $('#aeCv').clientWidth * AE.spp;
  if (AE.sel) { g.fillStyle = 'rgba(255,138,61,.3)'; g.fillRect(AE.sel[0] * k, 0, Math.max(1, (AE.sel[1] - AE.sel[0]) * k), H); }
  g.strokeStyle = '#ff8a3d'; g.lineWidth = 1.5; g.strokeRect(AE.t0 * k + 0.75, 0.75, Math.max(3, vw * k) - 1.5, H - 1.5);
}
function aeStatus() {
  const s = AE.sr, sel = AE.sel;
  $('#aeStat').textContent = `${AE.ch.length > 1 ? 'Stereo' : 'Mono'} · ${(s / 1000).toFixed(1)} kHz · length ${aeTime(AE.n / s)}   |   cursor ${aeTime(AE.cur / s)}` +
    (sel ? `   |   selection ${aeTime(sel[0] / s)} → ${aeTime(sel[1] / s)} (${aeTime((sel[1] - sel[0]) / s)})` : '   |   no selection — effects apply to the whole file') + (AE.dirty ? '   ·   edited' : '');
}

/* ---------- view ---------- */
const aeW = () => $('#aeCv').clientWidth || 800;
function aeClampView() { AE.spp = clamp(AE.spp, 1 / 16, Math.max(1, AE.n / aeW())); AE.t0 = clamp(AE.t0, 0, Math.max(0, AE.n - aeW() * AE.spp)); }
function aeFit() { AE.t0 = 0; AE.spp = Math.max(1 / 16, AE.n / aeW()); aeClampView(); aeDraw(); }
function aeZoom(f, x = aeW() / 2) { const s = AE.t0 + x * AE.spp; AE.spp *= f; aeClampView(); AE.t0 = s - x * AE.spp; aeClampView(); aeDraw(); }
function aeZoomSel() { if (!AE.sel) return toast('Select a part of the waveform first', true); const len = AE.sel[1] - AE.sel[0]; AE.spp = len / aeW() * 1.1; AE.t0 = AE.sel[0] - len * 0.05; aeClampView(); aeDraw(); }

/* ---------- mouse ---------- */
function aeWire() {
  const cv = $('#aeCv'), ov = $('#aeOv');
  const sAt = e => clamp(Math.round(AE.t0 + (e.clientX - cv.getBoundingClientRect().left) * AE.spp), 0, AE.n);
  let d = null;
  cv.addEventListener('pointerdown', e => {
    if (e.button !== 0 || AE.busy) return;
    cv.setPointerCapture(e.pointerId);
    const s = sAt(e);
    if (e.shiftKey) { const a = AE.sel ? (Math.abs(s - AE.sel[0]) < Math.abs(s - AE.sel[1]) ? AE.sel[1] : AE.sel[0]) : AE.cur; d = { anchor: a, x0: -1e9 }; AE.sel = [Math.min(a, s), Math.max(a, s)]; }
    else d = { anchor: s, x0: e.clientX };
    aeDraw();
  });
  cv.addEventListener('pointermove', e => {
    if (!d) return;
    if (Math.abs(e.clientX - d.x0) < 3) return;
    const s = sAt(e); AE.sel = s === d.anchor ? null : [Math.min(d.anchor, s), Math.max(d.anchor, s)];
    const x = e.clientX - cv.getBoundingClientRect().left; if (x > aeW() - 10) { AE.t0 += AE.spp * 12; aeClampView(); } else if (x < 10) { AE.t0 -= AE.spp * 12; aeClampView(); }
    aeDraw();
  });
  const up = e => { if (!d) return; if (Math.abs(e.clientX - d.x0) < 3) { AE.cur = d.anchor; AE.sel = null; if (AE.play) { aeStop(); aePlay(); } } else if (AE.sel) AE.cur = AE.sel[0]; d = null; aeDraw(); };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  cv.addEventListener('wheel', e => {
    e.preventDefault();
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) { AE.t0 += (e.deltaX || e.deltaY) * AE.spp; aeClampView(); aeDraw(); }
    else aeZoom(Math.pow(1.0018, e.deltaY), e.clientX - cv.getBoundingClientRect().left);
  }, { passive: false });
  let od = false;
  const ovMove = e => { const r = ov.getBoundingClientRect(), s = (e.clientX - r.left) / r.width * AE.n; AE.t0 = s - aeW() * AE.spp / 2; aeClampView(); aeDraw(); };
  ov.addEventListener('pointerdown', e => { od = true; ov.setPointerCapture(e.pointerId); ovMove(e); });
  ov.addEventListener('pointermove', e => { if (od) ovMove(e); });
  ov.addEventListener('pointerup', () => { od = false; });
}

/* ---------- keys (captured while the editor is open, so timeline shortcuts don't fire) ---------- */
function aeKey(e) {
  if (!AE || REC) return;
  const t = document.activeElement && document.activeElement.tagName;
  if (t === 'SELECT' || (t === 'INPUT' && document.activeElement.type !== 'checkbox')) return;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key, ctrl = e.ctrlKey || e.metaKey;
  const act = {
    ' ': aePlayToggle, Escape: aeClose, Delete: aeDelete, Backspace: aeDelete, Home: () => { AE.cur = 0; AE.t0 = 0; aeDraw(); }, End: () => { AE.cur = AE.n; aeClampView(); aeDraw(); },
    '+': () => aeZoom(0.5), '=': () => aeZoom(0.5), '-': () => aeZoom(2),
  }[k] || (ctrl && { z: e.shiftKey ? aeRedo : aeUndo, y: aeRedo, x: aeCut, c: aeCopy, v: aePaste, a: () => { AE.sel = [0, AE.n]; aeDraw(); } }[k]);
  e.stopImmediatePropagation();
  if (act) { e.preventDefault(); if (!AE.busy) act(); }
}

/* ---------- playback ---------- */
function aePlayPos() { const p = AE.play; if (!p) return AE.cur; const e = (actx.currentTime - p.t) * AE.sr; return p.loop ? p.a + e % (p.b - p.a) : Math.min(p.b, p.a + e); }
function aePlay() {
  ensureAudio(); if (!actx) return;
  const a = AE.sel ? AE.sel[0] : AE.cur >= AE.n - 10 ? 0 : AE.cur, b = AE.sel ? AE.sel[1] : AE.n; if (b - a < 10) return;
  const buf = actx.createBuffer(AE.ch.length, b - a, AE.sr); AE.ch.forEach((x, i) => buf.copyToChannel(x.subarray(a, b), i));
  const src = actx.createBufferSource(); src.buffer = buf; src.loop = AE.loop && !!AE.sel; src.connect(actx.destination);
  src.onended = () => { if (AE && AE.play && AE.play.src === src) { AE.play = null; aeDraw(); } };
  src.start(); AE.play = { src, a, b, t: actx.currentTime, loop: src.loop };
  const tick = () => { if (!AE || !AE.play || AE.play.src !== src) return; aeDrawNow(); requestAnimationFrame(tick); }; tick();
}
function aeStop() { if (AE && AE.play) { const p = AE.play; AE.play = null; try { p.src.stop(); } catch (e) { } aeDraw(); } }
function aePlayToggle() { if (AE.play) aeStop(); else aePlay(); }

/* ---------- edits (each one is undoable; the sound is replaced, never changed in place) ---------- */
const aeRg = () => AE.sel || [0, AE.n];
function aeCommit(ch, sel, cur) {
  aeStop();
  AE.undo.push({ ch: AE.ch, sel: AE.sel, cur: AE.cur }); AE.redo = [];
  let tot = AE.undo.reduce((s, u) => s + u.ch.length * u.ch[0].length, 0);
  while (AE.undo.length > 3 && tot > AE_UNDO_FLOATS) { const u = AE.undo.shift(); tot -= u.ch.length * u.ch[0].length; }
  AE.ch = ch; AE.n = ch[0].length; AE.sel = sel; AE.cur = clamp(cur ?? AE.cur, 0, AE.n); AE.dirty = true;
  aeMip(); aeClampView(); aeDraw();
}
function aeUndo() { if (!AE.undo.length) return toast('Nothing to undo'); aeStop(); AE.redo.push({ ch: AE.ch, sel: AE.sel, cur: AE.cur }); const u = AE.undo.pop(); Object.assign(AE, { ch: u.ch, n: u.ch[0].length, sel: u.sel, cur: u.cur, dirty: true }); aeMip(); aeClampView(); aeDraw(); }
function aeRedo() { if (!AE.redo.length) return toast('Nothing to redo'); aeStop(); AE.undo.push({ ch: AE.ch, sel: AE.sel, cur: AE.cur }); const u = AE.redo.pop(); Object.assign(AE, { ch: u.ch, n: u.ch[0].length, sel: u.sel, cur: u.cur, dirty: true }); aeMip(); aeClampView(); aeDraw(); }
// new channels: [0,a) + mid + [b,n)
function aeSplice(a, b, mid) {
  return AE.ch.map((x, c) => { const m = mid ? (mid[c] || mid[0]) : new Float32Array(0), o = new Float32Array(a + m.length + (AE.n - b)); o.set(x.subarray(0, a)); o.set(m, a); o.set(x.subarray(b), a + m.length); return o; });
}
const aeNeedSel = () => { if (AE.sel && AE.sel[1] > AE.sel[0]) return true; toast('Drag across the waveform to select a part first', true); return false; };
function aeCopy() { if (!aeNeedSel()) return; const [a, b] = AE.sel; AE.clip = AE.ch.map(x => x.slice(a, b)); toast(`Copied ${aeTime((b - a) / AE.sr)}`); }
function aeDelete() { if (!aeNeedSel()) return; const [a, b] = AE.sel; if (b - a >= AE.n) return toast("That's everything — use Trim or Undo instead", true); aeCommit(aeSplice(a, b, null), null, a); }
function aeCut() { if (!aeNeedSel()) return; aeCopy(); aeDelete(); }
function aePaste() {
  if (!AE.clip) return toast('Copy or cut something first', true);
  const [a, b] = AE.sel || [AE.cur, AE.cur], len = AE.clip[0].length;
  aeCommit(aeSplice(a, b, AE.clip), [a, a + len], a + len); toast(`Pasted ${aeTime(len / AE.sr)}`);
}
function aeTrim() { if (!aeNeedSel()) return; const [a, b] = AE.sel; aeCommit(AE.ch.map(x => x.slice(a, b)), null, 0); AE.t0 = 0; aeFit(); }
function aeSilence() { if (!aeNeedSel()) return; const [a, b] = AE.sel; aeCommit(aeSplice(a, b, AE.ch.map(() => new Float32Array(b - a))), AE.sel); }
function aeInsertSilence() {
  const v = prompt('Seconds of silence to insert at the cursor', '1'); const s = parseFloat(v); if (!(s > 0)) return;
  const len = Math.round(Math.min(s, 600) * AE.sr), a = AE.sel ? AE.sel[0] : AE.cur;
  aeCommit(aeSplice(a, a, AE.ch.map(() => new Float32Array(len))), [a, a + len], a);
}
// sample-by-sample effect on the selection (or everything): f(value, index-within-range, range-length)
function aeMap(f, label) {
  const [a, b] = aeRg(), len = b - a;
  const ch = AE.ch.map(x => { const o = x.slice(); for (let i = a; i < b; i++) o[i] = f(x[i], i - a, len); return o; });
  aeCommit(ch, AE.sel); if (label) toast(label + (AE.sel ? ' (selection)' : ''));
}
function aePeak() { const [a, b] = aeRg(); let p = 0; for (const x of AE.ch) for (let i = a; i < b; i++) { const v = x[i] < 0 ? -x[i] : x[i]; if (v > p) p = v; } return p; }
function aeGain(db) { const g = Math.pow(10, db / 20), clip = aePeak() * g > 1; aeMap(v => v * g, `${db > 0 ? '+' : ''}${db} dB`); if (clip) toast('Some peaks are now above 0 dB and will distort — try Normalise', true); }
function aeNormalise() { const p = aePeak(); if (p < 1e-5) return toast('Silent — nothing to normalise', true); const g = 0.891 / p; aeMap(v => v * g, `Normalised to −1 dB peak (${(20 * Math.log10(g)).toFixed(1)} dB)`); }
function aeFade(isIn) { if (!aeNeedSel()) return; aeMap((v, i, n) => { const p = n > 1 ? i / (n - 1) : 1, k = isIn ? p : 1 - p; return v * k * k * (3 - 2 * k); }, isIn ? 'Fade in' : 'Fade out'); }
function aeReverse() { const [a, b] = aeRg(); aeCommit(AE.ch.map(x => { const o = x.slice(); for (let i = a, j = b - 1; i < b; i++, j--) o[i] = x[j]; return o; }), AE.sel); toast('Reversed' + (AE.sel ? ' (selection)' : '')); }

/* ---------- effects rendered through Web Audio (EQ, compressor, echo, reverb, speed) ---------- */
async function aeBusy(label, fn) {
  AE.busy = true; const el = $('#aeBusy'); el.textContent = label + '…'; el.hidden = false; aeStop();
  try { return await fn(); } catch (e) { console.error(e); toast(label + ' failed: ' + e.message, true); }
  finally { if (AE) { AE.busy = false; el.hidden = true; } }
}
// run the selected range through a node graph built by `build(ctx, src) → output node`; returns the new range
async function aeRender(build, lenOut, rate = 1) {
  const [a, b] = aeRg(), len = b - a, nc = AE.ch.length;
  const ctx = new OfflineAudioContext(nc, lenOut ?? len, AE.sr), buf = ctx.createBuffer(nc, len, AE.sr);
  AE.ch.forEach((x, i) => buf.copyToChannel(x.subarray(a, b), i));
  const src = ctx.createBufferSource(); src.buffer = buf; src.playbackRate.value = rate;
  build(ctx, src).connect(ctx.destination); src.start();
  const r = await ctx.startRendering();
  return Array.from({ length: nc }, (_, i) => new Float32Array(r.getChannelData(i)));
}
function aeApply(mid, label) { const [a, b] = aeRg(), had = AE.sel; aeCommit(aeSplice(a, b, mid), had ? [a, a + mid[0].length] : null); toast(label + (had ? ' (selection)' : '')); }
const aeEq = eq => aeBusy('EQ', async () => aeApply(await aeRender((ctx, src) => { const c = makeChain(ctx); c.set({ eq }); src.connect(c.input); return c.output; }), 'EQ applied'));
const aeComp = (thr, ratio) => aeBusy('Compressor', async () => {
  const before = aePeak();
  const mid = await aeRender((ctx, src) => { const k = ctx.createDynamicsCompressor(); k.threshold.value = thr; k.ratio.value = ratio; k.knee.value = 6; k.attack.value = 0.005; k.release.value = 0.2; src.connect(k); return k; });
  let p = 0; for (const x of mid) for (const v of x) { const a = v < 0 ? -v : v; if (a > p) p = a; }
  if (p > 1e-5) { const g = Math.min(before, 0.891) / p; for (const x of mid) for (let i = 0; i < x.length; i++) x[i] *= g; } // make-up gain back to the old peak
  aeApply(mid, 'Compressed');
});
const aeEcho = (delay, fb) => aeBusy('Echo', async () => aeApply(await aeRender((ctx, src) => {
  const out = ctx.createGain(), d = ctx.createDelay(2), f = ctx.createGain(), wet = ctx.createGain();
  d.delayTime.value = delay; f.gain.value = fb; wet.gain.value = 0.4;
  src.connect(out); src.connect(d); d.connect(f); f.connect(d); d.connect(wet); wet.connect(out); return out;
}), 'Echo added'));
const aeReverb = secs => aeBusy('Reverb', async () => aeApply(await aeRender((ctx, src) => {
  const n = Math.round(secs * AE.sr), ir = ctx.createBuffer(2, n, AE.sr);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c); let e = 0;
    for (let i = 0; i < n; i++) { d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3); e += d[i] * d[i]; }
    const k = 1 / Math.sqrt(e); for (let i = 0; i < n; i++) d[i] *= k; // unit energy: the reverb is as loud as what feeds it
  }
  // the browser's own normalising scales a noise impulse down to almost nothing, so it's off
  const conv = ctx.createConvolver(), wet = ctx.createGain(), out = ctx.createGain(); conv.normalize = false; conv.buffer = ir; wet.gain.value = 0.35;
  src.connect(out); src.connect(conv); conv.connect(wet); wet.connect(out); return out;
}), secs > 1 ? 'Hall reverb added' : 'Room reverb added'));
const aeSpeed = r => aeBusy('Speed', async () => { const [a, b] = aeRg(); aeApply(await aeRender((ctx, src) => src, Math.max(1, Math.round((b - a) / r)), r), `Speed ${r}× (pitch changes with it)`); });
const aeDenoise = level => aeBusy('Noise reduction', async () => {
  const [a, b] = aeRg(); if (b - a < AE.sr * 0.5) throw new Error('select at least half a second');
  const out = await denoiseArrays(AE.ch[0].slice(a, b), AE.ch[1] ? AE.ch[1].slice(a, b) : null, level, p => { $('#aeBusy').textContent = `Noise reduction… ${Math.round(p * 100)}%`; });
  aeApply(out, 'Noise reduced');
});

/* ---------- save / export / close ---------- */
function aeCopyName() {
  const base = AE.m.name.replace(/\.[^.]+$/, '').replace(/ \((edit|clean|audio)( \d+)?\)$/, '');
  const names = new Set([...media.values()].map(x => x.name));
  for (let i = 1; ; i++) { const nm = `${base} (edit${i > 1 ? ' ' + i : ''}).wav`; if (!names.has(nm)) return nm; }
}
async function aeSave(replace) {
  await aeBusy('Saving', async () => {
    const m = AE.m, name = aeCopyName();
    const [a] = await importFiles([new File([wavBlob(AE.ch, AE.sr)], name, { type: 'audio/wav' })], { quiet: true });
    if (!a) throw new Error('could not add the file');
    let n = 0;
    if (replace) edit(() => { for (const c of P.clips) if (c.media === m.id && c.kind === 'audio') { c.media = a.id; c.name = a.name; c.out = Math.min(c.out, a.duration); c.in = Math.min(c.in, Math.max(0, c.out - frame())); tidyEnv(c); n++; } });
    AE.dirty = false; aeClose();
    UI.binSel = a.id; renderBin();
    toast(`Saved “${a.name}” to the media bin` + (n ? ` — ${n} timeline clip${n > 1 ? 's' : ''} now use it` : ''));
  });
}
async function aeExport() {
  const fmt = $('#aeFmt').value, base = aeCopyName().replace(/\.wav$/, '');
  await aeBusy('Exporting', async () => {
    if (fmt === 'wav') return download(wavBlob(AE.ch, AE.sr), base + '.wav');
    const b = new AudioBuffer({ length: AE.n, numberOfChannels: 2, sampleRate: AE.sr });
    b.copyToChannel(AE.ch[0], 0); b.copyToChannel(AE.ch[1] || AE.ch[0], 1);
    const cfg = await pickAudio(AE.sr); if (!cfg) throw new Error('no AAC encoder — export WAV instead');
    download(muxMP4(null, await encodeMix(b, cfg, () => { })), base + '.m4a');
  });
}
function aeClose() {
  if (!AE || AE.busy && AE.dirty) return;
  if (AE.dirty && !confirm('Close the audio editor and lose your edits? (Save as copy keeps them.)')) return;
  aeStop(); removeEventListener('keydown', aeKey, true);
  AE.ro.disconnect(); $('#aed').remove(); AE = null;
}
