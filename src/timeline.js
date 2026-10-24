/* ============================================================
   timeline: drawing, hit-testing, interactions, edit commands
   ============================================================ */
const tl = $('#tl'), tg = tl.getContext('2d');
let TW = 0, TH = 0, DPR = 1;
const RULER = 26, SBH = 11;
const KCOL = { video: ['#24485c', '#3f86ab'], audio: ['#1f4a3a', '#36946d'], image: ['#3f3366', '#7c63c4'], text: ['#5e3a1c', '#c57634'], color: ['#3a3f4a', '#6b7383'] };
const LABELS = { red: '#d94452', orange: '#e07b2e', yellow: '#cfae36', green: '#3fa564', cyan: '#2ea7c4', blue: '#3b6fd6', purple: '#8a55d6', pink: '#d65aa6' };
const X = t => t * UI.pps - UI.sx, T = x => (x + UI.sx) / UI.pps;
const tH = tr => Math.round((tr.type === 'video' ? 58 : 46) * UI.tScale);
function layout() { let y = RULER; const out = []; for (const tr of P.tracks) { const hh = tH(tr); out.push({ tr, y: y - UI.sy, h: hh }); y += hh; } out.total = y - RULER; return out; }
function sizeTimeline() {
  const r = $('#tlWrap').getBoundingClientRect(); DPR = devicePixelRatio || 1;
  TW = r.width; TH = r.height; tl.width = Math.round(TW * DPR); tl.height = Math.round(TH * DPR);
  clampScroll(); dirtyTL = true; syncHeads();
}
function contentLen() { return Math.max(tlEnd() * 1.1 + 10, T(TW)); }
function clampScroll() {
  const L = layout();
  UI.sy = clamp(UI.sy, 0, Math.max(0, L.total - (TH - RULER - SBH) + 10));
  UI.sx = Math.max(0, UI.sx);
}
function setZoom(pps, anchorX) {
  const ax = anchorX == null ? (X(UI.t) >= 0 && X(UI.t) <= TW ? X(UI.t) : TW / 2) : anchorX;
  const ta = T(ax);
  UI.pps = clamp(pps, 0.5, 2400);
  UI.sx = Math.max(0, ta * UI.pps - ax);
  $('#zoom').value = Math.round((Math.log2(UI.pps) + 1) / (Math.log2(2400) + 1) * 1000);
  dirtyTL = true;
}
function zoomFit() { const e = tlEnd(); setZoom((TW - 40) / Math.max(e, 5)); UI.sx = 0; dirtyTL = true; }
function ticks() {
  const f = fps(), cands = [1 / f, 2 / f, 5 / f, 10 / f, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200];
  let major = cands.find(s => s * UI.pps >= 90) || 1200;
  const minor = major * UI.pps / 5 >= 7 ? major / 5 : major * UI.pps / 2 >= 7 ? major / 2 : major;
  return { major, minor };
}

/* ---------- draw ---------- */
/* Everything except the playhead is drawn into an offscreen base layer. During playback only the
   playhead moves, so each frame is just a blit + playhead instead of re-rendering thumbnails and
   waveforms — that full redraw was stealing main-thread time from the video preview. */
