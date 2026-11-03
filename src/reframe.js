/* ============================================================
   vertical reframe: a 9:16 (or 4:5 / 1:1) window over the landscape timeline, with keyframed
   position and zoom. Zoom 1 = the window is the full height of the frame.
   P.reframe = { ar, x, y, z, keys: [{ t, x, y, z, ease }] }   x/y: window centre, 0–1 of the frame
   With no keys x/y/z are the framing; once there are keys they drive it and x/y/z are unused.
   ============================================================ */
const RF = { '9x16': { ar: 9 / 16, out: [1080, 1920], label: '9:16' }, '4x5': { ar: 4 / 5, out: [1080, 1350], label: '4:5' }, '1x1': { ar: 1, out: [1080, 1080], label: '1:1' } };
const RF_ZMAX = 6;
const rfDefault = () => ({ ar: '9x16', x: 0.5, y: 0.5, z: 1, keys: [] });
const rfShape = () => RF[(P.reframe && P.reframe.ar) || '9x16'] || RF['9x16'];
// only meaningful when the window is narrower than the project frame
const rfPossible = () => P.settings.w / P.settings.h > rfShape().ar + 0.01;
const rfView = () => UI.view === 'reframe' && UI.mode === 'timeline' && !!P.reframe && rfPossible();
const RF_EASE = { smooth: p => p * p * (3 - 2 * p), linear: p => p, hold: () => 0 };
function rfAt(t) {
  const R = P.reframe; if (!R) return { x: 0.5, y: 0.5, z: 1 };
  const k = R.keys; if (!k.length) return { x: R.x, y: R.y, z: R.z };
  if (t <= k[0].t) return k[0];
  const l = k[k.length - 1]; if (t >= l.t) return l;
  let i = 1; while (k[i].t < t) i++;
  const a = k[i - 1], b = k[i], p = (RF_EASE[a.ease] || RF_EASE.smooth)((t - a.t) / (b.t - a.t));
  // zoom eases in log space so a zoom-in feels even all the way
  return { x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p, z: Math.exp(Math.log(a.z) + (Math.log(b.z) - Math.log(a.z)) * p) };
}
// the window in project pixels at time t, kept inside the frame
function rfRect(t) {
  const W = P.settings.w, H = P.settings.h, ar = rfShape().ar, f = rfAt(t);
  let sh = H / f.z, sw = sh * ar; if (sw > W) { sw = W; sh = sw / ar; }
  const cx = clamp(f.x * W, sw / 2, W - sw / 2), cy = clamp(f.y * H, sh / 2, H - sh / 2);
  return { sx: cx - sw / 2, sy: cy - sh / 2, sw, sh };
}
// draw the reframed timeline into g (OW×OH): the composite is transformed, not cropped afterwards,
// so zooming in keeps the full detail of high-resolution sources
function renderReframed(g, t, OW, OH) {
  const r = rfRect(t), k = OH / r.sh;
  g.save(); g.translate(-r.sx * k, -r.sy * k);
  renderTimelineFrame(g, t, k);
  g.restore();
}
const rfKeyAt = t => P.reframe ? P.reframe.keys.findIndex(k => Math.abs(k.t - t) < 0.5 / fps()) : -1;
// change the framing at the playhead: without keys it sets the framing; with keys it adds/updates one here
function rfSet(v) {
  const R = P.reframe; if (!R) return;
  for (const a of ['x', 'y']) if (v[a] != null) v[a] = clamp(v[a], 0, 1);
  if (v.z != null) v.z = clamp(v.z, 1, RF_ZMAX);
  if (!R.keys.length) { Object.assign(R, v); return; }
  const t = q(UI.t), i = rfKeyAt(t);
  if (i >= 0) Object.assign(R.keys[i], v);
  else { const cur = rfAt(t), prev = R.keys.filter(k => k.t < t).pop(); R.keys.push({ t, x: cur.x, y: cur.y, z: cur.z, ease: prev ? prev.ease : 'smooth', ...v }); R.keys.sort((a, b) => a.t - b.t); }
}
// pin the window where it is: the first key also takes the current framing
function rfAddKey() {
  const R = P.reframe, t = q(UI.t), cur = rfAt(t), i = rfKeyAt(t);
  if (i >= 0) return false;
  const prev = R.keys.filter(k => k.t < t).pop();
  R.keys.push({ t, x: cur.x, y: cur.y, z: cur.z, ease: prev ? prev.ease : 'smooth' }); R.keys.sort((a, b) => a.t - b.t);
  return true;
}
// a key at every cut on the video tracks, holding the framing it has there — then reposition shot by shot
function rfKeysAtCuts() {
  const R = P.reframe, cuts = new Set([0]);
  for (const c of P.clips) if (trackOf(c) && trackOf(c).type === 'video') { cuts.add(q(c.start)); }
  let n = 0;
  for (const t of [...cuts].sort((a, b) => a - b)) {
    if (t >= tlEnd() - EPS || rfKeyAt(t) >= 0) continue;
    const cur = rfAt(t); R.keys.push({ t, x: cur.x, y: cur.y, z: cur.z, ease: 'hold' }); n++;
  }
  R.keys.sort((a, b) => a.t - b.t); return n;
}
function rfJump(dir) {
  const k = P.reframe && P.reframe.keys, t = UI.t; if (!k || !k.length) return;
  const nx = dir > 0 ? k.find(x => x.t > t + 1e-4) : [...k].reverse().find(x => x.t < t - 1e-4);
  if (nx) { setTime(nx.t); renderInsp(); }
}
function rfToggleView(on = UI.view !== 'reframe') {
  if (on && !rfPossible()) return toast('The project is already narrower than a vertical frame — reframing is for landscape projects', true);
  if (on && !P.reframe) P.reframe = rfDefault();
  UI.view = on ? 'reframe' : 'main';
  if (on && UI.mode !== 'timeline') setMode('timeline');
  $('#tabRF').classList.toggle('on', on); $('#viewer').classList.toggle('reframe', on);
  resizePreview(); renderInsp(); dirtyTL = true;
}