const tlBase = document.createElement('canvas'), tbg = tlBase.getContext('2d');
let tlDrawMs = 0;
function drawTimeline() {
  const t0 = performance.now();
  if (tlBase.width !== tl.width || tlBase.height !== tl.height) { tlBase.width = tl.width; tlBase.height = tl.height; }
  drawTimelineBase();
  blitTimeline();
  tlDrawMs = tlDrawMs * 0.8 + (performance.now() - t0) * 0.2;
}
function blitTimeline() {
  const g = tg; g.setTransform(1, 0, 0, 1, 0, 0); g.drawImage(tlBase, 0, 0); g.setTransform(DPR, 0, 0, DPR, 0, 0);
  const px = Math.round(X(UI.t)) + .5;
  if (px > -10 && px < TW + 10) {
    g.strokeStyle = '#ff8a3d'; g.lineWidth = 1; g.beginPath(); g.moveTo(px, RULER - 4); g.lineTo(px, TH - SBH); g.stroke();
    g.fillStyle = '#ff8a3d'; g.beginPath(); g.moveTo(px - 6, 2); g.lineTo(px + 6, 2); g.lineTo(px + 6, RULER - 10); g.lineTo(px, RULER - 4); g.lineTo(px - 6, RULER - 10); g.closePath(); g.fill();
  }
}
function drawTimelineBase() {
  const g = tbg; g.setTransform(DPR, 0, 0, DPR, 0, 0);
  g.fillStyle = '#101216'; g.fillRect(0, 0, TW, TH);
  const L = layout(), end = tlEnd(), tk = ticks();
  for (const { tr, y, h: hh } of L) {
    if (y + hh < RULER || y > TH) continue;
    g.fillStyle = tr.type === 'video' ? '#15181e' : '#131917'; g.fillRect(0, y, TW, hh);
    g.fillStyle = '#0b0c0f'; g.fillRect(0, y + hh - 1, TW, 1);
    if (tr.locked) { g.save(); g.beginPath(); g.rect(0, y, TW, hh); g.clip(); g.strokeStyle = 'rgba(255,255,255,.04)'; g.lineWidth = 6; for (let x = -hh; x < TW; x += 18) { g.beginPath(); g.moveTo(x, y + hh); g.lineTo(x + hh, y); g.stroke(); } g.restore(); }
  }
  const xe = X(end); if (xe < TW) { g.fillStyle = 'rgba(0,0,0,.22)'; g.fillRect(Math.max(0, xe), RULER, TW, TH); }
  g.fillStyle = 'rgba(255,255,255,.03)';
  for (let t = Math.floor(T(0) / tk.major) * tk.major; X(t) < TW; t += tk.major) g.fillRect(Math.round(X(t)), RULER, 1, TH);
  if (P.inPt != null || P.outPt != null) { const a = X(P.inPt ?? 0), b = X(P.outPt ?? end); g.fillStyle = 'rgba(76,201,240,.05)'; g.fillRect(a, RULER, b - a, TH); }
  g.save(); g.beginPath(); g.rect(0, RULER, TW, TH - RULER - SBH); g.clip();
  for (const lay of L) {
    if (lay.y + lay.h < RULER || lay.y > TH) continue;
    const cs = clipsOn(lay.tr.id);
    for (const c of cs) drawClipTL(g, c, lay);
    drawOverlaps(g, cs, lay);
  }
  // drag feedback: overwrite preview
  const d = UI.drag;
  if (d && d.type === 'move' && d.moved) {
    for (const it of d.items) {
      const lay = L.find(l => l.tr.id === it.c.track); if (!lay) continue;
      for (const o of clipsOn(it.c.track)) {
        if (d.ids.has(o.id)) continue;
        const s = Math.max(o.start, it.c.start), e = Math.min(cend(o), cend(it.c)); if (e <= s + EPS) continue;
        const contained = (o.start >= it.c.start - EPS && cend(o) <= cend(it.c) + EPS) || (o.start < it.c.start && cend(o) > cend(it.c));
        const ins = d.insert;
        g.fillStyle = ins ? 'rgba(76,201,240,.0)' : (!UI.autoX || contained) ? 'rgba(255,77,94,.38)' : 'rgba(255,200,120,.0)';
        g.fillRect(X(s), lay.y + 2, X(e) - X(s), lay.h - 4);
      }
      if (d.insert) { g.fillStyle = '#4cc9f0'; g.fillRect(X(it.c.start) - 1, lay.y, 3, lay.h); }
    }
  }
  // ghost from bin drag
  if (UI.ghost) {
    const gh = UI.ghost, lay = gh.ti >= 0 ? L[gh.ti] : null;
    const y = lay ? lay.y + 2 : (L.length ? L[L.length - 1].y + L[L.length - 1].h + 2 : RULER + 2), hh = lay ? lay.h - 4 : 40;
    g.fillStyle = 'rgba(255,138,61,.25)'; g.strokeStyle = '#ff8a3d'; g.setLineDash([5, 4]); g.lineWidth = 1.5;
    g.fillRect(X(gh.start), y, gh.dur * UI.pps, hh); g.strokeRect(X(gh.start) + .5, y + .5, gh.dur * UI.pps - 1, hh - 1); g.setLineDash([]);
    g.fillStyle = '#ffd2b3'; g.font = '600 11px "Segoe UI",sans-serif'; g.fillText((lay ? '' : '+ new track · ') + gh.name, X(gh.start) + 6, y + 15);
  }
  // marker lines
  for (const mk of P.markers) { const x = X(mk.t); if (x < -2 || x > TW + 2) continue; g.fillStyle = mk.beat ? 'rgba(76,201,240,.18)' : 'rgba(255,209,102,.35)'; g.fillRect(Math.round(x), RULER, 1, TH); }
  // blade preview
  if (UI.tool === 'blade' && UI.bladeT != null) { const x = Math.round(X(UI.bladeT)) + .5; g.strokeStyle = '#ff4d5e'; g.setLineDash([4, 3]); g.beginPath(); g.moveTo(x, RULER); g.lineTo(x, TH); g.stroke(); g.setLineDash([]); }
  if (d && d.type === 'marquee') { const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1); g.fillStyle = 'rgba(255,138,61,.1)'; g.strokeStyle = 'rgba(255,138,61,.8)'; g.fillRect(x, y, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0)); g.strokeRect(x + .5, y + .5, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0)); }
  g.restore();
  drawRuler(g, tk, end);
  // snap line
  if (UI.snapLine != null && d) { const x = Math.round(X(UI.snapLine)) + .5; g.strokeStyle = '#ffd166'; g.lineWidth = 1; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, TH); g.stroke(); }
  // info bubble
  if (UI.info && d) {
    g.font = '600 11px "Segoe UI",sans-serif'; const w = g.measureText(UI.info).width + 14;
    const x = clamp(d.mx + 14, 2, TW - w - 2), y = clamp(d.my - 30, RULER + 2, TH - 30);
    g.fillStyle = 'rgba(20,22,27,.95)'; g.strokeStyle = '#ff8a3d'; g.beginPath(); g.roundRect(x, y, w, 20, 4); g.fill(); g.stroke();
    g.fillStyle = '#fff'; g.fillText(UI.info, x + 7, y + 14);
  }
  // scrollbar
  const cl = contentLen(), sw = Math.max(30, TW * TW / (cl * UI.pps)), sxp = (UI.sx / (cl * UI.pps)) * TW;
  g.fillStyle = '#0c0d10'; g.fillRect(0, TH - SBH, TW, SBH);
  g.fillStyle = (d && d.type === 'sb') ? '#4a5163' : '#2d3240'; g.beginPath(); g.roundRect(sxp + 1, TH - SBH + 2, sw - 2, SBH - 4, 4); g.fill();
}
function drawRuler(g, tk, end) {
  g.fillStyle = '#181b21'; g.fillRect(0, 0, TW, RULER); g.fillStyle = '#0b0c0f'; g.fillRect(0, RULER - 1, TW, 1);
  if (P.inPt != null || P.outPt != null) {
    const a = X(P.inPt ?? 0), b = X(P.outPt ?? end);
    g.fillStyle = 'rgba(76,201,240,.28)'; g.fillRect(a, RULER - 7, b - a, 6);
    g.fillStyle = '#4cc9f0'; if (P.inPt != null) g.fillRect(a, RULER - 12, 2, 11); if (P.outPt != null) g.fillRect(b - 2, RULER - 12, 2, 11);
  }
  g.fillStyle = '#4b5263';
  const t0 = Math.floor(T(0) / tk.minor) * tk.minor;
  for (let t = t0; X(t) < TW; t += tk.minor) { const x = Math.round(X(t)); const maj = Math.abs(t / tk.major - Math.round(t / tk.major)) < 1e-6; g.fillRect(x, maj ? 12 : 19, 1, maj ? RULER - 13 : RULER - 20); }
  g.fillStyle = '#8a92a2'; g.font = '10px ui-monospace,Consolas,monospace';
  for (let t = Math.floor(T(0) / tk.major) * tk.major; X(t) < TW; t += tk.major) {
    if (t < -EPS) continue;
    const lab = tk.major < 1 ? fmtTC(t) : (t >= 3600 ? Math.floor(t / 3600) + ':' : '') + String(Math.floor(t / 60) % 60).padStart(t >= 3600 ? 2 : 1, '0') + ':' + String(Math.round(t % 60) % 60).padStart(2, '0');
    g.fillText(lab, Math.round(X(t)) + 4, 10);
  }
  for (const mk of P.markers) {
    const x = Math.round(X(mk.t)); if (x < -8 || x > TW + 8) continue;
    if (mk.beat) { g.fillStyle = '#4cc9f0'; g.fillRect(x, RULER - 8, 1, 7); g.fillRect(x - 1, RULER - 3, 3, 2); }
    else { g.fillStyle = mk.color || '#ffd166'; g.beginPath(); g.moveTo(x - 5, 13); g.lineTo(x + 5, 13); g.lineTo(x + 5, 19); g.lineTo(x, 24); g.lineTo(x - 5, 19); g.closePath(); g.fill(); if (mk.name) { g.font = '600 10px "Segoe UI",sans-serif'; g.fillText(mk.name, x + 8, 22); } }
  }
}
function drawWaveTL(g, m, c, x0, x1, top, hh, col, mirror = true) {
  if (!m || !m.peaks) return;
  const d = m.peaks.data, r = m.peaks.rate, a = Math.max(0, x0), b = Math.min(TW, x1), vol = Math.min(2, c.volume ?? 1);
  g.fillStyle = col; g.beginPath();
  const mid = mirror ? top + hh / 2 : top + hh;
  for (let px = Math.floor(a); px < b; px++) {
    const st = c.in + (px - x0) / UI.pps * c.speed, st1 = st + c.speed / UI.pps;
    let i0 = Math.max(0, Math.floor(st * r)), i1 = Math.max(i0 + 1, Math.ceil(st1 * r)), pk = 0;
    for (let i = i0; i < i1 && i < d.length; i++) if (d[i] > pk) pk = d[i];
    const tt = c.start + (px - x0) / UI.pps; let fm = 1;
    if (c.fadeIn > 0 && tt - c.start < c.fadeIn) fm = (tt - c.start) / c.fadeIn;
    if (c.fadeOut > 0 && cend(c) - tt < c.fadeOut) fm = Math.min(fm, (cend(c) - tt) / c.fadeOut);
    const v = Math.min(1, Math.pow(pk, 0.7) * vol * fm) * (mirror ? hh / 2 : hh);
    if (mirror) g.rect(px, mid - v, 1, Math.max(1, v * 2)); else g.rect(px, mid - v, 1, Math.max(1, v));
  }
  g.fill();
}
function drawClipTL(g, c, lay) {
  const x0 = X(c.start), x1 = X(cend(c)); if (x1 < -2 || x0 > TW + 2) return;
  const y = lay.y + 2, hh = lay.h - 4, w = Math.max(1, x1 - x0);
  const m = c.media ? media.get(c.media) : null, off = c.media && (!m || m.offline);
  const col = KCOL[c.kind] || KCOL.video, sel = UI.sel.has(c.id), tr = lay.tr;
  g.save(); g.beginPath(); g.roundRect(x0 + .5, y, w - 1, hh, 4); g.clip();
  g.fillStyle = col[0]; g.fillRect(x0, y, w, hh);
  const HB = hh > 30 ? 14 : 0, cy = y + HB, ch = hh - HB;
  if (off) {
    g.fillStyle = '#3a0d14'; g.fillRect(x0, y, w, hh); g.strokeStyle = 'rgba(255,77,94,.3)'; g.lineWidth = 4;
    for (let x = x0 - hh; x < x1; x += 12) { g.beginPath(); g.moveTo(x, y + hh); g.lineTo(x + hh, y); g.stroke(); }
  } else if ((c.kind === 'video' || c.kind === 'image') && m && m.thumbs && m.thumbs.length && ch > 8) {
    const th0 = m.thumbs[0].c, tw = Math.max(16, ch * th0.width / th0.height);
    const k0 = Math.max(0, Math.floor((0 - x0) / tw));
    for (let k = k0; ; k++) {
      const tx = x0 + k * tw; if (tx > Math.min(x1, TW)) break;
      let th = m.thumbs[0];
      if (c.kind === 'video' && m.thumbs.length > 1) {
        const st = c.in + ((tx - x0 + tw / 2) / UI.pps) * c.speed;
        th = m.thumbs[clamp(Math.round(st / m.duration * m.thumbs.length - 0.5), 0, m.thumbs.length - 1)];
      }
      g.globalAlpha = 0.85; g.drawImage(th.c, tx, cy, tw, ch); g.globalAlpha = 1;
      g.fillStyle = 'rgba(0,0,0,.25)'; g.fillRect(tx + tw - 1, cy, 1, ch);
    }
    if (c.kind === 'video' && m.peaks && ch > 26 && !c.muted) { g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(x0, y + hh - ch * 0.32, w, ch * 0.32); drawWaveTL(g, m, c, x0, x1, y + hh - ch * 0.32, ch * 0.32, 'rgba(120,220,170,.75)', false); }
  } else if (c.kind === 'audio') {
    drawWaveTL(g, m, c, x0, x1, cy + 2, ch - 4, c.muted ? 'rgba(150,150,150,.4)' : 'rgba(110,230,170,.85)');
  } else if (c.kind === 'text') {
    g.fillStyle = 'rgba(255,255,255,.8)'; g.font = '700 12px "Segoe UI",sans-serif';
    g.fillText('T  ' + (c.text.str || '').replace(/\n/g, ' '), Math.max(x0, 0) + 6, cy + ch / 2 + 4);
  } else if (c.kind === 'color') {
    g.fillStyle = c.color; g.fillRect(x0 + 4, cy + 3, Math.min(60, w - 8), ch - 6);
  }
  if (HB) {
    g.fillStyle = c.label ? LABELS[c.label] : col[1]; g.fillRect(x0, y, w, HB);
    g.fillStyle = '#fff'; g.font = '600 10.5px "Segoe UI",sans-serif';
    let lab = (c.speed !== 1 ? c.speed + '× · ' : '') + (c.muted ? '[muted] ' : '') + (c.name || c.kind);
    if (w > 70) lab += '  ' + fmtS(cdur(c));
    // proxy being built: the part of the clip it already covers lights up, left to right
    const ps = c.kind === 'video' && m && m.proxyState;
    if (ps && /building|queued/.test(ps.status)) {
      const xb = clamp(x0 + (ps.p * m.duration - c.in) / c.speed * UI.pps, x0, x1);
      g.fillStyle = 'rgba(255,255,255,.22)'; g.fillRect(x0, y, xb - x0, HB);
      g.fillStyle = '#9ff0c4'; g.fillRect(x0, y + HB - 2, xb - x0, 2);
      const pt = ps.status === 'queued' ? 'proxy queued' : `proxy ${Math.floor(ps.p * 100)}%`;
      g.font = '600 10px "Segoe UI",sans-serif'; const pw = g.measureText(pt).width;
      if (w > pw + 80) { g.fillStyle = '#9ff0c4'; g.fillText(pt, Math.min(x1, TW) - pw - 6, y + 11); }
      g.fillStyle = '#fff'; g.font = '600 10.5px "Segoe UI",sans-serif';
    }
    g.fillText(lab, Math.max(x0, 0) + 5, y + 11);
  }
  // fades
  const fi = (c.fadeIn || 0) * UI.pps, fo = (c.fadeOut || 0) * UI.pps;
  g.strokeStyle = 'rgba(255,255,255,.75)'; g.lineWidth = 1.2;
  if (fi > 0.5) { g.fillStyle = 'rgba(0,0,0,.42)'; g.beginPath(); g.moveTo(x0, y); g.lineTo(x0 + fi, y); g.lineTo(x0, y + hh); g.closePath(); g.fill(); g.beginPath(); g.moveTo(x0, y + hh); g.lineTo(x0 + fi, y); g.stroke(); }
  if (fo > 0.5) { g.fillStyle = 'rgba(0,0,0,.42)'; g.beginPath(); g.moveTo(x1, y); g.lineTo(x1 - fo, y); g.lineTo(x1, y + hh); g.closePath(); g.fill(); g.beginPath(); g.moveTo(x1, y + hh); g.lineTo(x1 - fo, y); g.stroke(); }
  if ((tr.type === 'video' && tr.hidden) || tr.muted && c.kind === 'audio') { g.fillStyle = 'rgba(16,18,22,.6)'; g.fillRect(x0, y, w, hh); }
  if (UI.drag && UI.drag.type === 'move' && UI.drag.ids.has(c.id) && UI.drag.moved) { g.fillStyle = 'rgba(255,255,255,.08)'; g.fillRect(x0, y, w, hh); }
  g.restore();
  g.lineWidth = sel ? 2 : 1; g.strokeStyle = sel ? '#ffb27a' : 'rgba(0,0,0,.7)';
  g.beginPath(); g.roundRect(x0 + (sel ? 1 : .5), y + (sel ? .5 : 0), w - (sel ? 2 : 1), hh - (sel ? 1 : 0), 4); g.stroke();
  const hov = UI.hover && UI.hover.c === c;
  if ((sel || hov) && w > 24 && UI.tool === 'select') {
    g.fillStyle = '#fff'; g.strokeStyle = '#000'; g.lineWidth = 1;
    for (const hx of [x0 + Math.max(fi, 5), x1 - Math.max(fo, 5)]) { g.beginPath(); g.arc(hx, y + 5, 3.5, 0, Math.PI * 2); g.fill(); g.stroke(); }
  }
}
function drawOverlaps(g, cs, lay) {
  for (let i = 0; i < cs.length - 1; i++) {
    const A = cs[i], B = cs[i + 1], e = Math.min(cend(A), cend(B)); if (B.start >= e - EPS) continue;
    const a = X(B.start), b = X(e); if (b < 0 || a > TW) continue;
    const y = lay.y + 2, hh = lay.h - 4, sel = UI.selXf === B.id, hov = UI.hover && UI.hover.zone === 'xf' && UI.hover.B === B;
    g.fillStyle = sel ? 'rgba(255,160,80,.5)' : hov ? 'rgba(255,200,120,.36)' : 'rgba(255,200,120,.24)'; g.fillRect(a, y, b - a, hh);
    g.strokeStyle = sel ? '#ffe0c4' : 'rgba(255,225,180,.8)'; g.lineWidth = 1.2;
    g.beginPath(); g.moveTo(a, y + hh); g.lineTo(b, y); g.moveTo(a, y); g.lineTo(b, y + hh); g.stroke();
    g.strokeRect(a + .5, y + .5, b - a - 1, hh - 1);
    if (b - a > 54) {
      const lab = XF_SHORT[(B.xf || xfDefault()).type] + ' ' + fmtS(e - B.start);
      g.font = '700 10px "Segoe UI",sans-serif'; const tw = g.measureText(lab).width + 8;
      if (tw < b - a - 4) { g.fillStyle = 'rgba(20,14,8,.85)'; g.fillRect((a + b) / 2 - tw / 2, y + hh / 2 - 7, tw, 14); g.fillStyle = '#ffd2b3'; g.fillText(lab, (a + b) / 2 - tw / 2 + 4, y + hh / 2 + 3.5); }
    }
  }
}
/* ---------- heads ---------- */
const ICON = {
  eye: '<svg class="i" viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg class="i" viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6C3.8 8.3 2 12 2 12s3.6 7 10 7c1.8 0 3.3-.5 4.6-1.3"/></svg>',
  spk: '<svg class="i" viewBox="0 0 24 24"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/></svg>',
  mute: '<svg class="i" viewBox="0 0 24 24"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="m22 9-6 6M16 9l6 6"/></svg>',
  lock: '<svg class="i" viewBox="0 0 24 24"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  unlock: '<svg class="i" viewBox="0 0 24 24"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.8-1"/></svg>',
};
function renderHeads() {
  ensureTargets();
  const inner = $('#headInner'); inner.innerHTML = '';
  for (const tr of P.tracks) {
    const isT = tr.id === (tr.type === 'video' ? UI.targetV : UI.targetA);
    const tb = (key, on, iconOn, iconOff, title, red) => h('button', { class: (on ? 'on' : '') + (red ? ' red' : ''), title, html: on ? iconOn : iconOff, onclick: () => { edit(() => { tr[key] = !tr[key]; }); renderHeads(); } });
    const row = h('div', { class: 'th ' + tr.type + (isT ? ' target' : ''), style: `height:${tH(tr)}px` },
      h('button', { class: 'tname', title: 'Target track — inserts, titles and pastes go here', onclick: () => { if (tr.type === 'video') UI.targetV = tr.id; else UI.targetA = tr.id; renderHeads(); } }, tr.name),
      h('div', { class: 'tbtns' },
        tr.type === 'video' ? tb('hidden', tr.hidden, ICON.eyeOff, ICON.eye, 'Hide track output', true) : null,
        tb('muted', tr.muted, ICON.mute, ICON.spk, 'Mute track audio', true),
        tr.type === 'audio' ? h('button', { class: tr.solo ? 'on' : '', title: 'Solo', style: 'font-weight:800;font-size:11px;width:22px', onclick: () => { edit(() => { tr.solo = !tr.solo; }); renderHeads(); } }, 'S') : null,
        tb('locked', tr.locked, ICON.lock, ICON.unlock, 'Lock track', false)));
    row.addEventListener('contextmenu', e => { e.preventDefault(); trackMenu(e.clientX, e.clientY, tr); });
    inner.append(row);
  }
  syncHeads();
}
function syncHeads() { $('#headInner').style.transform = `translateY(${-UI.sy}px)`; }

/* ---------- hit testing ---------- */
function laneAt(y) { const L = layout(); return L.find(l => y >= l.y && y < l.y + l.h) || null; }
function trackIndexAtY(y) { const L = layout(); if (!L.length) return -1; if (y < L[0].y) return 0; for (let i = 0; i < L.length; i++) if (y < L[i].y + L[i].h) return i; return L.length - 1; }
function hit(x, y) {
  if (y >= TH - SBH) return { zone: 'sb' };
  if (y < RULER) { for (const mk of P.markers) if (!mk.beat && Math.abs(X(mk.t) - x) <= 5 && y > 10) return { zone: 'marker', mk }; return { zone: 'ruler' }; }
  const lay = laneAt(y); if (!lay) return { zone: 'empty' };
  const tr = lay.tr, cs = clipsOn(tr.id), t = T(x), base = { track: tr, lay, t };
  if (tr.locked) return { ...base, zone: 'locked' };
  if (UI.tool === 'select') {
    if (y < lay.y + 14) for (const c of cs) {
      const x0 = X(c.start), x1 = X(cend(c)); if (x1 - x0 < 24) continue;
      const fi = x0 + Math.max((c.fadeIn || 0) * UI.pps, 5), fo = x1 - Math.max((c.fadeOut || 0) * UI.pps, 5);
      if (Math.abs(x - fi) <= 5 && x >= x0) return { ...base, zone: 'fadeIn', c };
      if (Math.abs(x - fo) <= 5 && x <= x1) return { ...base, zone: 'fadeOut', c };
    }
    let best = null;
    for (const c of cs) {
      const x0 = X(c.start), x1 = X(cend(c)), z = Math.min(7, Math.max(2, (x1 - x0) / 4));
      if (x >= x0 - z && x <= x0 + z) { const d = Math.abs(x - x0) - (x >= x0 ? 0.5 : 0); if (!best || d < best.d) best = { d, zone: 'trimL', c }; }
      if (x >= x1 - z && x <= x1 + z) { const d = Math.abs(x - x1) - (x <= x1 ? 0.5 : 0); if (!best || d < best.d) best = { d, zone: 'trimR', c }; }
    }
    if (best) {
      const c = best.c, f2 = frame() * 0.6;
      const partner = best.zone === 'trimR' ? cs.find(o => o !== c && Math.abs(o.start - cend(c)) < f2) : cs.find(o => o !== c && Math.abs(cend(o) - c.start) < f2);
      return { ...base, zone: best.zone, c, partner };
    }
    for (let i = 0; i < cs.length - 1; i++) { const A = cs[i], B = cs[i + 1]; if (B.start < cend(A) - EPS && t >= B.start && t <= cend(A)) return { ...base, zone: 'xf', A, B, c: B }; }
  }
  let hc = null; for (const c of cs) if (t >= c.start && t < cend(c)) hc = c;
  if (hc) return { ...base, zone: 'clip', c: hc };
  return { ...base, zone: 'lane' };
}
const HINTS = {
  clip: 'Drag to move · Alt+drag duplicates · hold Ctrl on drop to insert · Shift skips snapping · drop onto another clip to cross-fade',
  trimL: 'Drag to trim the start', trimR: 'Drag to trim the end',
  fadeIn: 'Drag to set fade-in (video and audio)', fadeOut: 'Drag to set fade-out (video and audio)',
  xf: 'Transition — click to edit, right-click for types, Delete makes it a hard cut',
  ruler: 'Click or drag to scrub · M marker · I / O set range', marker: 'Click to jump · drag to move · double-click to rename · right-click to delete',
  lane: 'Drag to box-select · right-click for gap tools', locked: 'Track is locked', sb: 'Drag to scroll',
};
function setHint(s) { const el = $('#hint'); if (el.textContent !== s) el.textContent = s; }
function hoverUpdate(x, y) {
  const H = hit(x, y); UI.hover = H;
  let cur = 'default', hint = HINTS[H.zone] || '';
  if (UI.tool === 'blade' && H.c) { cur = 'crosshair'; UI.bladeT = snapT(T(x), snapTargets(null)).t; hint = 'Click to cut · Shift+click cuts all tracks'; }
  else { UI.bladeT = null; }
  if (UI.tool === 'slip' && H.c) { cur = 'ew-resize'; hint = 'Drag to slip the source in/out (clip stays put)'; }
  if (UI.tool === 'select') switch (H.zone) {
    case 'clip': cur = 'grab'; break; case 'xf': cur = 'pointer'; break;
    case 'trimL': case 'trimR': cur = H.partner ? 'col-resize' : 'ew-resize'; if (H.partner) hint += ' · Alt+drag rolls the cut (both clips)'; if (UI.ripple) hint += ' · ripple on'; else if (UI.autoX) hint += ' · drag over the neighbour to cross-fade'; break;
    case 'fadeIn': case 'fadeOut': cur = 'ew-resize'; break;
  }
  if (H.zone === 'ruler' || H.zone === 'marker') cur = 'pointer';
  tl.style.cursor = cur; setHint(hint); dirtyTL = true;
}