/* ---------- viewer: drag to position, scroll to zoom ---------- */
{
  const st = $('#stage');
  let drag = null;
  st.addEventListener('pointerdown', e => {
    if (!rfView() || e.button !== 0) return;
    e.preventDefault(); st.setPointerCapture(e.pointerId);
    const f = rfAt(UI.t), r = rfRect(UI.t);
    drag = { x0: e.clientX, y0: e.clientY, f, k: r.sw / st.getBoundingClientRect().width };
    beginEdit(); if (UI.playing) pause();
  });
  st.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = (e.clientX - drag.x0) * drag.k, dy = (e.clientY - drag.y0) * drag.k;
    // dragging moves the picture, so the window moves the other way; pinned to the frame edges
    const r0 = rfRect(UI.t), W = P.settings.w, H = P.settings.h;
    rfSet({ x: clamp(drag.f.x * W - dx, r0.sw / 2, W - r0.sw / 2) / W, y: clamp(drag.f.y * H - dy, r0.sh / 2, H - r0.sh / 2) / H });
    dirtyPV = dirtyTL = true; rfInfo();
  });
  const end = () => { if (!drag) return; drag = null; endEdit(); changed(); };
  st.addEventListener('pointerup', end); st.addEventListener('pointercancel', end);
  let wheelT = 0;
  st.addEventListener('wheel', e => {
    if (!rfView()) return;
    e.preventDefault(); beginEdit();
    rfSet({ z: rfAt(UI.t).z * Math.pow(1.0015, -e.deltaY) });
    dirtyPV = dirtyTL = true; rfInfo();
    clearTimeout(wheelT); wheelT = setTimeout(() => { endEdit(); changed(); }, 350); // one undo step per scroll gesture
  }, { passive: false });
  st.addEventListener('dblclick', () => { if (!rfView()) return; beginEdit(); rfSet({ x: 0.5, y: 0.5, z: 1 }); endEdit(); changed(); toast('Window centred, full height'); });
}
// the reframe inspector shows the framing at the playhead, so it follows scrubbing
let rfInspQueued = false;
function rfInspSoon() { if (rfInspQueued || UI.sel.size || UI.selXf) return; rfInspQueued = true; requestAnimationFrame(() => { rfInspQueued = false; if (!UI.drag) renderInsp(); }); }
function rfInfo() {
  const el = $('#rfInfo'); if (!el) return;
  if (!rfView()) { el.hidden = true; return; }
  const f = rfAt(UI.t), k = rfKeyAt(q(UI.t)) >= 0, n = P.reframe.keys.length;
  el.hidden = false; el.textContent = `${rfShape().label} · ${f.z.toFixed(2)}× · ${n ? (k ? '◆ key' : n + ' keys') : 'no keys'}`;
}