/* ---------- snapping ---------- */
function snapTargets(exclude, withPlayhead = true) {
  const s = [0]; if (withPlayhead) s.push(UI.t);
  if (P.inPt != null) s.push(P.inPt); if (P.outPt != null) s.push(P.outPt);
  for (const m of P.markers) s.push(m.t);
  for (const c of P.clips) { if (exclude && exclude.has(c.id)) continue; s.push(c.start, cend(c)); }
  return s;
}
let noSnap = false;
function snapT(t, targets) {
  if (!UI.snap || noSnap) return { t, hit: false };
  const th = 8 / UI.pps; let best = null, bd = th;
  for (const s of targets) { const d = Math.abs(s - t); if (d < bd) { bd = d; best = s; } }
  return best == null ? { t, hit: false } : { t: best, hit: true };
}

/* ---------- pointer interactions ---------- */
function ptr(e) { const r = tl.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
tl.addEventListener('pointerdown', e => {
  ensureAudio(); hideMenu();
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  const { x, y } = ptr(e);
  if (e.button === 1) { e.preventDefault(); UI.drag = { type: 'pan', x0: x, y0: y, sx: UI.sx, sy: UI.sy, mx: x, my: y }; try { tl.setPointerCapture(e.pointerId); } catch (_) { } return; }
  if (e.button !== 0) return;
  if (UI.mode === 'source') setMode('timeline');
  try { tl.setPointerCapture(e.pointerId); } catch (_) { }
  const H = hit(x, y), before = snapState();
  const base = { x0: x, y0: y, mx: x, my: y, before, moved: false };
  noSnap = e.shiftKey;
  switch (H.zone) {
    case 'sb': {
      const cl = contentLen(), sw = Math.max(30, TW * TW / (cl * UI.pps)), sxp = (UI.sx / (cl * UI.pps)) * TW;
      if (x < sxp || x > sxp + sw) UI.sx = Math.max(0, (x - sw / 2) / TW * cl * UI.pps);
      UI.drag = { ...base, type: 'sb', sx: UI.sx, cl }; break;
    }
    case 'ruler': UI.drag = { ...base, type: 'scrub' }; scrubTo(x); break;
    case 'marker': UI.drag = { ...base, type: 'marker', mk: H.mk, t0: H.mk.t }; break;
    case 'fadeIn': case 'fadeOut': selectOnly(H.c); UI.drag = { ...base, type: H.zone, c: H.c }; break;
    case 'trimL': case 'trimR': {
      const c = H.c; selectOnly(c);
      const o = { start: c.start, in: c.in, out: c.out, end: cend(c) };
      const roll = e.altKey && H.partner ? H.partner : null;
      const others = clipsOn(c.track).filter(x => x !== c && x !== roll);
      const after = UI.ripple && !roll ? others.filter(x => x.start > o.start + EPS).map(x => ({ c: x, s0: x.start })) : null;
      UI.drag = { ...base, type: H.zone, c, o, roll, ro: roll ? { start: roll.start, in: roll.in, out: roll.out } : null, after, lim: trimLimits(c, others, o), targets: snapTargets(new Set([c.id, roll && roll.id])) };
      break;
    }
    case 'xf': UI.selXf = H.B.id; UI.sel.clear(); renderInsp(); UI.drag = { ...base, type: 'pendMove', c: H.B, alt: e.altKey }; break;
    case 'clip': {
      const c = H.c;
      if (UI.tool === 'blade') { const t = snapT(T(x), snapTargets(null)).t; edit(() => cutAt(q(t), e.shiftKey ? null : [c]), n => n ? `Cut ${n} clip${n > 1 ? 's' : ''}` : ''); return; }
      if (UI.tool === 'slip') { selectOnly(c); UI.drag = { ...base, type: 'slip', c, o: { in: c.in, out: c.out }, t0: T(x) }; break; }
      UI.selXf = null;
      if (e.shiftKey || e.ctrlKey || e.metaKey) { if (UI.sel.has(c.id)) UI.sel.delete(c.id); else UI.sel.add(c.id); renderInsp(); if (!UI.sel.has(c.id)) { UI.drag = null; return; } }
      else if (!UI.sel.has(c.id)) { UI.sel = new Set([c.id]); renderInsp(); }
      UI.drag = { ...base, type: 'pendMove', c, alt: e.altKey, clickOnly: !(e.shiftKey || e.ctrlKey) };
      break;
    }
    default: {
      if (!e.shiftKey) { UI.sel.clear(); UI.selXf = null; renderInsp(); }
      UI.drag = { ...base, type: 'marquee', x1: x, y1: y, base: new Set(UI.sel) };
    }
  }
  dirtyTL = true;
});
function trimLimits(c, others, o) {
  // how far the edges may travel without creating an illegal overlap
  const before = others.filter(x => x.start < o.start - EPS).sort((a, b) => cend(a) - cend(b));
  const after = others.filter(x => x.start > o.start + EPS).sort((a, b) => a.start - b.start);
  const pv = before[before.length - 1], pv2 = before[before.length - 2], nx = after[0], nx2 = after[1];
  let minStart = 0, maxEnd = Infinity;
  if (UI.autoX) {
    if (pv) minStart = Math.max(minStart, pv.start + frame(), pv2 ? cend(pv2) : 0);
    if (nx) maxEnd = Math.min(cend(nx) - frame(), nx2 ? nx2.start : Infinity);
  } else {
    for (const b of before) minStart = Math.max(minStart, cend(b));
    if (nx) maxEnd = nx.start;
  }
  if (UI.ripple) maxEnd = Infinity;
  return { minStart: Math.min(minStart, o.start), maxEnd: Math.max(maxEnd, o.end) };
}
function scrubTo(x) {
  let t = Math.max(0, T(x));
  const s = snapT(t, snapTargets(null, false)); t = s.hit ? s.t : q(t);
  UI.snapLine = s.hit ? s.t : null; setTime(t);
}
tl.addEventListener('pointermove', e => {
  const { x, y } = ptr(e), d = UI.drag;
  if (!d) { hoverUpdate(x, y); return; }
  d.mx = x; d.my = y; noSnap = e.shiftKey;
  if (Math.abs(x - d.x0) > 3 || Math.abs(y - d.y0) > 3) d.moved = true;
  UI.info = null;
  switch (d.type) {
    case 'pan': UI.sx = Math.max(0, d.sx - (x - d.x0)); UI.sy = d.sy - (y - d.y0); clampScroll(); syncHeads(); break;
    case 'sb': UI.sx = Math.max(0, d.sx + (x - d.x0) / TW * d.cl * UI.pps); break;
    case 'scrub': autoScroll(x); scrubTo(x); break;
    case 'marker': { let t = Math.max(0, T(x)); const s = snapT(t, snapTargets(null).filter(v => Math.abs(v - d.t0) > EPS)); d.mk.t = s.hit ? s.t : q(t); UI.snapLine = s.hit ? s.t : null; break; }
    case 'fadeIn': case 'fadeOut': {
      const c = d.c, len = cdur(c);
      if (d.type === 'fadeIn') c.fadeIn = clamp(q(T(x) - c.start), 0, len - (c.fadeOut || 0));
      else c.fadeOut = clamp(q(cend(c) - T(x)), 0, len - (c.fadeIn || 0));
      UI.info = (d.type === 'fadeIn' ? 'Fade in ' : 'Fade out ') + fmtS(d.type === 'fadeIn' ? c.fadeIn : c.fadeOut);
      dirtyPV = true; break;
    }
    case 'trimL': case 'trimR': doTrim(d, x); break;
    case 'slip': {
      const c = d.c, L = srcLen(c), len = d.o.out - d.o.in;
      if (!isFinite(L)) { UI.info = 'Stills have nothing to slip'; break; }
      const ni = clamp(d.o.in - (T(x) - d.t0) * c.speed, 0, Math.max(0, L - len));
      c.in = ni; c.out = ni + len; UI.info = 'Source in ' + fmtTC(ni) + ' · out ' + fmtTC(c.out);
      syncMedia(UI.t, false); dirtyPV = true; break;
    }
    case 'pendMove': if (d.moved) startMove(d, e); break;
    case 'move': doMove(d, x, y, e); break;
    case 'marquee': {
      d.x1 = x; d.y1 = y; autoScroll(x);
      const ta = T(Math.min(d.x0, x)), tb = T(Math.max(d.x0, x)), ya = Math.min(d.y0, y), yb = Math.max(d.y0, y);
      const sel = new Set(d.base);
      for (const lay of layout()) { if (lay.y + lay.h < ya || lay.y > yb || lay.tr.locked) continue; for (const c of clipsOn(lay.tr.id)) if (cend(c) > ta && c.start < tb) sel.add(c.id); }
      UI.sel = sel; break;
    }
  }
  dirtyTL = true;
});
tl.addEventListener('pointerup', e => endDrag(e));
tl.addEventListener('pointercancel', e => endDrag(e, true));
function endDrag(e, cancel) {
  const d = UI.drag; if (!d) return;
  UI.drag = null; UI.snapLine = null; UI.info = null; noSnap = false;
  try { tl.releasePointerCapture(e.pointerId); } catch (_) { }
  if (cancel) { loadState(d.before); afterRestore(); return; }
  switch (d.type) {
    case 'pendMove': if (d.clickOnly && UI.sel.size > 1 && UI.sel.has(d.c.id) && !UI.selXf) { UI.sel = new Set([d.c.id]); renderInsp(); } break;
    case 'move': {
      const ids = d.items.map(i => i.c.id);
      const mode = (e.ctrlKey || e.metaKey) ? 'insert' : UI.autoX ? 'xfade' : 'overwrite';
      const r = resolveDrop(ids, mode);
      if (commit(d.before)) { if (r === 'insert') toast('Inserted'); else if (r === 'xfade' && ids.some(id => { const c = clipById(id); if (!c) return false; const [p, n] = neighbors(c); return (p && cend(p) > c.start + EPS) || (n && n.start < cend(c) - EPS); })) toast('Cross-fade created'); }
      break;
    }
    case 'marker': if (!d.moved) { setTime(d.mk.t); } else commit(d.before); break;
    case 'trimL': case 'trimR': case 'fadeIn': case 'fadeOut': case 'slip':
      if (UI.autoX) ensureXf([d.c.track]); commit(d.before); break;
  }
  changed();
  hoverUpdate(d.mx, d.my);
}
function autoScroll(x) { if (x > TW - 24) UI.sx += (x - (TW - 24)) * 0.6; else if (x < 24 && UI.sx > 0) UI.sx = Math.max(0, UI.sx - (24 - x) * 0.6); }
function selectOnly(c) { UI.selXf = null; if (!UI.sel.has(c.id) || UI.sel.size > 1) { UI.sel = new Set([c.id]); renderInsp(); } }
function startMove(d, e) {
  let cs = selClips().filter(c => !trackOf(c).locked);
  if (!cs.includes(d.c)) cs = [d.c];
  if (d.alt) { // duplicate and drag the copies
    const copies = cs.map(c => { const n = structuredClone(c); n.id = uid('c'); P.clips.push(n); return n; });
    UI.sel = new Set(copies.map(c => c.id)); d.c = copies[cs.indexOf(d.c)]; cs = copies;
  }
  d.type = 'move';
  d.items = cs.map(c => ({ c, s0: c.start, dur: cdur(c), ti0: trackIdx(c.track) }));
  d.ids = new Set(cs.map(c => c.id));
  d.t0 = T(d.x0); d.ti0 = trackIndexAtY(d.y0); d.minS0 = Math.min(...d.items.map(i => i.s0));
  d.targets = snapTargets(d.ids);
  UI.selXf = null;
}
function doMove(d, x, y, e) {
  autoScroll(x);
  const raw = T(x) - d.t0; let dt = raw; UI.snapLine = null;
  if (UI.snap && !e.shiftKey) {
    const th = 8 / UI.pps; let best = null;
    for (const it of d.items) for (const edge of [it.s0, it.s0 + it.dur]) {
      const want = edge + raw;
      for (const s of d.targets) { const dd = s - want; if (Math.abs(dd) < th && (!best || Math.abs(dd) < Math.abs(best.dd))) best = { dd, s }; }
    }
    if (best) { dt = raw + best.dd; UI.snapLine = best.s; }
  }
  dt = Math.max(dt, -d.minS0);
  let dti = trackIndexAtY(y) - d.ti0;
  const okT = k => d.items.every(it => { const tr = P.tracks[it.ti0 + k]; return tr && !tr.locked && (tr.type === 'audio') === (it.c.kind === 'audio'); });
  if (!okT(dti)) dti = okT(d.lastDti || 0) ? (d.lastDti || 0) : 0;
  d.lastDti = dti;
  for (const it of d.items) { it.c.start = UI.snapLine != null ? it.s0 + dt : q(it.s0 + dt); it.c.track = P.tracks[it.ti0 + dti].id; }
  d.insert = e.ctrlKey || e.metaKey;
  const delta = dt;
  UI.info = (delta >= 0 ? '+' : '−') + fmtTC(Math.abs(delta)) + '  @ ' + fmtTC(d.c.start) + (d.insert ? '  · insert' : '');
  setHint(d.insert ? 'Release to INSERT (pushes later clips right)' : UI.autoX ? 'Release: overlaps become cross-fades · red = will be replaced · Ctrl inserts' : 'Release to overwrite (red parts get replaced) · Ctrl inserts');
  syncMedia(UI.t, false); dirtyPV = true;
}
function doTrim(d, x) {
  const c = d.c, o = d.o, sp = c.speed, L = srcLen(c);
  let t = T(x); const s = snapT(t, d.targets); t = s.hit ? s.t : q(t); UI.snapLine = s.hit ? s.t : null;
  if (d.type === 'trimR') {
    let ne = clamp(t, o.start + frame(), d.lim.maxEnd);
    if (o.in + (ne - o.start) * sp > L) ne = o.start + (L - o.in) / sp;
    if (d.roll) { const B = d.roll, bo = d.ro; const minE = bo.start - bo.in / B.speed, maxE = bo.start + (bo.out - bo.in) / B.speed - frame(); ne = clamp(ne, Math.max(minE, o.start + frame()), maxE); B.start = ne; B.in = bo.in + (ne - bo.start) * B.speed; }
    c.out = o.in + (ne - o.start) * sp;
    if (d.after) { const delta = cend(c) - o.end; for (const a of d.after) a.c.start = a.s0 + delta; }
  } else {
    let ns = clamp(t, d.lim.minStart, o.end - frame());
    if (isFinite(L) && o.in + (ns - o.start) * sp < 0) ns = o.start - o.in / sp;
    ns = Math.max(0, ns);
    if (d.roll) { const A = d.roll, ao = d.ro; const LA = srcLen(A); const minS = ao.start + frame(), maxS = isFinite(LA) ? ao.start + (LA - ao.in) / A.speed : Infinity; ns = clamp(ns, minS, Math.min(maxS, o.end - frame())); A.out = ao.in + (ns - ao.start) * A.speed; }
    const nin = o.in + (ns - o.start) * sp;
    if (d.after) { c.start = o.start; c.in = nin; const delta = -(ns - o.start); for (const a of d.after) a.c.start = a.s0 + delta; }
    else { c.start = ns; c.in = nin; }
  }
  c.fadeIn = Math.min(c.fadeIn || 0, cdur(c)); c.fadeOut = Math.min(c.fadeOut || 0, cdur(c) - (c.fadeIn || 0));
  if (!d.after && !d.roll && !trackValid(c.track)) { if (d.last) Object.assign(c, d.last); }
  else d.last = { start: c.start, in: c.in, out: c.out };
  const delta = d.type === 'trimR' ? cend(c) - o.end : c.start - o.start;
  UI.info = (d.roll ? 'Roll ' : 'Trim ') + (delta >= 0 ? '+' : '−') + fmtTC(Math.abs(delta)) + '  → ' + fmtS(cdur(c));
  syncMedia(UI.t, false); dirtyPV = true;
}
tl.addEventListener('dblclick', e => {
  const { x, y } = ptr(e), H = hit(x, y);
  if (H.zone === 'marker') { const n = prompt('Marker name', H.mk.name || ''); if (n != null) edit(() => { H.mk.name = n; }); }
  else if (H.zone === 'clip' && H.c.kind === 'text') { setTime(Math.max(UI.t, H.c.start)); setTimeout(() => { const ta = $('#inspBody textarea'); if (ta) { ta.focus(); ta.select(); } }, 30); }
  else if (H.zone === 'clip' && H.c.media) { const m = media.get(H.c.media); if (m && !m.offline) { m.markIn = H.c.in; m.markOut = H.c.out; openSource(m); srcSeek(H.c.in + (T(x) - H.c.start) * H.c.speed); } }
  else if (H.zone === 'ruler' || H.zone === 'lane') { /* nothing */ }
});
tl.addEventListener('wheel', e => {
  e.preventDefault(); hideMenu();
  const { x } = ptr(e);
  if (e.ctrlKey || e.metaKey) { setZoom(UI.pps * Math.pow(1.0018, -e.deltaY), x); return; }
  if (e.shiftKey || e.altKey) { UI.sy += e.deltaY; clampScroll(); syncHeads(); }
  else { UI.sx = Math.max(0, UI.sx + (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY)); }
  dirtyTL = true;
}, { passive: false });
$('#headView').addEventListener('wheel', e => { e.preventDefault(); UI.sy += e.deltaY; clampScroll(); syncHeads(); dirtyTL = true; }, { passive: false });
tl.addEventListener('pointerleave', () => { if (!UI.drag) { UI.hover = null; UI.bladeT = null; dirtyTL = true; setHint(''); } });

/* ---------- bin → timeline drag & drop ---------- */
tl.addEventListener('dragover', e => {
  e.preventDefault(); e.stopPropagation();
  const { x, y } = ptr(e), m = UI.dragMedia;
  if (!m) { e.dataTransfer.dropEffect = 'copy'; return; }
  e.dataTransfer.dropEffect = 'copy';
  UI.ghost = ghostFor(m, x, y, e.shiftKey); dirtyTL = true;
});
tl.addEventListener('dragleave', () => { UI.ghost = null; dirtyTL = true; });
function ghostFor(m, x, y, shift) {
  const fin = isFinite(m.duration), mi = fin ? (m.markIn || 0) : 0, mo = fin ? (m.markOut ?? m.duration) : P.settings.imgDur, dur = Math.max(frame(), mo - mi);
  const L = layout(); let ti = trackIndexAtY(y); const below = L.length && y > L[L.length - 1].y + L[L.length - 1].h;
  const want = m.type === 'audio' ? 'audio' : 'video';
  const tr = P.tracks[ti];
  if (below && m.type === 'audio') ti = -1; // drop under the last track → new audio track
  else if (!tr || tr.locked || (tr.type !== want && !(m.type === 'video' && tr.type === 'audio'))) {
    let bi = -1, bd = 1e9; P.tracks.forEach((t, i) => { if (t.type === want && !t.locked && Math.abs(i - ti) < bd) { bd = Math.abs(i - ti); bi = i; } }); ti = bi;
  }
  let start = Math.max(0, T(x));
  if (UI.snap && !shift) {
    const tg2 = snapTargets(null), th = 8 / UI.pps; let best = null;
    for (const edge of [start, start + dur]) for (const s of tg2) { const dd = s - edge; if (Math.abs(dd) < th && (!best || Math.abs(dd) < Math.abs(best))) best = dd; }
    if (best != null) start += best; else start = q(start);
  } else start = q(start);
  const kindTrack = ti >= 0 ? P.tracks[ti] : null;
  return { m, ti, start: Math.max(0, start), dur, name: m.name + (kindTrack && kindTrack.type === 'audio' && m.type === 'video' ? ' (audio only)' : ''), newType: ti < 0 ? want : null };
}
tl.addEventListener('drop', async e => {
  e.preventDefault(); e.stopPropagation(); $('#dropOverlay').hidden = true;
  const { x, y } = ptr(e);
  let list = [];
  if (UI.dragMedia) list = [UI.dragMedia];
  else if (e.dataTransfer.files && e.dataTransfer.files.length) list = await importFiles([...e.dataTransfer.files], { quiet: true });
  UI.dragMedia = null; UI.ghost = null;
  if (!list.length) return;
  const mode = (e.ctrlKey || e.metaKey) ? 'insert' : UI.autoX ? 'xfade' : 'overwrite';
  edit(() => {
    let at = null; const ids = [];
    for (const m of list) {
      const gh = ghostFor(m, x, y, e.shiftKey);
      let tid; if (gh.ti < 0) tid = addTrack(gh.newType || (m.type === 'audio' ? 'audio' : 'video')).id; else tid = P.tracks[gh.ti].id;
      const c = makeClip(m, tid, at == null ? gh.start : at);
      P.clips.push(c); ids.push(c.id); at = cend(c);
    }
    resolveDrop(ids, mode); UI.sel = new Set(ids); UI.selXf = null;
  }, list.length > 1 ? `Placed ${list.length} clips` : null);
  renderHeads(); renderBin();
});

/* ---------- edit commands ---------- */
function clipsUnderPlayhead(onlySel) {
  return P.clips.filter(c => !trackOf(c).locked && UI.t > c.start + EPS && UI.t < cend(c) - EPS && (!onlySel || UI.sel.has(c.id)));
}
function cutAt(t, list) {
  const cs = (list || P.clips.filter(c => !trackOf(c).locked)).filter(c => t > c.start + frame() * 0.5 && t < cend(c) - frame() * 0.5);
  for (const c of cs) splitClip(c, t);
  return cs.length;
}
function cmdSplit() {
  const t = q(UI.t); const selU = clipsUnderPlayhead(true);
  const list = selU.length ? selU : clipsUnderPlayhead(false);
  if (!list.length) return toast('Nothing under the playhead to split');
  edit(() => cutAt(t, list), n => `Split ${n} clip${n > 1 ? 's' : ''}`);
}
function cmdDelete(ripple) {
  if (UI.selXf) { const B = clipById(UI.selXf); const [A] = B ? neighbors(B) : []; if (A && B) { edit(() => removeXf(A, B), 'Transition removed (hard cut)'); UI.selXf = null; } return; }
  const cs = selClips().filter(c => !trackOf(c).locked); if (!cs.length) return;
  edit(() => {
    const byT = groupBy(cs, c => c.track);
    for (const [tid, arr] of byT) {
      arr.sort((a, b) => b.start - a.start);
      for (const c of arr) { const s = c.start, e = cend(c); removeClip(c); if (ripple) closeGapInRange(tid, s, e); }
    }
    UI.sel.clear();
  }, (ripple ? 'Ripple deleted ' : 'Deleted ') + cs.length + ' clip' + (cs.length > 1 ? 's' : ''));
}
function rippleTrimToPlayhead(side) {
  const t = q(UI.t); let list = clipsUnderPlayhead(true); if (!list.length) list = clipsUnderPlayhead(false);
  if (!list.length) return toast('Park the playhead over a clip');
  edit(() => {
    let newT = t;
    for (const c of list) {
      const cs = clipsOn(c.track);
      if (side === 'start') {
        const cut = t - c.start, s0 = c.start; c.in += cut * c.speed;
        for (const o of cs) if (o !== c && o.start > s0 + EPS) o.start -= cut;
        newT = s0;
      } else {
        const oldEnd = cend(c), cut = oldEnd - t; setEnd(c, t);
        for (const o of cs) if (o !== c && o.start >= oldEnd - EPS - cut && o.start > c.start) o.start -= cut;
      }
      c.fadeIn = Math.min(c.fadeIn, cdur(c)); c.fadeOut = Math.min(c.fadeOut, cdur(c));
    }
    setTime(newT);
  }, side === 'start' ? 'Rippled start to playhead' : 'Rippled end to playhead');
}
function addXfade(A, B, xd) {
  xd = Math.min(xd, cdur(A) * 0.9, cdur(B) * 0.9);
  const ha = (srcLen(A) - A.out) / A.speed;
  const hb = (B.kind === 'video' || B.kind === 'audio') ? B.in / B.speed : Infinity;
  let ea = Math.min(ha, xd / 2), eb = Math.min(hb, xd / 2);
  ea = Math.min(ha, xd - eb); eb = Math.min(hb, xd - ea);
  const r = Math.max(0, xd - ea - eb), edgeA = cend(A);
  A.out += ea * A.speed;
  if (isFinite(hb)) { B.in -= eb * B.speed; B.start -= eb; } else { B.start -= eb; B.out += eb * B.speed; }
  if (r > EPS) for (const c of clipsOn(B.track)) if (c !== A && c.start >= B.start - EPS) c.start -= r;
  B.xf = B.xf || xfDefault();
  return { xd, rippled: r, edge: edgeA };
}
function removeXf(A, B) {
  const mid = q((B.start + cend(A)) / 2);
  setEnd(A, mid); B.in += (mid - B.start) * B.speed; B.start = mid;
}
function buttPairs(trackFilter) {
  const out = [];
  for (const tr of P.tracks) {
    if (tr.locked || (trackFilter && !trackFilter(tr))) continue;
    const cs = clipsOn(tr.id);
    for (let i = 0; i < cs.length - 1; i++) if (Math.abs(cs[i + 1].start - cend(cs[i])) < frame() * 0.6) out.push([cs[i], cs[i + 1]]);
  }
  return out;
}
function cmdAddXfade() {
  let pairs = buttPairs();
  const sel = selClips();
  if (sel.length) pairs = pairs.filter(([a, b]) => UI.sel.has(a.id) || UI.sel.has(b.id));
  else { pairs.sort((p, q2) => Math.abs(p[1].start - UI.t) - Math.abs(q2[1].start - UI.t)); if (pairs.length) { const best = Math.abs(pairs[0][1].start - UI.t); pairs = pairs.filter(p => Math.abs(Math.abs(p[1].start - UI.t) - best) < EPS && best < 3); } }
  if (!pairs.length) return toast('No butt-cut near the playhead (or selected clips) to add a transition to');
  edit(() => { let rip = 0; for (const [a, b] of pairs) rip += addXfade(a, b, P.settings.xfDur).rippled; return rip; },
    rip => `Added ${XF[P.settings.xfType]} × ${pairs.length}` + (rip > EPS ? ' (not enough handles — later clips shifted)' : ''));
}
function xfadeAllOnTrack(tr) {
  edit(() => { let n = 0; for (; ;) { const p = buttPairs(t => t === tr)[0]; if (!p) break; addXfade(p[0], p[1], P.settings.xfDur); n++; if (n > 500) break; } return n; }, n => n ? `Cross-faded ${n} cuts on ${tr.name}` : 'No butt cuts on ' + tr.name);
}
function closeAllGaps(tr) {
  edit(() => { let n = 0; for (let k = 0; k < 500; k++) { const cs = clipsOn(tr.id); let did = false; let endSoFar = 0; for (const c of cs) { if (c.start > endSoFar + EPS) { closeGapAt(tr.id, (endSoFar + c.start) / 2); did = true; n++; break; } endSoFar = Math.max(endSoFar, cend(c)); } if (!did) break; } return n; }, n => n ? `Closed ${n} gap${n > 1 ? 's' : ''}` : 'No gaps');
}
function cmdCopy(cut) {
  const cs = selClips(); if (!cs.length) return;
  const s0 = Math.min(...cs.map(c => c.start));
  UI.clipboard = cs.map(c => ({ ...structuredClone(c), _rel: c.start - s0 }));
  if (cut) cmdDelete(UI.ripple); else toast(`Copied ${cs.length} clip${cs.length > 1 ? 's' : ''}`);
}
function cmdPaste() {
  if (!UI.clipboard) return toast('Clipboard is empty');
  ensureTargets();
  edit(() => {
    const ids = [];
    for (const c of UI.clipboard) {
      const n = structuredClone(c); n.id = uid('c'); n.start = q(UI.t + c._rel); delete n._rel;
      const tr = trackById(n.track); if (!tr || tr.locked) n.track = n.kind === 'audio' ? UI.targetA : UI.targetV;
      if (!n.track) continue; P.clips.push(n); ids.push(n.id);
    }
    resolveDrop(ids, UI.autoX ? 'xfade' : 'overwrite'); UI.sel = new Set(ids); UI.selXf = null;
    const e = Math.max(...ids.map(id => clipById(id)).filter(Boolean).map(cend)); if (isFinite(e)) setTime(e);
  }, 'Pasted');
}
function cmdDuplicate() {
  const cs = selClips(); if (!cs.length) return;
  const s0 = Math.min(...cs.map(c => c.start)), e0 = Math.max(...cs.map(cend));
  edit(() => {
    const ids = [];
    for (const c of cs) { const n = structuredClone(c); n.id = uid('c'); n.start = c.start - s0 + e0; P.clips.push(n); ids.push(n.id); }
    resolveDrop(ids, 'overwrite'); UI.sel = new Set(ids);
  }, 'Duplicated');
}
function nudge(n) {
  const cs = selClips(); if (!cs.length) return;
  edit(() => { for (const c of cs) c.start = Math.max(0, q(c.start + n * frame())); if (!cs.every(c => trackValid(c.track))) for (const c of cs) c.start = Math.max(0, q(c.start - n * frame())); });
}
function placeMedia(m, mode) {
  if (!m || m.offline) return;
  ensureTargets();
  const tid = m.type === 'audio' ? UI.targetA : UI.targetV;
  if (!tid) return toast('No target track');
  edit(() => {
    const tr = trackById(tid);
    const start = mode === 'append' ? clipsOn(tid).reduce((mx, c) => Math.max(mx, cend(c)), 0) : q(UI.t);
    const c = makeClip(m, tid, start); P.clips.push(c);
    resolveDrop([c.id], mode === 'insert' ? 'insert' : 'overwrite');
    UI.sel = new Set([c.id]); UI.selXf = null; setTime(cend(c)); followPlayhead();
    return tr.name;
  }, n => `${mode === 'append' ? 'Appended' : mode === 'insert' ? 'Inserted' : 'Overwrote'} on ${n}`);
  renderBin();
}
function addGenerator(kind) {
  ensureTargets();
  edit(() => {
    const t = q(UI.t); const dur = kind === 'text' ? 3 : P.settings.imgDur;
    let tid;
    if (kind === 'text') {
      const vts = P.tracks.filter(tr => tr.type === 'video' && !tr.locked);
      const free = vts.find(tr => tr.id !== UI.targetV && !clipsOn(tr.id).some(c => c.start < t + dur && cend(c) > t));
      tid = free ? free.id : addTrack('video').id;
    } else tid = UI.targetV;
    const c = kind === 'text' ? makeText(tid, t) : makeMatte(tid, t);
    const busy = clipsOn(tid).some(o => o.start < t + dur - EPS && cend(o) > t + EPS);
    P.clips.push(c); resolveDrop([c.id], busy ? 'insert' : 'overwrite'); UI.sel = new Set([c.id]); UI.selXf = null;
  }, kind === 'text' ? 'Title added — edit it in the inspector' : 'Colour matte inserted at the playhead');
  renderHeads();
}
function detachAudio(c) {
  const m = media.get(c.media); if (!m || c.kind !== 'video') return;
  if (m.hasAudio === false) return toast('This clip has no audio track');
  edit(() => {
    ensureTargets();
    let tid = UI.targetA; if (!tid) tid = addTrack('audio').id;
    const a = structuredClone(c); a.id = uid('c'); a.kind = 'audio'; a.track = tid; a.xf = null; a.muted = false; a.name = c.name + ' (audio)';
    P.clips.push(a); cutRange(tid, a.start, cend(a), new Set([a.id])); c.muted = true;
    UI.sel = new Set([a.id]);
  }, 'Audio detached to its own track');
  renderHeads();
}
function addMarker(t = UI.t, beat = false) {
  t = q(t);
  if (P.markers.some(m => Math.abs(m.t - t) < frame() * 0.5)) return;
  const b = snapState(); P.markers.push({ id: uid('k'), t, name: '', beat }); P.markers.sort((a, b2) => a.t - b2.t); commit(b); dirtyTL = true;
}
function jumpMarker(dir) {
  const ts = P.markers.map(m => m.t);
  const t = dir > 0 ? ts.find(x => x > UI.t + EPS) : [...ts].reverse().find(x => x < UI.t - EPS);
  if (t != null) { setTime(t); followPlayhead(); }
}
function jumpEdit(dir) {
  const pts = editPoints();
  const t = dir > 0 ? pts.find(x => x > UI.t + EPS) : [...pts].reverse().find(x => x < UI.t - EPS);
  if (t != null) { setTime(t); followPlayhead(); }
}
function step(n) { if (UI.playing) pause(); setTime(q(UI.t + n * frame())); followPlayhead(); }
function setIO(which, clear) {
  if (UI.mode === 'source' && UI.src && srcEl) {
    if (which === 'in') UI.src.markIn = clear ? null : srcT(); else UI.src.markOut = clear ? null : srcT();
    if (UI.src.markIn != null && UI.src.markOut != null && UI.src.markOut < UI.src.markIn) [UI.src.markIn, UI.src.markOut] = [UI.src.markOut, UI.src.markIn];
    drawSrcBar(); updInfo(); return;
  }
  edit(() => {
    if (which === 'in') P.inPt = clear ? null : q(UI.t); else P.outPt = clear ? null : q(UI.t);
    if (P.inPt != null && P.outPt != null && P.outPt < P.inPt) [P.inPt, P.outPt] = [P.outPt, P.inPt];
  });
}
/* beat detection: onset envelope → tempo by autocorrelation → phase-locked grid with local refinement */
function detectBeats(m) {
  if (!m.env) return null;
  const { rate, data } = m.env, n = data.length, o = new Float32Array(n);
  for (let i = 1; i < n; i++) { const d = Math.log(1e-4 + data[i]) - Math.log(1e-4 + data[i - 1]); o[i] = d > 0 ? d : 0; }
  let mean = 0; for (let i = 0; i < n; i++) mean += o[i]; mean /= n || 1;
  for (let i = 0; i < n; i++) o[i] = Math.max(0, o[i] - mean);
  const minL = Math.floor(rate * 60 / 190), maxL = Math.ceil(rate * 60 / 65);
  let best = -1, bl = minL;
  for (let L = minL; L <= maxL; L++) {
    let s = 0; for (let i = L; i < n; i++) s += o[i] * o[i - L];
    const bpm = 60 * rate / L, w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.8, 2));
    s *= w; if (s > best) { best = s; bl = L; }
  }
  let per = bl, bs = -1; // fractional period refine via comb
  for (let L = Math.max(2, bl - 1); L <= bl + 1; L += 0.05) {
    let s2 = 0;
    for (let ph = 0; ph < L; ph++) { let c = 0; for (let k = ph; k < n; k += L) c += o[Math.round(k)] || 0; if (c > s2) s2 = c; }
    if (s2 > bs) { bs = s2; per = L; }
  }
  let bph = 0, bpv = -1;
  for (let ph = 0; ph < per; ph++) { let c = 0; for (let k = ph; k < n; k += per) c += o[Math.round(k)] || 0; if (c > bpv) { bpv = c; bph = ph; } }
  const beats = []; let pos = bph; const win = Math.max(2, Math.round(rate * 0.035));
  while (pos < n) {
    const bi = Math.round(pos); let r = bi, rv = -1;
    for (let j = -win; j <= win; j++) { const v = o[bi + j]; if (v > rv) { rv = v; r = bi + j; } }
    beats.push(Math.max(0, r) / rate); pos = (rv > 0 ? r : bi) + per;
  }
  return { bpm: 60 * rate / per, beats };
}
function cmdBeats(c) {
  c = c || selClips().find(x => x.media && media.get(x.media) && media.get(x.media).env) || P.clips.filter(x => x.kind === 'audio' && media.get(x.media)?.env).sort((a, b) => cdur(b) - cdur(a))[0];
  if (!c) { const m = UI.binSel && media.get(UI.binSel); if (m && m.env) return toast('Put the music on the timeline first, then select it'); return toast('Select a music/audio clip (waveform must have loaded)'); }
  const m = media.get(c.media), r = detectBeats(m);
  if (!r || !r.beats.length) return toast('No clear beat found');
  edit(() => {
    const s = c.start, e = cend(c);
    P.markers = P.markers.filter(k => !(k.beat && k.t >= s - EPS && k.t <= e + EPS));
    for (const b of r.beats) { if (b < c.in || b > c.out) continue; const t = q(c.start + (b - c.in) / c.speed); P.markers.push({ id: uid('k'), t, name: '', beat: true }); }
    P.markers.sort((a, b) => a.t - b.t);
  }, `~${Math.round(r.bpm * c.speed)} BPM — beat markers added. Cuts now snap to the beat.`);
}
function beatCut(n) {
  const cs = selClips().filter(c => c.kind !== 'audio').sort((a, b) => a.start - b.start);
  if (!cs.length) return toast('Select the clips you want cut to the beat');
  const beats = [...new Set(P.markers.map(m => m.t))].sort((a, b) => a - b);
  if (beats.length < 2) return toast('Add markers first (♪ Beats on your music, or tap M while playing)');
  edit(() => {
    const tid = cs[0].track; let bi = beats.findIndex(b => b >= cs[0].start - frame()); if (bi < 0) bi = 0;
    const ids = new Set(cs.map(c => c.id)); let placed = 0;
    for (const c of cs) {
      if (bi >= beats.length - 1) { removeClip(c); continue; }
      let k = n; const avail = (srcLen(c) - c.in) / c.speed;
      while (k > 1 && (bi + k >= beats.length || beats[bi + k] - beats[bi] > avail + EPS)) k--;
      const s = beats[bi], e = beats[Math.min(bi + k, beats.length - 1)];
      c.track = tid; c.start = s; c.out = Math.min(c.in + (e - s) * c.speed, srcLen(c)); c.xf = null;
      c.fadeIn = Math.min(c.fadeIn, cdur(c)); c.fadeOut = Math.min(c.fadeOut, cdur(c));
      bi += k; placed++;
    }
    for (const c of selClips()) cutRange(tid, c.start, cend(c), ids);
    return placed;
  }, p => `Cut ${p} clips to the beat (${n} beat${n > 1 ? 's' : ''} each)`);
}
