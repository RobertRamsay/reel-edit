/* ============================================================
   UI: bin, inspector, menus, keys, export, project I/O, boot
   ============================================================ */
function toast(msg, warn) {
  if (!msg) return;
  const box = $('#toasts'); const t = h('div', { class: 'toast' + (warn ? ' warn' : '') }, msg);
  box.append(t); while (box.children.length > 4) box.firstChild.remove();
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 350); }, warn ? 3600 : 2000);
}
function changed(o = {}) {
  dirtyPV = dirtyTL = true;
  if (!UI.drag) syncMedia(UI.t, UI.playing && UI.rate > 0);
  if (o.insp !== false) renderInsp();
  updInfo(); updUsed(); scheduleAutosave();
}
function updInfo() {
  const e = tlEnd();
  $('#projInfo').textContent = `${P.settings.w}×${P.settings.h} · ${P.settings.fps} fps · ${fmtTC(e)}`;
  let v = '';
  if (UI.mode === 'source' && UI.src) {
    const m = UI.src, a = m.markIn || 0, b = m.markOut != null ? m.markOut : m.duration;
    v = isFinite(m.duration) ? `IN ${fmtTC(a)} · OUT ${fmtTC(b)} · ${fmtS(b - a)}   —   ,  insert   .  overwrite   E  append` : 'Still image — drag to timeline or press E';
  } else if (P.inPt != null || P.outPt != null) v = `IN→OUT ${fmtS((P.outPt ?? e) - (P.inPt ?? 0))}`;
  $('#vInfo').textContent = v;
}
let lastTC = '';
function updTC() {
  const s = UI.mode === 'source' && UI.src ? fmtTC(srcT()) + '|' + fmtTC(UI.src.duration) : fmtTC(UI.t) + '|' + fmtTC(tlEnd());
  if (s === lastTC) return; lastTC = s; const [a, b] = s.split('|');
  $('#tc').textContent = a; $('#dur').textContent = b;
}

/* ---------- media bin ---------- */
function renderBin() {
  const list = $('#binList'); list.innerHTML = '';
  const f = $('#binFilter').value.trim().toLowerCase();
  $('#binEmpty').hidden = media.size > 0;
  for (const m of media.values()) {
    if (f && !m.name.toLowerCase().includes(f)) continue;
    const cv = h('canvas', { width: 160, height: 90 });
    const card = h('div', { class: 'bcard' + (UI.binSel === m.id ? ' sel' : '') + (m.offline ? ' off' : ''), draggable: !m.offline, title: m.name + (m.offline ? '\nOFFLINE — click to relink' : '\nDouble-click: open in Source viewer · drag to timeline · E append') },
      cv, h('div', { class: 'bmeta' }, h('span', { class: 'bt ' + m.type }), h('span', { class: 'bn' }, m.name), h('span', { class: 'bd' }, m.offline ? 'OFFLINE' : isFinite(m.duration) ? fmtS(m.duration) : 'still')));
    card.dataset.id = m.id; m._cv = cv; m._card = card;
    drawBinThumb(m);
    cv.addEventListener('mousemove', e => { if (m.type === 'video' && m.thumbs && m.thumbs.length > 1) { const r = cv.getBoundingClientRect(); drawBinThumb(m, clamp((e.clientX - r.left) / r.width, 0, 1)); } });
    cv.addEventListener('mouseleave', () => drawBinThumb(m));
    card.addEventListener('click', () => {
      if (m.offline) { pendingRelink = m; $('#fileIn').click(); return; }
      UI.binSel = m.id; $$('.bcard').forEach(c => c.classList.toggle('sel', c.dataset.id === m.id));
    });
    card.addEventListener('dblclick', () => openSource(m));
    card.addEventListener('dragstart', e => { UI.dragMedia = m; UI.binSel = m.id; e.dataTransfer.setData('text/plain', m.name); e.dataTransfer.effectAllowed = 'copy'; });
    card.addEventListener('dragend', () => { UI.dragMedia = null; UI.ghost = null; dirtyTL = true; });
    card.addEventListener('contextmenu', e => { e.preventDefault(); UI.binSel = m.id; binMenu(e.clientX, e.clientY, m); });
    list.append(card);
  }
  updUsed();
}
function updUsed() {
  const used = new Set(P.clips.map(c => c.media));
  for (const m of media.values()) {
    if (!m._card) continue;
    const has = m._card.querySelector('.used');
    if (used.has(m.id) && !has) m._card.append(h('i', { class: 'used', title: 'Used in the timeline' }));
    else if (!used.has(m.id) && has) has.remove();
  }
}
function drawBinThumb(m, frac) {
  const cv = m._cv; if (!cv) return;
  const g = cv.getContext('2d'), W = cv.width, H = cv.height;
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  if (m.offline) { g.fillStyle = '#3a0d14'; g.fillRect(0, 0, W, H); g.fillStyle = '#ff4d5e'; g.font = '700 13px "Segoe UI"'; g.textAlign = 'center'; g.fillText('OFFLINE', W / 2, H / 2 - 2); g.font = '11px "Segoe UI"'; g.fillText('click to relink', W / 2, H / 2 + 14); return; }
  if (m.type === 'audio') {
    g.fillStyle = '#0f1a15'; g.fillRect(0, 0, W, H);
    if (m.peaks) drawWaveGeneric(g, m, 0, m.duration, 4, 10, W - 8, H - 20, '#36946d');
    else { g.fillStyle = '#36946d'; g.font = '28px "Segoe UI"'; g.textAlign = 'center'; g.fillText('♪', W / 2, H / 2 + 10); }
    return;
  }
  if (!m.thumbs || !m.thumbs.length) { g.fillStyle = '#333'; g.font = '11px "Segoe UI"'; g.textAlign = 'center'; g.fillText('loading…', W / 2, H / 2 + 4); return; }
  const th = m.thumbs[frac == null ? Math.min(m.thumbs.length - 1, Math.floor(m.thumbs.length * 0.2)) : Math.min(m.thumbs.length - 1, Math.floor(frac * m.thumbs.length))].c;
  const k = Math.min(W / th.width, H / th.height); g.drawImage(th, (W - th.width * k) / 2, (H - th.height * k) / 2, th.width * k, th.height * k);
  if (frac != null) { g.fillStyle = '#ff8a3d'; g.fillRect(frac * W - 1, 0, 2, H); }
  drawProxyBadge(g, m, W, H);
}
function drawProxyBadge(g, m, W, H) {
  const st = m.proxyState; if (!st) return;
  g.font = '700 10px "Segoe UI",sans-serif'; g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  if (st.status === 'ready') { g.fillStyle = 'rgba(0,0,0,.65)'; g.fillRect(4, 4, 44, 15); g.fillStyle = '#9ff0c4'; g.fillText('PROXY', 9, 15); }
  else if (st.status === 'building' || st.status === 'queued') {
    g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(0, H - 16, W, 16); g.fillStyle = '#ff8a3d'; g.fillRect(0, H - 3, W * (st.p || 0), 3);
    g.fillStyle = '#ffd2b3'; g.fillText(st.status === 'queued' ? 'proxy queued' : UI.playing ? 'proxy paused (playing)' : `making proxy ${Math.round((st.p || 0) * 100)}%`, 5, H - 5);
  }
}
let pendingRelink = null;

/* ---------- inspector ---------- */
let editBefore = null;
function beginEdit() { if (editBefore == null) editBefore = snapState(); }
function endEdit() { if (editBefore != null) { const b = editBefore; editBefore = null; commit(b); } }
const sec = (title, ...kids) => h('div', { class: 'sec' }, h('h4', {}, ...[].concat(title)), ...kids);
function rowR(label, get, set, { min, max, step = 0.01, fmt = v => (+v).toFixed(2), def } = {}) {
  const v = get(), inp = h('input', { type: 'range', min, max, step, value: v }), out = h('span', { class: 'val' }, fmt(v));
  inp.addEventListener('input', () => { beginEdit(); set(+inp.value); out.textContent = fmt(+inp.value); changed({ insp: false }); });
  inp.addEventListener('change', endEdit);
  const lab = h('label', { title: def != null ? 'Double-click to reset' : null }, label);
  if (def != null) lab.addEventListener('dblclick', () => { beginEdit(); set(def); endEdit(); changed(); });
  return h('div', { class: 'row' }, lab, inp, out);
}
function rowN(label, get, set, { min, max, step = 0.01, suffix = '' } = {}) {
  const inp = h('input', { type: 'number', min, max, step, value: +(+get()).toFixed(3) });
  inp.addEventListener('change', () => { let v = parseFloat(inp.value); if (isNaN(v)) return; if (min != null) v = Math.max(min, v); if (max != null) v = Math.min(max, v); beginEdit(); set(v); endEdit(); changed(); });
  return h('div', { class: 'row' }, h('label', {}, label), inp, h('span', { class: 'val' }, suffix));
}
function rowS(label, get, set, opts) {
  const s = h('select', {}); for (const [v, l] of opts) s.append(h('option', { value: v }, l)); s.value = get();
  s.addEventListener('change', () => { beginEdit(); set(s.value); endEdit(); changed(); });
  return h('div', { class: 'row' }, h('label', {}, label), s, h('span'));
}
function rowC(label, get, set) {
  const i = h('input', { type: 'color', value: get() });
  i.addEventListener('input', () => { beginEdit(); set(i.value); changed({ insp: false }); }); i.addEventListener('change', endEdit);
  return h('div', { class: 'row' }, h('label', {}, label), h('div', {}, i), h('span'));
}
function rowB(label, get, set, extra) {
  const i = h('input', { type: 'checkbox', checked: !!get() });
  i.addEventListener('change', () => { beginEdit(); set(i.checked); endEdit(); changed(); });
  return h('div', { class: 'row' }, h('label', {}, label), h('div', { style: 'display:flex;gap:8px;align-items:center' }, i, extra || null), h('span'));
}
const chips = (items) => h('div', { class: 'chips' }, items.map(([l, on, act, title]) => h('button', { class: on ? 'on' : '', title, onclick: act }, l)));
function labelChips(cs) {
  const cur = cs[0].label;
  return h('div', { class: 'chips', style: 'margin-top:6px' },
    h('button', { class: 'swatch' + (!cur ? ' on' : ''), title: 'No label', style: 'background:#555b66', onclick: () => edit(() => cs.forEach(c => c.label = null)) }),
    Object.entries(LABELS).map(([k, v]) => h('button', { class: 'swatch' + (cur === k ? ' on' : ''), title: k, style: `background:${v}`, onclick: () => edit(() => cs.forEach(c => c.label = k)) })));
}
function shiftAfter(c, oldEnd) { const d = cend(c) - oldEnd; if (Math.abs(d) < EPS) return; for (const o of clipsOn(c.track)) if (o !== c && o.start >= oldEnd - EPS) o.start = Math.max(0, o.start + d); }
function setSpeed(c, s) { const oe = cend(c); c.speed = s; shiftAfter(c, oe); }
function setDur(c, d) { const oe = cend(c); d = Math.max(frame(), d); c.out = Math.min(c.in + d * c.speed, srcLen(c)); c.fadeIn = Math.min(c.fadeIn, cdur(c)); c.fadeOut = Math.min(c.fadeOut, cdur(c)); shiftAfter(c, oe); }
const volToDb = v => v > 0 ? 20 * Math.log10(v) : -40;
const dbToVol = d => d <= -40 ? 0 : Math.pow(10, d / 20);
const fmtDb = d => d <= -40 ? '−∞' : (d > 0 ? '+' : '') + d.toFixed(1) + 'dB';
function renderInsp() {
  if (UI.drag) return;
  const B = $('#inspBody'); const st = B.scrollTop; B.innerHTML = '';
  if (UI.selXf) { const c = clipById(UI.selXf); if (c) inspXf(c); else UI.selXf = null; }
  if (!UI.selXf) {
    const cs = selClips();
    if (!cs.length) inspProject(); else if (cs.length === 1) inspClip(cs[0]); else inspMulti(cs);
  }
  B.scrollTop = st;
}
function inspProject() {
  $('#inspTitle').textContent = 'Project';
  const B = $('#inspBody'), S = P.settings, e = tlEnd();
  const preset = `${S.w}x${S.h}`;
  const presets = [['1920x1080', 'Landscape 16:9 · 1920×1080'], ['1080x1920', 'Reel / Short 9:16 · 1080×1920'], ['1080x1080', 'Square 1:1 · 1080×1080'], ['1080x1350', 'Portrait 4:5 · 1080×1350'], ['3840x2160', '4K UHD · 3840×2160'], ['2560x1440', '1440p · 2560×1440'], ['1280x720', '720p · 1280×720']];
  if (!presets.some(p => p[0] === preset)) presets.push([preset, `Custom · ${S.w}×${S.h}`]);
  B.append(sec('Format',
    rowS('Frame', () => preset, v => { const [w, hh] = v.split('x').map(Number); S.w = w; S.h = hh; resizePreview(); }, presets),
    rowN('Width', () => S.w, v => { S.w = Math.round(v / 2) * 2; resizePreview(); }, { min: 64, max: 7680, step: 2, suffix: 'px' }),
    rowN('Height', () => S.h, v => { S.h = Math.round(v / 2) * 2; resizePreview(); }, { min: 64, max: 7680, step: 2, suffix: 'px' }),
    rowS('Frame rate', () => String(S.fps), v => { S.fps = +v; }, [['24', '24 fps'], ['25', '25 fps'], ['30', '30 fps'], ['50', '50 fps'], ['60', '60 fps']]),
    rowC('Background', () => S.bg, v => { S.bg = v; })));
  B.append(sec('Defaults',
    rowS('Transition', () => S.xfType, v => { S.xfType = v; $('#xfType').value = v; }, Object.entries(XF)),
    rowN('Length', () => S.xfDur, v => { S.xfDur = v; $('#xfDur').value = v; }, { min: 0.04, max: 10, step: 0.05, suffix: 's' }),
    rowN('Still length', () => S.imgDur, v => { S.imgDur = v; }, { min: 0.1, max: 60, step: 0.5, suffix: 's' })));
  const beats = P.markers.filter(m => m.beat).length;
  B.append(sec('Timeline',
    h('div', { class: 'stat' }, 'Duration', h('b', {}, fmtTC(e))),
    h('div', { class: 'stat' }, 'Clips', h('b', {}, P.clips.length)),
    h('div', { class: 'stat' }, 'Markers', h('b', {}, `${P.markers.length - beats} + ${beats} beat`)),
    h('div', { class: 'btnrow' },
      h('button', { onclick: () => edit(() => { P.markers = P.markers.filter(m => !m.beat); }, 'Beat markers cleared'), disabled: !beats }, 'Clear beat markers'),
      h('button', { onclick: () => edit(() => { P.markers = []; }, 'All markers cleared'), disabled: !P.markers.length }, 'Clear all markers'))));
  B.append(sec('Quick tips', h('div', { class: 'note', html:
    '• Drag one clip <b>over another</b> on the same track → instant cross-fade. Drop it <b>inside</b> a clip → it splits with fades both sides.<br>' +
    '• Drag the <b>dots</b> on a clip\'s top corners for fades.<br>' +
    '• <kbd>Q</kbd>/<kbd>W</kbd> ripple-trim the clip under the playhead to the playhead.<br>' +
    '• <kbd>Ctrl</kbd>+<kbd>T</kbd> adds a transition at the nearest cut using spare handle footage.<br>' +
    '• Select music → <b>♪ Beats</b>, then select clips → <b>Cut to beat</b>.<br>' +
    '• Double-click a bin item to set In/Out in the Source viewer, then <kbd>,</kbd> insert / <kbd>.</kbd> overwrite / <kbd>E</kbd> append.<br>' +
    '• Hold <kbd>Alt</kbd> on a cut between two clips to roll it.' })));
}
function inspClip(c) {
  const B = $('#inspBody'), m = c.media ? media.get(c.media) : null, vis = c.kind !== 'audio', S = P.settings;
  $('#inspTitle').textContent = ({ video: 'Video clip', audio: 'Audio clip', image: 'Still', text: 'Title', color: 'Colour matte' })[c.kind] || 'Clip';
  const nameIn = h('input', { value: c.name || '', spellcheck: false, style: 'width:100%' });
  nameIn.addEventListener('change', () => { beginEdit(); c.name = nameIn.value; endEdit(); changed({ insp: false }); });
  B.append(sec('Clip', h('div', { class: 'row full' }, nameIn), labelChips([c]),
    m ? h('div', { class: 'note', style: 'margin-top:6px' }, (m.offline ? '⚠ OFFLINE · ' : '') + m.name + (isFinite(m.duration) ? ` · source ${fmtTC(c.in)} → ${fmtTC(c.out)}` : '') + (m.info ? ' · ' + m.info : '') + (m.proxy ? ` · proxy ${m.proxy.w}×${m.proxy.h}` : '')) : null));
  B.append(sec('Timing',
    rowN('Start', () => c.start, v => { c.start = q(v); if (!trackValid(c.track)) resolveDrop([c.id], UI.autoX ? 'xfade' : 'overwrite'); }, { min: 0, step: frame(), suffix: 's' }),
    rowN('Duration', () => cdur(c), v => setDur(c, q(v)), { min: frame(), step: frame(), suffix: 's' }),
    c.kind === 'video' || c.kind === 'audio' ? h('div', {},
      rowN('Speed', () => c.speed, v => setSpeed(c, clamp(v, 0.1, 16)), { min: 0.1, max: 16, step: 0.05, suffix: '×' }),
      chips([0.25, 0.5, 1, 1.5, 2, 4].map(s => [s + '×', c.speed === s, () => edit(() => setSpeed(c, s))]))) : null));
  if (c.kind === 'video' || c.kind === 'audio') {
    B.append(sec(['Audio', c.kind === 'video' ? h('button', { onclick: () => detachAudio(c), title: 'Copy the audio onto an audio track and mute it here' }, 'Detach') : null],
      rowR('Volume', () => volToDb(c.volume), v => { c.volume = dbToVol(v); }, { min: -40, max: 12, step: 0.5, fmt: fmtDb, def: 0 }),
      rowB('Mute', () => c.muted, v => { c.muted = v; })));
  }
  const maxF = Math.max(frame(), Math.min(10, cdur(c)));
  B.append(sec('Fades',
    rowR('Fade in', () => c.fadeIn || 0, v => { c.fadeIn = Math.min(q(v), cdur(c) - (c.fadeOut || 0)); }, { min: 0, max: maxF, step: frame(), fmt: fmtS, def: 0 }),
    rowR('Fade out', () => c.fadeOut || 0, v => { c.fadeOut = Math.min(q(v), cdur(c) - (c.fadeIn || 0)); }, { min: 0, max: maxF, step: frame(), fmt: fmtS, def: 0 }),
    chips([['0.25s', false, () => edit(() => { c.fadeIn = c.fadeOut = Math.min(0.25, cdur(c) / 2); })], ['0.5s', false, () => edit(() => { c.fadeIn = c.fadeOut = Math.min(0.5, cdur(c) / 2); })], ['1s', false, () => edit(() => { c.fadeIn = c.fadeOut = Math.min(1, cdur(c) / 2); })], ['None', false, () => edit(() => { c.fadeIn = c.fadeOut = 0; })]])));
  if (c.kind === 'text') inspText(c, B);
  if (c.kind === 'color') B.append(sec('Matte', rowC('Colour', () => c.color, v => { c.color = v; })));
  if (vis) {
    B.append(sec(['Transform', h('button', { onclick: () => edit(() => Object.assign(c, { x: 0, y: 0, scale: 1, rot: 0, opacity: 1 })) }, 'Reset')],
      rowR('Opacity', () => c.opacity ?? 1, v => { c.opacity = v; }, { min: 0, max: 1, step: 0.01, fmt: v => Math.round(v * 100) + '%', def: 1 }),
      (c.kind === 'video' || c.kind === 'image') ? rowS('Fit', () => c.fit || 'fit', v => { c.fit = v; }, [['fit', 'Fit (letterbox)'], ['fill', 'Fill (crop)'], ['stretch', 'Stretch']]) : null,
      c.kind !== 'color' ? rowR('Scale', () => c.scale ?? 1, v => { c.scale = v; }, { min: 0.1, max: 4, step: 0.01, fmt: v => Math.round(v * 100) + '%', def: 1 }) : null,
      c.kind !== 'color' && c.kind !== 'text' ? rowR('Position X', () => c.x || 0, v => { c.x = v; }, { min: -S.w, max: S.w, step: 1, fmt: v => Math.round(v) + 'px', def: 0 }) : null,
      c.kind !== 'color' && c.kind !== 'text' ? rowR('Position Y', () => c.y || 0, v => { c.y = v; }, { min: -S.h, max: S.h, step: 1, fmt: v => Math.round(v) + 'px', def: 0 }) : null,
      c.kind !== 'color' && c.kind !== 'text' ? rowR('Rotation', () => c.rot || 0, v => { c.rot = v; }, { min: -180, max: 180, step: 0.5, fmt: v => v.toFixed(1) + '°', def: 0 }) : null,
      (c.kind === 'video' || c.kind === 'image') ? rowB('Ken Burns', () => c.kb, v => { c.kb = v; }, h('span', { class: 'note' }, 'slow push-in')) : null));
    if (c.kind === 'video' || c.kind === 'image') {
      const f = c.fx || (c.fx = defFx());
      B.append(sec(['Colour', h('button', { onclick: () => edit(() => { c.fx = defFx(); }) }, 'Reset')],
        rowR('Brightness', () => f.bri, v => { c.fx.bri = v; }, { min: 0, max: 2, def: 1 }),
        rowR('Contrast', () => f.con, v => { c.fx.con = v; }, { min: 0, max: 2, def: 1 }),
        rowR('Saturation', () => f.sat, v => { c.fx.sat = v; }, { min: 0, max: 2, def: 1 }),
        rowR('Hue', () => f.hue, v => { c.fx.hue = v; }, { min: -180, max: 180, step: 1, fmt: v => Math.round(v) + '°', def: 0 }),
        rowR('Blur', () => f.blur, v => { c.fx.blur = v; }, { min: 0, max: 40, step: 0.5, fmt: v => v.toFixed(1) + 'px', def: 0 }),
        chips([['B&W', false, () => edit(() => Object.assign(c.fx, { sat: 0, con: 1.15 }))], ['Punchy', false, () => edit(() => Object.assign(c.fx, { sat: 1.3, con: 1.15 }))], ['Faded', false, () => edit(() => Object.assign(c.fx, { sat: 0.75, con: 0.85, bri: 1.08 }))], ['Warm', false, () => edit(() => Object.assign(c.fx, { hue: -8, sat: 1.1 }))], ['Cool', false, () => edit(() => Object.assign(c.fx, { hue: 10, sat: 0.95 }))]])));
    }
  }
  const [pr] = neighbors(c);
  if (pr && cend(pr) > c.start + EPS) B.append(xfSection(c, pr));
  const under = UI.t > c.start + EPS && UI.t < cend(c) - EPS;
  B.append(sec('Actions', h('div', { class: 'btnrow' },
    h('button', { disabled: !under, onclick: () => edit(() => cutAt(q(UI.t), [c]), 'Split'), title: 'S' }, 'Split at playhead'),
    h('button', { onclick: cmdDuplicate, title: 'Ctrl+D' }, 'Duplicate'),
    m && !m.offline ? h('button', { onclick: () => { m.markIn = c.in; m.markOut = c.out; openSource(m); } }, 'Open in Source') : null,
    (c.kind === 'audio' || c.kind === 'video') && m && m.env ? h('button', { onclick: () => cmdBeats(c) }, '♪ Detect beats') : null,
    h('button', { onclick: () => cmdDelete(true), title: 'Shift+Delete' }, 'Ripple delete'),
    h('button', { onclick: () => cmdDelete(false), title: 'Delete' }, 'Delete'))));
}
function inspText(c, B) {
  const T = c.text, S = P.settings;
  const ta = h('textarea', { rows: 3, spellcheck: false }); ta.value = T.str;
  ta.addEventListener('input', () => { beginEdit(); T.str = ta.value; c.name = ta.value.split('\n')[0].slice(0, 40) || 'Title'; changed({ insp: false }); });
  ta.addEventListener('change', endEdit);
  const fonts = [['"Segoe UI", system-ui, sans-serif', 'Segoe UI'], ['Bahnschrift, "Segoe UI", sans-serif', 'Bahnschrift'], ['"Arial Black", Arial, sans-serif', 'Arial Black'], ['Impact, sans-serif', 'Impact'], ['Georgia, serif', 'Georgia'], ['"Courier New", monospace', 'Courier'], ['Consolas, monospace', 'Consolas'], ['"Trebuchet MS", sans-serif', 'Trebuchet']];
  B.append(sec('Text', h('div', { class: 'row full' }, ta),
    rowS('Font', () => T.font, v => { T.font = v; }, fonts),
    rowR('Size', () => T.size, v => { T.size = v; }, { min: 10, max: Math.round(S.h * 0.4), step: 1, fmt: v => Math.round(v) + 'px' }),
    rowS('Weight', () => String(T.weight), v => { T.weight = +v; }, [['400', 'Regular'], ['600', 'Semibold'], ['800', 'Bold'], ['900', 'Black']]),
    rowC('Colour', () => T.color, v => { T.color = v; }),
    h('div', { class: 'row' }, h('label', {}, 'Align'), chips([['Left', T.align === 'left', () => edit(() => { T.align = 'left'; })], ['Centre', T.align === 'center', () => edit(() => { T.align = 'center'; })], ['Right', T.align === 'right', () => edit(() => { T.align = 'right'; })]]), h('span')),
    rowR('X', () => T.x, v => { T.x = v; }, { min: 0, max: 1, step: 0.005, fmt: v => Math.round(v * 100) + '%', def: 0.5 }),
    rowR('Y', () => T.y, v => { T.y = v; }, { min: 0, max: 1, step: 0.005, fmt: v => Math.round(v * 100) + '%', def: 0.5 }),
    chips([['Top', false, () => edit(() => Object.assign(T, { y: 0.14, x: 0.5, align: 'center' }))], ['Centre', false, () => edit(() => Object.assign(T, { y: 0.5, x: 0.5, align: 'center' }))], ['Lower third', false, () => edit(() => Object.assign(T, { y: 0.8, x: 0.07, align: 'left', size: Math.round(S.h * 0.055), bg: true }))], ['Caption', false, () => edit(() => Object.assign(T, { y: 0.72, x: 0.5, align: 'center', size: Math.round(Math.min(S.w, S.h) * 0.06), stroke: true }))]]),
    rowB('Shadow', () => T.shadow, v => { T.shadow = v; }),
    rowB('Outline', () => T.stroke, v => { T.stroke = v; }),
    rowC('Outline col.', () => T.strokeColor, v => { T.strokeColor = v; }),
    rowB('Box', () => T.bg, v => { T.bg = v; }),
    rowC('Box colour', () => T.bgColor, v => { T.bgColor = v; }),
    rowR('Box opacity', () => T.bgAlpha, v => { T.bgAlpha = v; }, { min: 0, max: 1, step: 0.01, fmt: v => Math.round(v * 100) + '%' }),
    rowS('Animate in', () => T.anim || 'none', v => { T.anim = v; }, [['none', 'None'], ['fadeUp', 'Fade up'], ['pop', 'Pop'], ['slide', 'Slide in'], ['type', 'Typewriter']])));
}
function setOverlap(A, B, nd) {
  nd = clamp(nd, frame(), Math.min(cdur(A), cdur(B)) * 0.95);
  const ov = cend(A) - B.start; let delta = nd - ov;
  if (delta > 0) {
    const hb = (B.kind === 'video' || B.kind === 'audio') ? B.in / B.speed : Infinity, eb = Math.min(delta, hb);
    B.start -= eb; if (isFinite(hb)) B.in -= eb * B.speed; else B.out += eb * B.speed;
    const rest = delta - eb; if (rest > EPS) { const ha = (srcLen(A) - A.out) / A.speed; A.out += Math.min(rest, ha) * A.speed; }
  } else if (delta < 0) {
    const d = -delta / 2; B.start += d; B.in += d * B.speed; A.out -= d * A.speed;
  }
}
function xfSection(B, A) {
  const xf = B.xf || (B.xf = xfDefault());
  const ov = cend(A) - B.start;
  return sec(['Transition in', h('button', { onclick: () => edit(() => removeXf(A, B), 'Hard cut'), title: 'Turn into a hard cut' }, 'Remove')],
    h('div', { class: 'xfgrid' }, Object.entries(XF).map(([k, l]) => h('button', { class: xf.type === k ? 'on' : '', onclick: () => edit(() => { B.xf = { ...xf, type: k }; }) }, l))),
    h('div', { style: 'height:6px' }),
    rowS('Curve', () => xf.curve || 'smooth', v => { B.xf = { ...xf, curve: v }; }, [['smooth', 'Smooth (S-curve)'], ['linear', 'Linear'], ['in', 'Ease in'], ['out', 'Ease out']]),
    rowN('Length', () => ov, v => { const b = snapState(); setOverlap(A, B, q(v)); if (!trackValid(B.track, true)) loadState(b); }, { min: frame(), step: frame(), suffix: 's' }),
    h('div', { class: 'btnrow' }, h('button', { onclick: () => edit(() => { let n = 0; for (const tr of P.tracks) { const cs = clipsOn(tr.id); for (let i = 1; i < cs.length; i++) if (cs[i].start < cend(cs[i - 1]) - EPS) { cs[i].xf = { ...B.xf }; n++; } } return n; }, n => `Applied to ${n} transitions`) }, 'Apply to all transitions')),
    h('div', { class: 'note', style: 'margin-top:6px' }, 'Audio cross-fades automatically (equal-power); dip transitions dip the sound too.'));
}
function inspXf(B) {
  const [A] = neighbors(B);
  if (!A || cend(A) <= B.start + EPS) { UI.selXf = null; return renderInsp(); }
  $('#inspTitle').textContent = 'Transition';
  $('#inspBody').append(sec('Between', h('div', { class: 'note' }, (A.name || A.kind) + '  →  ' + (B.name || B.kind))), xfSection(B, A));
}
function inspMulti(cs) {
  $('#inspTitle').textContent = cs.length + ' clips';
  const B = $('#inspBody'), first = cs[0];
  B.append(sec('Selection', h('div', { class: 'note' }, `${cs.length} clips · ${fmtS(Math.max(...cs.map(cend)) - Math.min(...cs.map(c => c.start)))} span`), labelChips(cs)));
  const aud = cs.filter(c => c.kind === 'video' || c.kind === 'audio');
  if (aud.length) B.append(sec('Audio', rowR('Volume', () => volToDb(aud[0].volume), v => { aud.forEach(c => c.volume = dbToVol(v)); }, { min: -40, max: 12, step: 0.5, fmt: fmtDb, def: 0 })));
  B.append(sec('Fades', rowR('Fade in/out', () => first.fadeIn || 0, v => { cs.forEach(c => { c.fadeIn = c.fadeOut = Math.min(q(v), cdur(c) / 2); }); }, { min: 0, max: 3, step: frame(), fmt: fmtS, def: 0 })));
  B.append(sec('Arrange',
    h('div', { class: 'btnrow' },
      h('button', { onclick: cmdAddXfade, title: 'Ctrl+T' }, 'Transitions between selected'),
      h('button', { onclick: () => edit(() => { const tr = groupBy(cs, c => c.track); for (const [tid, arr] of tr) { arr.sort((a, b) => a.start - b.start); let t = arr[0].start; for (const c of arr) { c.start = t; t = cend(c); } } }, 'Packed — gaps closed') }, 'Pack together')),
    h('div', { class: 'row', style: 'margin-top:8px' }, h('label', { title: 'Lay the selected clips back-to-back so each cut lands on a marker' }, 'Cut to beat'),
      chips([1, 2, 4, 8].map(n => [n + (n === 1 ? ' beat' : ''), false, () => beatCut(n), `Each clip lasts ${n} beat${n > 1 ? 's' : ''}`])), h('span'))));
  B.append(sec('Actions', h('div', { class: 'btnrow' }, h('button', { onclick: cmdDuplicate }, 'Duplicate'), h('button', { onclick: () => cmdDelete(true) }, 'Ripple delete'), h('button', { onclick: () => cmdDelete(false) }, 'Delete'))));
}

/* ---------- context menus ---------- */
function showMenu(x, y, items) {
  const m = $('#menu'); m.innerHTML = '';
  for (const it of items) {
    if (!it) continue;
    if (it === '-') { m.append(h('div', { class: 'sep' })); continue; }
    if (it.head) { m.append(h('div', { class: 'mh' }, it.head)); continue; }
    if (it.chips) { m.append(h('div', { class: 'chips' }, it.label ? h('span', { class: 'cl' }, it.label) : null, it.chips.map(ch => h('button', { class: (ch.on ? 'on ' : '') + (ch.cls || ''), style: ch.style || '', title: ch.title || '', onclick: () => { hideMenu(); ch.act(); } }, ch.label || '')))); continue; }
    const b = h('div', { class: 'mi' + (it.disabled ? ' dis' : '') }, h('span', {}, it.label), it.key ? h('kbd', {}, it.key) : null);
    b.addEventListener('click', () => { hideMenu(); it.act(); });
    m.append(b);
  }
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 6) + 'px'; m.style.top = Math.min(y, innerHeight - r.height - 6) + 'px';
}
function hideMenu() { $('#menu').hidden = true; }
document.addEventListener('pointerdown', e => { if (!$('#menu').contains(e.target)) hideMenu(); }, true);
tl.addEventListener('contextmenu', e => {
  e.preventDefault();
  const { x, y } = ptr(e), H = hit(x, y), t = q(T(x));
  if (H.zone === 'xf') { UI.selXf = H.B.id; UI.sel.clear(); renderInsp(); dirtyTL = true; return xfMenu(e.clientX, e.clientY, H.A, H.B); }
  if (H.c && H.zone !== 'xf') { if (!UI.sel.has(H.c.id)) { UI.sel = new Set([H.c.id]); UI.selXf = null; renderInsp(); } dirtyTL = true; return clipMenu(e.clientX, e.clientY, H.c, t); }
  if (H.zone === 'marker') return showMenu(e.clientX, e.clientY, [{ label: 'Rename marker…', act: () => { const n = prompt('Marker name', H.mk.name || ''); if (n != null) edit(() => { H.mk.name = n; }); } }, { label: 'Delete marker', act: () => edit(() => { P.markers = P.markers.filter(k => k !== H.mk); }) }]);
  if (H.zone === 'ruler') return showMenu(e.clientX, e.clientY, [
    { label: 'Add marker here', key: 'M', act: () => addMarker(t) },
    { label: 'Set In here', key: 'I', act: () => edit(() => { P.inPt = t; if (P.outPt != null && P.outPt < t) P.outPt = null; }) },
    { label: 'Set Out here', key: 'O', act: () => edit(() => { P.outPt = t; if (P.inPt != null && P.inPt > t) P.inPt = null; }) },
    { label: 'Clear In/Out', key: 'Ctrl+Shift+X', act: () => edit(() => { P.inPt = P.outPt = null; }), disabled: P.inPt == null && P.outPt == null },
    '-', { label: 'Clear beat markers', act: () => edit(() => { P.markers = P.markers.filter(m => !m.beat); }) }]);
  if (H.zone === 'lane') {
    const inGap = !clipsOn(H.track.id).some(c => c.start < t && cend(c) > t) && clipsOn(H.track.id).some(c => c.start > t);
    return showMenu(e.clientX, e.clientY, [
      { label: 'Close this gap', act: () => edit(() => closeGapAt(H.track.id, t), 'Gap closed'), disabled: !inGap },
      { label: 'Close all gaps on ' + H.track.name, act: () => closeAllGaps(H.track) },
      { label: 'Paste here', key: 'Ctrl+V', disabled: !UI.clipboard, act: () => { setTime(t); cmdPaste(); } },
      H.track.type === 'video' ? { label: 'Add title here', act: () => { setTime(t); addGenerator('text'); } } : null,
      '-', { label: 'Cross-fade every cut on ' + H.track.name, act: () => xfadeAllOnTrack(H.track) }]);
  }
});
function clipMenu(x, y, c, t) {
  const m = media.get(c.media), [pr, nx] = neighbors(c), multi = UI.sel.size > 1;
  const buttPrev = pr && Math.abs(cend(pr) - c.start) < frame() * 0.6, buttNext = nx && Math.abs(nx.start - cend(c)) < frame() * 0.6;
  showMenu(x, y, [
    { label: 'Split at playhead', key: 'S', act: cmdSplit, disabled: !(UI.t > c.start && UI.t < cend(c)) },
    { label: 'Split here', act: () => edit(() => cutAt(t, [c]), 'Split') },
    '-',
    buttPrev ? { label: 'Transition from previous', act: () => edit(() => addXfade(pr, c, P.settings.xfDur), 'Transition added') } : null,
    buttNext ? { label: 'Transition into next', act: () => edit(() => addXfade(c, nx, P.settings.xfDur), 'Transition added') } : null,
    { chips: [{ label: '¼s', act: () => edit(() => { c.fadeIn = c.fadeOut = Math.min(.25, cdur(c) / 2); }) }, { label: '½s', act: () => edit(() => { c.fadeIn = c.fadeOut = Math.min(.5, cdur(c) / 2); }) }, { label: '1s', act: () => edit(() => { c.fadeIn = c.fadeOut = Math.min(1, cdur(c) / 2); }) }, { label: 'none', act: () => edit(() => { c.fadeIn = c.fadeOut = 0; }) }], label: 'Fades' },
    (c.kind === 'video' || c.kind === 'audio') ? { chips: [0.5, 1, 1.5, 2, 4].map(s => ({ label: s + '×', on: c.speed === s, act: () => edit(() => setSpeed(c, s)) })), label: 'Speed' } : null,
    { chips: [{ label: '', cls: 'swatch', style: 'background:#555b66', act: () => edit(() => selClips().forEach(k => k.label = null)) }, ...Object.entries(LABELS).map(([k, v]) => ({ label: '', cls: 'swatch', style: `background:${v}`, act: () => edit(() => selClips().forEach(s => s.label = k)) }))], label: 'Label' },
    '-',
    c.kind === 'video' && m && m.hasAudio !== false ? { label: 'Detach audio', act: () => detachAudio(c) } : null,
    (c.kind === 'video' || c.kind === 'audio') ? { label: c.muted ? 'Unmute clip' : 'Mute clip', act: () => edit(() => { c.muted = !c.muted; }) } : null,
    m && m.env ? { label: '♪ Detect beats → markers', act: () => cmdBeats(c) } : null,
    multi ? { label: 'Cut selected to beat (2 beats)', act: () => beatCut(2) } : null,
    m && !m.offline ? { label: 'Open in Source viewer', act: () => { m.markIn = c.in; m.markOut = c.out; openSource(m); } } : null,
    m && m.offline ? { label: 'Relink media…', act: () => { pendingRelink = m; $('#fileIn').click(); } } : null,
    '-',
    { label: 'Copy', key: 'Ctrl+C', act: () => cmdCopy() },
    { label: 'Duplicate', key: 'Ctrl+D', act: cmdDuplicate },
    { label: 'Ripple delete', key: 'Shift+Del', act: () => cmdDelete(true) },
    { label: 'Delete', key: 'Del', act: () => cmdDelete(false) },
  ]);
}
function xfMenu(x, y, A, B) {
  const xf = B.xf || xfDefault();
  showMenu(x, y, [{ head: 'Transition' },
    ...Object.entries(XF).map(([k, l]) => ({ label: (xf.type === k ? '● ' : '　') + l, act: () => edit(() => { B.xf = { ...xf, type: k }; }) })),
    '-', { chips: ['smooth', 'linear', 'in', 'out'].map(cv => ({ label: cv, on: (xf.curve || 'smooth') === cv, act: () => edit(() => { B.xf = { ...xf, curve: cv }; }) })), label: 'Curve' },
    '-', { label: 'Remove (hard cut)', key: 'Del', act: () => { edit(() => removeXf(A, B), 'Hard cut'); UI.selXf = null; renderInsp(); } }]);
}
function trackMenu(x, y, tr) {
  const n = P.clips.filter(c => c.track === tr.id).length;
  showMenu(x, y, [{ head: 'Track ' + tr.name },
    { label: 'Add video track', act: () => { edit(() => addTrack('video')); renderHeads(); } },
    { label: 'Add audio track', act: () => { edit(() => addTrack('audio')); renderHeads(); } },
    { label: `Delete ${tr.name}` + (n ? ` (${n} clips)` : ''), disabled: P.tracks.filter(t => t.type === tr.type).length < 2, act: () => { if (n && !confirm(`Delete ${tr.name} and its ${n} clips?`)) return; edit(() => { P.clips = P.clips.filter(c => c.track !== tr.id); P.tracks = P.tracks.filter(t => t !== tr); nameTracks(); }); renderHeads(); } },
    '-', { label: 'Cross-fade every cut', act: () => xfadeAllOnTrack(tr) },
    { label: 'Close all gaps', act: () => closeAllGaps(tr) },
    { label: 'Select all clips on track', act: () => { UI.sel = new Set(clipsOn(tr.id).map(c => c.id)); UI.selXf = null; renderInsp(); dirtyTL = true; } }]);
}
function binMenu(x, y, m) {
  showMenu(x, y, [{ head: m.name },
    { label: 'Open in Source viewer', act: () => openSource(m), disabled: m.offline },
    { label: 'Append to timeline', key: 'E', act: () => placeMedia(m, 'append'), disabled: m.offline },
    { label: 'Insert at playhead', key: ',', act: () => placeMedia(m, 'insert'), disabled: m.offline },
    { label: 'Overwrite at playhead', key: '.', act: () => placeMedia(m, 'overwrite'), disabled: m.offline },
    m.type === 'video' && canProxy(m) ? (m.proxy ? { label: 'Discard proxy (use original)', act: () => discardProxy(m) } : (m.proxyState && /queued|building/.test(m.proxyState.status)) ? { label: 'Cancel proxy', act: () => discardProxy(m) } : { label: 'Make proxy (smooth preview)', act: () => queueProxy(m) }) : null,
    m.info ? { head: m.info } : null,
    '-', { label: 'Relink to another file…', act: () => { pendingRelink = m; $('#fileIn').click(); } },
    { label: 'Remove from project', act: () => {
      const n = P.clips.filter(c => c.media === m.id).length;
      if (n && !confirm(`${m.name} is used by ${n} clip(s). Remove it and those clips?`)) return;
      edit(() => { P.clips = P.clips.filter(c => c.media !== m.id); });
      discardProxy(m); freeStrip(m); releaseMedia(m.id); if (m.url) URL.revokeObjectURL(m.url); if (m.sndUrl) URL.revokeObjectURL(m.sndUrl); media.delete(m.id);
      if (UI.src === m) { UI.src = null; setMode('timeline'); $('#tabSrc').disabled = true; $('#tabSrc').textContent = 'Source'; }
      renderBin(); changed();
    } }]);
}

/* ---------- keyboard ---------- */
addEventListener('keydown', e => {
  if (EXP) { if (e.key === 'Escape') cancelExport(); e.preventDefault(); return; }
  if (!$('#modal').hidden) { if (e.key === 'Escape') closeModal(); return; }
  const ae = document.activeElement, tag = ae && ae.tagName;
  if ((tag === 'INPUT' && !['range', 'checkbox', 'color', 'button'].includes(ae.type)) || tag === 'TEXTAREA' || tag === 'SELECT') { if (e.key === 'Escape' || (e.key === 'Enter' && tag === 'INPUT')) ae.blur(); return; }
  const k = e.key, lk = k.length === 1 ? k.toLowerCase() : k, ctrl = e.ctrlKey || e.metaKey, sh = e.shiftKey, alt = e.altKey;
  const src = UI.mode === 'source' && UI.src;
  let ok = true;
  if (ctrl) {
    switch (lk) {
      case 'z': sh ? redo() : undo(); break; case 'y': redo(); break;
      case 's': saveProject(); break; case 'o': $('#projIn').click(); break; case 'e': openExport(); break; case 'i': $('#fileIn').click(); break;
      case 'k': cmdSplit(); break; case 't': cmdAddXfade(); break; case 'd': cmdDuplicate(); break;
      case 'c': cmdCopy(); break; case 'x': if (sh) edit(() => { P.inPt = P.outPt = null; }, 'In/Out cleared'); else cmdCopy(true); break; case 'v': cmdPaste(); break;
      case 'a': UI.sel = new Set(P.clips.filter(c => !trackOf(c).locked).map(c => c.id)); UI.selXf = null; renderInsp(); dirtyTL = true; break;
      case 'l': toggleLoop(); break;
      case '=': case '+': setZoom(UI.pps * 1.5); break; case '-': setZoom(UI.pps / 1.5); break;
      default: ok = false;
    }
  } else switch (lk) {
    case ' ': togglePlay(); break;
    case 'k': pause(); break; case 'l': shuttle(1); break; case 'j': shuttle(-1); break;
    case 'ArrowLeft': if (src) srcStep(sh ? -fps() : -1); else if (alt) nudge(sh ? -10 : -1); else step(sh ? -fps() : -1); break;
    case 'ArrowRight': if (src) srcStep(sh ? fps() : 1); else if (alt) nudge(sh ? 10 : 1); else step(sh ? fps() : 1); break;
    case 'ArrowUp': if (sh) jumpMarker(-1); else jumpEdit(-1); break;
    case 'ArrowDown': if (sh) jumpMarker(1); else jumpEdit(1); break;
    case 'Home': if (src) srcSeek(0); else { setTime(0); UI.sx = 0; } break;
    case 'End': if (src) srcSeek(UI.src.duration); else { setTime(tlEnd()); followPlayhead(); } break;
    case 'i': setIO('in', alt); break; case 'o': setIO('out', alt); break;
    case 's': cmdSplit(); break;
    case 'q': rippleTrimToPlayhead('start'); break; case 'w': rippleTrimToPlayhead('end'); break;
    case 'm': addMarker(); toast('Marker'); break;
    case '[': jumpMarker(-1); break; case ']': jumpMarker(1); break;
    case 'v': setTool('select'); break; case 'b': setTool('blade'); break; case 'y': setTool('slip'); break;
    case 'n': toggle('snap'); break; case 'x': toggle('autoX'); break; case 'r': toggle('ripple'); break;
    case 'g': UI.guides = !UI.guides; $('#guides').classList.toggle('on', UI.guides); $('#tGuides').classList.toggle('on', UI.guides); break;
    case 'Delete': case 'Backspace': cmdDelete(sh || UI.ripple); break;
    case 'e': placeMedia(src ? UI.src : media.get(UI.binSel), 'append'); break;
    case ',': placeMedia(src ? UI.src : media.get(UI.binSel), 'insert'); break;
    case '.': placeMedia(src ? UI.src : media.get(UI.binSel), 'overwrite'); break;
    case '=': case '+': setZoom(UI.pps * 1.5); break; case '-': case '_': setZoom(UI.pps / 1.5); break;
    case '\\': zoomFit(); break;
    case 't': if (sh) addGenerator('text'); else ok = false; break;
    case '?': openHelp(); break;
    case 'd': if (sh) toggleDiag(); else ok = false; break;
    case 'p': toggleProxy(); break;
    case 'Tab': setMode(UI.mode === 'source' ? 'timeline' : 'source'); break;
    case 'Escape': if (UI.tool !== 'select') setTool('select'); else { UI.sel.clear(); UI.selXf = null; renderInsp(); dirtyTL = true; } break;
    default: ok = false;
  }
  if (ok) e.preventDefault();
});
function setTool(t) { UI.tool = t; $$('#tools button').forEach(b => b.classList.toggle('on', b.dataset.tool === t)); dirtyTL = true; toast({ select: 'Select tool', blade: 'Blade tool — click clips to cut', slip: 'Slip tool' }[t]); }
function toggle(k) {
  UI[k] = !UI[k];
  const id = { snap: '#tgSnap', autoX: '#tgX', ripple: '#tgRipple' }[k]; $(id).classList.toggle('on', UI[k]);
  toast({ snap: 'Snapping', autoX: 'Auto cross-fade', ripple: 'Ripple editing' }[k] + (UI[k] ? ' on' : ' off'));
  savePrefs();
}
function toggleLoop() { UI.loop = !UI.loop; $('#tLoop').classList.toggle('on', UI.loop); toast('Loop ' + (UI.loop ? 'on' : 'off')); }

/* ---------- modal: help & export ---------- */
function openModal(html) { $('#mbox').innerHTML = ''; $('#mbox').append(html); $('#modal').hidden = false; }
function closeModal() { if (EXP) return; $('#modal').hidden = true; }
$('#modal').addEventListener('pointerdown', e => { if (e.target.id === 'modal') closeModal(); });
function openHelp() {
  const K = (a, b) => h('div', {}, h('span', {}, a), h('span', {}, ...b.split(' / ').flatMap((x, i) => [i ? ' / ' : null, h('kbd', {}, x)])));
  openModal(h('div', {}, h('h2', {}, 'Shortcuts & tricks'), h('div', { class: 'keys' },
    h('h3', {}, 'Playback'), K('Play / pause', 'Space'), K('Shuttle back / stop / fwd (tap again = faster)', 'J / K / L'), K('Step frame (Shift = 1 s)', '← / →'), K('Prev / next edit point', '↑ / ↓'), K('Prev / next marker', '[ / ]'), K('Start / end', 'Home / End'), K('Loop', 'Ctrl+L'), K('Toggle Source / Timeline viewer', 'Tab'),
    h('h3', {}, 'Editing'), K('Split at playhead', 'S / Ctrl+K'), K('Ripple-trim start / end to playhead', 'Q / W'), K('Add transition at nearest cut', 'Ctrl+T'), K('Delete / ripple delete', 'Del / Shift+Del'), K('Copy / cut / paste at playhead', 'Ctrl+C / Ctrl+X / Ctrl+V'), K('Duplicate after selection', 'Ctrl+D'), K('Nudge clip 1 frame (Shift = 10)', 'Alt+← / Alt+→'), K('Undo / redo', 'Ctrl+Z / Ctrl+Shift+Z'), K('Add title', 'Shift+T'), K('Select all', 'Ctrl+A'),
    h('h3', {}, 'Source → timeline (bin item or Source viewer)'), K('Mark in / out (Alt clears)', 'I / O'), K('Append to end of target track', 'E'), K('Insert at playhead (pushes right)', ','), K('Overwrite at playhead', '.'),
    h('h3', {}, 'Tools & modes'), K('Select / Blade / Slip', 'V / B / Y'), K('Snapping', 'N'), K('Auto cross-fade', 'X'), K('Ripple mode', 'R'), K('Marker (tap while playing)', 'M'), K('Zoom in / out / fit', '= / - / \\'), K('Safe-area guides', 'G'), K('Playback sync readout', 'Shift+D'), K('Proxies on / off', 'P'), K('Export / Save / Open', 'Ctrl+E / Ctrl+S / Ctrl+O'),
    h('h3', {}, 'Mouse'), K('Move · duplicate · insert-drop · no snap', 'Drag / Alt / Ctrl / Shift'), K('Roll a cut between two clips', 'Alt+drag edge'), K('Fade handles', 'Top-corner dots'), K('Zoom timeline / scroll tracks', 'Ctrl+wheel / Shift+wheel'), K('Pan', 'Middle-drag'), K('Hover-scrub a bin thumbnail', 'Mouse over'),
  ), h('p', { html: '<b>Auto cross-fade:</b> with <kbd>X</kbd> on, drag a clip so it overlaps its neighbour and the overlap becomes a transition (video and audio). Drop a clip <i>inside</i> a longer one and it is spliced in with fades on both sides. Turn it off and drops overwrite instead (red preview). <b>Ripple</b> (<kbd>R</kbd>) makes deletes and trims pull later clips along.<br><b>Beat editing:</b> select your music clip → <b>♪ Beats</b> drops markers on the beat; everything snaps to them. Select a bunch of clips → <b>Cut to beat</b> in the inspector lays them out on the beat grid.<br><b>Export</b> decodes every frame exactly and writes an MP4 faster than real time, straight from your original files. Projects save as small <code>.reel.json</code> files; re-import the media and it relinks automatically by file name.' }),
    h('div', { class: 'foot' }, h('span', { class: 'ver' }, verLine()), h('button', { onclick: () => checkUpdates(true) }, 'Check for updates'), h('button', { class: 'primary', onclick: closeModal }, 'Got it'))));
}
function exportFormats() {
  const C = [['MP4 · H.264 / AAC', ['video/mp4;codecs=avc1.640033,mp4a.40.2', 'video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4']], ['WebM · VP9 / Opus', ['video/webm;codecs=vp9,opus']], ['WebM · VP8 / Opus', ['video/webm;codecs=vp8,opus', 'video/webm']]];
  if (!window.MediaRecorder) return [];
  return C.map(([l, ms]) => ({ l, mime: ms.find(m => { try { return MediaRecorder.isTypeSupported(m); } catch (e) { return false; } }) })).filter(f => f.mime);
}
async function openExport() {
  if (EXP) return;
  const end = tlEnd(); if (end <= 0) return toast('Nothing to export yet', true);
  const offline = await offlineSupported(), fm = exportFormats();
  if (!offline && !fm.length) return toast('This browser cannot export video — try Chrome or Edge', true);
  const hasIO = P.inPt != null || P.outPt != null;
  const eng = h('select', {}, offline ? h('option', { value: 'offline' }, 'Frame-accurate · MP4 (H.264) — recommended') : null, fm.length ? h('option', { value: 'realtime' }, 'Real-time capture (legacy)') : null);
  const fmt = h('select', {}, fm.map((f, i) => h('option', { value: i }, f.l)));
  const rng = h('select', {}, h('option', { value: 'all' }, `Whole timeline · ${fmtTC(end)}`), hasIO ? h('option', { value: 'io', selected: true }, `In → Out · ${fmtTC((P.outPt ?? end) - (P.inPt ?? 0))}`) : null);
  const res = h('select', {}, h('option', { value: 1 }, `Full · ${P.settings.w}×${P.settings.h}`), h('option', { value: 0.5 }, `Half · ${P.settings.w / 2}×${P.settings.h / 2}`));
  const br = h('select', {}, [[4, 'Draft · 4 Mbps'], [12, 'Good · 12 Mbps'], [24, 'High · 24 Mbps'], [50, 'Master · 50 Mbps']].map(([v, l]) => h('option', { value: v, selected: v === 24 }, l)));
  const nm = h('input', { value: P.name.replace(/[\/:*?"<>|]+/g, '_'), spellcheck: false });
  const mute = h('input', { type: 'checkbox', checked: true });
  const anyProxy = P.clips.some(c => media.get(c.media)?.proxy), useProx = h('input', { type: 'checkbox' });
  const rtRows = [h('div', { class: 'row' }, h('label', {}, 'Format'), fmt),
    h('div', { class: 'row' }, h('label', {}, 'Speakers'), h('label', { style: 'display:flex;gap:6px;align-items:center' }, mute, 'Silence speakers while rendering')),
    anyProxy ? h('div', { class: 'row' }, h('label', {}, 'Source'), h('label', { style: 'display:flex;gap:6px;align-items:center' }, useProx, 'Render from proxies (smoother on heavy 4K clips, lower resolution)')) : null].filter(Boolean);
  const note = h('p', { class: 'note' }), why = !offline ? webCodecsMissingReason() : null;
  const warn = why ? h('p', { class: 'note', style: 'color:#ffb27a' }, 'Frame-accurate export (the fast, exact MP4 engine) is unavailable: ' + why) : null;
  const sync = () => {
    const off = eng.value === 'offline'; rtRows.forEach(r => r.hidden = off);
    note.textContent = off ? 'Decodes every source frame exactly and encodes faster than real time, straight from your original files — no dropped frames, sound locked to picture. You can switch tabs while it works.'
      : 'Plays the timeline in real time and records it, so a 60 s reel takes about 60 s. Keep this tab visible until it finishes.';
  };
  eng.onchange = sync;
  openModal(h('div', {}, h('h2', {}, 'Export video'),
    h('div', { class: 'row' }, h('label', {}, 'Engine'), eng),
    h('div', { class: 'row' }, h('label', {}, 'Range'), rng), ...rtRows,
    h('div', { class: 'row' }, h('label', {}, 'Resolution'), res), h('div', { class: 'row' }, h('label', {}, 'Quality'), br),
    h('div', { class: 'row' }, h('label', {}, 'File name'), nm), warn, note,
    h('div', { class: 'foot' }, h('button', { onclick: closeModal }, 'Cancel'), h('button', { class: 'primary', onclick: () => {
      const o = { range: rng.value, scale: +res.value, vbps: +br.value * 1e6, name: nm.value || 'reel' };
      if (eng.value === 'offline') runOfflineExport(o); else startExport({ ...o, mime: fm[+fmt.value].mime, mute: mute.checked, proxy: useProx.checked });
    } }, 'Render & download'))));
  sync();
}
async function runOfflineExport(o) {
  const end0 = tlEnd(), start = o.range === 'io' ? (P.inPt ?? 0) : 0, end = o.range === 'io' ? (P.outPt ?? end0) : end0;
  if (end - start < frame()) return toast('Range is empty', true);
  if (UI.playing) pause(); setMode('timeline');
  const bar = h('i'), lab = h('div', { class: 'note' }, 'Preparing…');
  $('#mbox').innerHTML = ''; $('#mbox').append(h('h2', {}, 'Rendering ' + o.name), h('div', { class: 'pbar' }, bar), lab, h('div', { class: 'foot' }, h('button', { onclick: cancelExport }, 'Cancel (Esc)')));
  EXP = { offline: true, cancelled: false };
  const ui = { prog: (p, s) => { bar.style.width = (p * 100).toFixed(1) + '%'; lab.textContent = s; } };
  try {
    const r = await exportOffline(o, ui);
    download(r.blob, o.name + '.mp4');
    toast(`Exported ${(r.blob.size / 1e6).toFixed(1)} MB · ${r.frames} frames in ${r.secs.toFixed(0)} s` + (r.audio ? '' : ' · no audio'));
    window.__lastExport = r;
  } catch (e) {
    if (e.message === 'cancelled') toast('Export cancelled'); else { console.error(e); toast('Export failed: ' + e.message, true); }
  } finally { EXP = null; $('#modal').hidden = true; }
}
async function waitReady() {
  for (let i = 0; i < 80; i++) {
    syncMedia(UI.t, false);
    if (!pool.some(p => p.clipId && (p.el.seeking || p.el.readyState < 2))) return;
    await new Promise(r => setTimeout(r, 50));
  }
}
async function startExport(o) {
  const end0 = tlEnd(), start = o.range === 'io' ? (P.inPt ?? 0) : 0, end = o.range === 'io' ? (P.outPt ?? end0) : end0;
  if (end - start < frame()) return toast('Range is empty', true);
  ensureAudio(); try { await actx.resume(); } catch (e) { }
  if (UI.playing) pause(); setMode('timeline');
  const prevScale = UI.pvScale, prevLoop = UI.loop; UI.pvScale = o.scale; UI.loop = false; resizePreview();
  exportSrcProxy = !!o.proxy;
  monitor.gain.value = o.mute ? 0 : 1;
  const bar = h('i'), lab = h('div', { class: 'note' }, 'Preparing…');
  const cancelBtn = h('button', { onclick: cancelExport }, 'Cancel (Esc)');
  $('#mbox').innerHTML = ''; $('#mbox').append(h('h2', {}, 'Rendering ' + o.name), h('div', { class: 'pbar' }, bar), lab, h('div', { class: 'foot' }, cancelBtn));
  const restore = () => { exportSrcProxy = null; UI.pvScale = prevScale; UI.loop = prevLoop; resizePreview(); monitor.gain.value = 1; EXP = null; $('#modal').hidden = true; };
  setTime(start); await waitReady(); renderPreview();
  const stream = pv.captureStream(fps()), at = recDest.stream.getAudioTracks()[0];
  if (at) stream.addTrack(at);
  let rec;
  try { rec = new MediaRecorder(stream, { mimeType: o.mime, videoBitsPerSecond: o.vbps, audioBitsPerSecond: 192000 }); }
  catch (e) { restore(); return toast('Recorder failed: ' + e.message, true); }
  const chunks = []; rec.ondataavailable = ev => { if (ev.data && ev.data.size) chunks.push(ev.data); };
  const stopped = new Promise(r => rec.onstop = r);
  EXP = { rec, start, end, cancelled: false, w0: performance.now(), hidden: false };
  EXP.progress = t => { const p = clamp((t - start) / (end - start), 0, 1); bar.style.width = (p * 100).toFixed(1) + '%'; lab.textContent = `${fmtTC(t - start)} / ${fmtTC(end - start)}  ·  ${Math.round(p * 100)}%` + (EXP.hidden ? '  ·  ⚠ tab was hidden — output may stutter' : ''); };
  const done = new Promise(r => EXP.done = r);
  rec.start(1000); play(1);
  await done;
  if (rec.state !== 'inactive') rec.stop();
  await stopped;
  stream.getVideoTracks().forEach(t => t.stop());
  const cancelled = EXP.cancelled; restore();
  if (cancelled) return toast('Export cancelled');
  const blob = new Blob(chunks, { type: o.mime.split(';')[0] });
  download(blob, o.name + (o.mime.startsWith('video/mp4') ? '.mp4' : '.webm'));
  toast(`Exported ${(blob.size / 1e6).toFixed(1)} MB`);
}
function finishExport() { if (EXP && EXP.done) { const d = EXP.done; EXP.done = null; UI.playing = false; syncMedia(UI.t, false); updPlayBtn(); d(); } }
function cancelExport() { if (!EXP) return; EXP.cancelled = true; finishExport(); }
document.addEventListener('visibilitychange', () => { if (EXP && document.hidden) EXP.hidden = true; });
function download(blob, name) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name.replace(/[\\/:*?"<>|]+/g, '_') });
  document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
}
function grabFrame() {
  const prev = UI.pvScale; UI.pvScale = 1; pv.width = P.settings.w; pv.height = P.settings.h; renderPreview();
  pv.toBlob(async b => {
    UI.pvScale = prev; resizePreview();
    if (!b) return;
    const t = UI.mode === 'source' ? srcT() : UI.t;
    const f = new File([b], `${P.name} ${fmtTC(t).replace(/:/g, '-')}.png`, { type: 'image/png' });
    const [m] = await importFiles([f], { quiet: true });
    if (m) { toast('Frame grabbed to the bin — drag it in, or hold E to append'); UI.binSel = m.id; renderBin(); }
  }, 'image/png');
}

/* ---------- project save / load / autosave ---------- */
function projectJSON() {
  return { app: 'ReelEdit', v: 1, saved: new Date().toISOString(), project: JSON.parse(snapState()),
    media: [...media.values()].map(m => ({ id: m.id, name: m.name, size: m.size, type: m.type, duration: isFinite(m.duration) ? m.duration : null, w: m.w, h: m.h, markIn: m.markIn ?? null, markOut: m.markOut ?? null })) };
}
function saveProject() {
  const blob = new Blob([JSON.stringify(projectJSON(), null, 1)], { type: 'application/json' });
  download(blob, (P.name || 'project') + '.reel.json'); toast('Project saved (media stays where it is — re-import to relink)');
}
function loadProject(o) {
  if (!o || o.app !== 'ReelEdit' || !o.project) throw new Error('Not a Reel Edit project');
  if (UI.playing) pause();
  const idMap = {};
  for (const mm of o.media || []) {
    const ex = [...media.values()].find(x => !x.offline && x.name === mm.name && (!mm.size || x.size === mm.size));
    if (ex) { idMap[mm.id] = ex.id; continue; }
    if (media.has(mm.id)) { idMap[mm.id] = mm.id; continue; }
    media.set(mm.id, { ...mm, duration: mm.duration == null ? Infinity : mm.duration, offline: true });
    idMap[mm.id] = mm.id;
  }
  loadState(JSON.stringify(o.project));
  for (const c of P.clips) if (c.media) c.media = idMap[c.media] || c.media;
  HIST.undo = []; HIST.redo = []; updUndoBtns();
  UI.sel.clear(); UI.selXf = null; UI.targetV = UI.targetA = null; UI.t = 0;
  $('#xfType').value = P.settings.xfType; $('#xfDur').value = P.settings.xfDur;
  afterRestore(); renderBin(); zoomFit();
  const off = [...media.values()].filter(m => m.offline && P.clips.some(c => c.media === m.id)).length;
  if (off) toast(`${off} media file${off > 1 ? 's' : ''} offline — drop the files in to relink`, true); else toast('Project loaded');
}
let asTimer = 0;
function scheduleAutosave() { clearTimeout(asTimer); asTimer = setTimeout(() => { try { localStorage.setItem('reeledit.autosave', JSON.stringify(projectJSON())); } catch (e) { } }, 900); }
function savePrefs() { try { localStorage.setItem('reeledit.prefs', JSON.stringify({ snap: UI.snap, autoX: UI.autoX, ripple: UI.ripple, tlh: getComputedStyle($('#app')).getPropertyValue('--tlh') })); } catch (e) { } }
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem('reeledit.prefs') || 'null'); if (!p) return;
    UI.snap = p.snap !== false; UI.autoX = p.autoX !== false; UI.ripple = !!p.ripple;
    if (p.tlh) $('#app').style.setProperty('--tlh', p.tlh);
  } catch (e) { }
}
function newProject() {
  if (P.clips.length && !confirm('Start a new project? The timeline is cleared (your media bin is kept).')) return;
  if (UI.playing) pause();
  P.clips = []; P.markers = []; P.inPt = P.outPt = null; P.name = 'Untitled Reel'; defaultTracks();
  HIST.undo = []; HIST.redo = []; updUndoBtns(); UI.sel.clear(); UI.selXf = null; UI.t = 0; UI.sx = 0;
  afterRestore(); renderBin();
}

/* ---------- wiring ---------- */
$('#bImport').onclick = () => $('#fileIn').click();
$('#fileIn').onchange = async e => { const fs = [...e.target.files]; e.target.value = ''; if (!fs.length) return; const r = pendingRelink; pendingRelink = null; await importFiles(fs, { relink: r && fs.length === 1 ? r : null }); renderBin(); };
$('#projIn').onchange = async e => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; try { loadProject(JSON.parse(await f.text())); } catch (err) { toast('Could not open: ' + err.message, true); } };
$('#bNew').onclick = newProject; $('#bOpen').onclick = () => $('#projIn').click(); $('#bSave').onclick = saveProject;
$('#bUndo').onclick = undo; $('#bRedo').onclick = redo; $('#bHelp').onclick = openHelp; $('#bExport').onclick = openExport;
$('#projName').onchange = e => { edit(() => { P.name = e.target.value.trim() || 'Untitled Reel'; }); };
$('#binFilter').oninput = renderBin;
$('#bText').onclick = () => addGenerator('text'); $('#bMatte').onclick = () => addGenerator('color');
$('#tabTL').onclick = () => setMode('timeline'); $('#tabSrc').onclick = () => setMode('source');
$('#tStart').onclick = () => UI.mode === 'source' ? srcSeek(0) : (setTime(0), UI.sx = 0);
$('#tEnd').onclick = () => UI.mode === 'source' ? srcSeek(UI.src.duration) : (setTime(tlEnd()), followPlayhead());
$('#tBack').onclick = () => UI.mode === 'source' ? srcStep(-1) : step(-1);
$('#tFwd').onclick = () => UI.mode === 'source' ? srcStep(1) : step(1);
$('#tPrevEdit').onclick = () => jumpEdit(-1); $('#tNextEdit').onclick = () => jumpEdit(1);
$('#tPlay').onclick = togglePlay; $('#tLoop').onclick = toggleLoop;
$('#pvQ').onchange = e => { UI.pvScale = +e.target.value; resizePreview(); };
$('#tGuides').onclick = () => { UI.guides = !UI.guides; $('#guides').classList.toggle('on', UI.guides); $('#tGuides').classList.toggle('on', UI.guides); };
$('#tGrab').onclick = grabFrame;
$('#tDiag').onclick = toggleDiag;
$('#tProxy').onclick = toggleProxy;
function toggleProxy() { UI.proxy = !UI.proxy; $('#tProxy').classList.toggle('on', UI.proxy); toast(UI.proxy ? 'Proxies on — smooth preview, full quality when stopped' : 'Proxies off — previewing original files'); changed(); }
$$('#tools button').forEach(b => b.onclick = () => setTool(b.dataset.tool));
$('#tgSnap').onclick = () => toggle('snap'); $('#tgX').onclick = () => toggle('autoX'); $('#tgRipple').onclick = () => toggle('ripple');
const xfSel = $('#xfType'); for (const [k, l] of Object.entries(XF)) xfSel.append(h('option', { value: k }, l));
xfSel.onchange = () => { P.settings.xfType = xfSel.value; scheduleAutosave(); renderInsp(); xfSel.blur(); };
$('#xfDur').onchange = e => { const v = parseFloat(e.target.value); if (v > 0) { P.settings.xfDur = clamp(v, 0.04, 10); scheduleAutosave(); } e.target.value = P.settings.xfDur; e.target.blur(); };
$('#aSplit').onclick = cmdSplit; $('#aXfade').onclick = cmdAddXfade; $('#aBeats').onclick = () => cmdBeats(); $('#aMarker').onclick = () => addMarker();
$('#zIn').onclick = () => setZoom(UI.pps * 1.5); $('#zOut').onclick = () => setZoom(UI.pps / 1.5); $('#zFit').onclick = zoomFit;
$('#zoom').oninput = e => setZoom(Math.pow(2, +e.target.value / 1000 * (Math.log2(2400) + 1) - 1));
$('#addV').onclick = () => { edit(() => addTrack('video')); renderHeads(); sizeTimeline(); };
$('#addA').onclick = () => { edit(() => addTrack('audio')); renderHeads(); sizeTimeline(); };
$('#tHeight').onclick = () => { UI.tScale = UI.tScale === 1 ? 1.45 : UI.tScale > 1 ? 0.7 : 1; renderHeads(); clampScroll(); dirtyTL = true; };
// source bar scrubbing
sb.addEventListener('pointerdown', e => {
  if (!UI.src || !srcEl) return; sb.setPointerCapture(e.pointerId);
  const go = ev => { const r = sb.getBoundingClientRect(); srcSeek(clamp((ev.clientX - r.left) / r.width, 0, 1) * UI.src.duration); };
  go(e); sb.onpointermove = ev => { if (ev.buttons) go(ev); }; sb.onpointerup = () => { sb.onpointermove = null; };
});
// dragging from the Source viewer onto the timeline
$('#stage').draggable = true;
$('#stage').addEventListener('dragstart', e => { if (UI.mode !== 'source' || !UI.src) { e.preventDefault(); return; } UI.dragMedia = UI.src; e.dataTransfer.setData('text/plain', UI.src.name); e.dataTransfer.effectAllowed = 'copy'; });
$('#stage').addEventListener('dragend', () => { UI.dragMedia = null; UI.ghost = null; dirtyTL = true; });
// splitter
$('#split').addEventListener('pointerdown', e => {
  const sp = $('#split'); sp.setPointerCapture(e.pointerId);
  sp.onpointermove = ev => { const hh = clamp(innerHeight - ev.clientY - 3, 150, innerHeight - 260); $('#app').style.setProperty('--tlh', hh + 'px'); onResize(); };
  sp.onpointerup = () => { sp.onpointermove = null; savePrefs(); };
});
// OS file drops anywhere
let dragDepth = 0;
const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
addEventListener('dragenter', e => { if (hasFiles(e)) { dragDepth++; $('#dropOverlay').hidden = false; } });
addEventListener('dragleave', e => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; $('#dropOverlay').hidden = true; } });
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', async e => { e.preventDefault(); dragDepth = 0; $('#dropOverlay').hidden = true; if (e.dataTransfer.files.length) { await importFiles([...e.dataTransfer.files]); renderBin(); } });
addEventListener('pointerdown', ensureAudio, { once: true });
addEventListener('beforeunload', e => { if (P.clips.length) { try { localStorage.setItem('reeledit.autosave', JSON.stringify(projectJSON())); } catch (_) { } } });

/* ---------- guides & meter ---------- */
function buildGuides() {
  const g = $('#guides'); g.innerHTML = '';
  const box = (l, t, w, hh, cls = '') => g.append(h('div', { class: cls, style: `left:${l}%;top:${t}%;width:${w}%;height:${hh}%` }));
  box(5, 5, 90, 90); box(10, 10, 80, 80);
  for (const f of [33.333, 66.666]) { box(f, 0, 0.12, 100, 'th'); box(0, f, 100, 0.2, 'th'); }
  if (P.settings.h > P.settings.w) { box(0, 0, 100, 12, 'zone'); box(0, 78, 100, 22, 'zone'); box(84, 45, 16, 33, 'zone'); }
}
const mt = $('#meter'), mg = mt.getContext('2d');
function drawMeter() {
  if (!analyser) return;
  analyser.getFloatTimeDomainData(meterBuf);
  let pk = 0; for (let i = 0; i < meterBuf.length; i++) { const v = Math.abs(meterBuf[i]); if (v > pk) pk = v; }
  meterPk = Math.max(pk, meterPk * 0.9);
  const W = mt.width, H = mt.height, k = clamp((20 * Math.log10(meterPk + 1e-9) + 60) / 60, 0, 1);
  mg.fillStyle = '#000'; mg.fillRect(0, 0, W, H);
  const gr = mg.createLinearGradient(0, H, 0, 0); gr.addColorStop(0, '#2f9e5f'); gr.addColorStop(0.75, '#d4b13a'); gr.addColorStop(1, '#ff4d5e');
  mg.fillStyle = gr; mg.fillRect(0, H * (1 - k), W, H * k);
}

/* ---------- boot ---------- */
function onResize() { sizeTimeline(); fitStage(); sizeSrcBar(); drawSrcBar(); const r = mt.getBoundingClientRect(); mt.height = Math.max(20, Math.round(r.height)); dirtyPV = dirtyTL = true; }
addEventListener('resize', onResize);
new ResizeObserver(onResize).observe($('#tlWrap'));
function frameLoop(now) {
  requestAnimationFrame(frameLoop);
  if (UI.playing) {
    let t = t0 + (now - p0) / 1000 * UI.rate;
    // slave the clock to a playing clip instead of seeking the clip to the clock:
    // players start a little late, and mid-play seeks on long-GOP camera files freeze the picture
    if (UI.rate > 0) {
      const ok = p => p.clipId && !p.el.paused && !p.el.seeking && p.el.readyState >= 3;
      const lead = pool.find(p => ok(p) && (p.role === 'snd' || p.role === 'av')) || pool.find(ok);
      const c = lead && clipById(lead.clipId);
      if (c && t >= c.start && t < cend(c)) {
        const d = c.start + (lead.el.currentTime - c.in) / c.speed - t;
        if (Math.abs(d) < 0.6) { t0 += d * 0.3; t += d * 0.3; }
      }
    }
    if (EXP) { if (t >= EXP.end) { t = EXP.end; UI.t = t; renderPreview(); finishExport(); } else if (EXP.progress) EXP.progress(t); }
    else {
      const s = playStart(), e = playEnd();
      if (UI.rate > 0 && t >= e) { if (UI.loop && e > s + frame()) { t = s; t0 = s; p0 = now; } else { UI.t = e; pause(); t = e; } }
      else if (UI.rate < 0 && t <= 0) { UI.t = 0; pause(); t = 0; }
    }
    if (UI.playing) { UI.t = t; syncMedia(t, UI.rate > 0); followPlayhead(); }
    dirtyPV = true; phDirty = true;
  }
  if (UI.mode === 'source' && srcEl && !srcEl.paused) { dirtyPV = true; drawSrcBar(); }
  if (dirtyPV) { dirtyPV = false; renderPreview(); }
  if (dirtyTL) { dirtyTL = false; phDirty = false; drawTimeline(); }
  else if (phDirty) { phDirty = false; blitTimeline(); }
  drawMeter(); updTC();
  // preview can't keep up at full size → drop to ½ (export is unaffected)
  if (UI.playing && !EXP && UI.pvScale === 1 && pvDrawMs > 14) { if (++slowFrames > 45) { slowFrames = 0; UI.pvScale = 0.5; $('#pvQ').value = '0.5'; resizePreview(); toast('Preview switched to ½ size to keep up with playback (export is still full size)'); } }
  else slowFrames = 0;
  fpsCount++;
  if (now - lastTick > 250) {
    if (!UI.playing && !UI.drag) trimPool();
    if (diagOn) updDiag(fpsCount * 1000 / (now - lastTick));
    fpsCount = 0; lastTick = now;
  }
}
let phDirty = false, slowFrames = 0, fpsCount = 0, lastTick = 0, diagOn = false;
function toggleDiag() { diagOn = !diagOn; $('#diag').hidden = !diagOn; $('#tDiag').classList.toggle('on', diagOn); }
function updDiag(fpsNow) {
  const lines = [`preview ${pvDrawMs.toFixed(1)} ms · timeline ${tlDrawMs.toFixed(1)} ms · ${Math.round(fpsNow)} fps · ${UI.pvScale === 1 ? 'full' : UI.pvScale === 0.5 ? '½' : '¼'} preview`];
  for (const p of pool) {
    if (!p.clipId) continue;
    const c = clipById(p.clipId); if (!c) continue;
    const el = p.el, want = c.in + (UI.t - c.start) * c.speed;
    let s = `${(c.name || '').slice(0, 18).padEnd(18)} ${p.role.padEnd(3)} drift ${((el.currentTime - want) * 1000).toFixed(0).padStart(5)} ms`;
    if (p.kind === 'video' && !(p.role === 'hq' && UI.playing)) {
      const lag = el._mt != null && !el.paused ? ((el.currentTime - el._mt) * 1000).toFixed(0) : '–';
      const qy = el.getVideoPlaybackQuality ? el.getVideoPlaybackQuality() : null;
      s += ` · frame lag ${String(lag).padStart(4)} ms` + (qy ? ` · dropped ${qy.droppedVideoFrames}/${qy.totalVideoFrames}` : '') + ` · ${el.videoWidth}×${el.videoHeight}`;
    }
    s += el.paused ? ' · paused' : '' ; s += el.readyState < 3 ? ' · BUFFERING' : '';
    lines.push(s);
  }
  $('#diag').textContent = lines.join('\n');
}
function boot() {
  loadPrefs();
  $('#tgSnap').classList.toggle('on', UI.snap); $('#tgX').classList.toggle('on', UI.autoX); $('#tgRipple').classList.toggle('on', UI.ripple);
  defaultTracks();
  xfSel.value = P.settings.xfType; $('#xfDur').value = P.settings.xfDur;
  renderHeads(); renderBin(); renderInsp(); updUndoBtns();
  onResize(); resizePreview(); setZoom(UI.pps, 0);
  requestAnimationFrame(frameLoop);
  try {
    const s = JSON.parse(localStorage.getItem('reeledit.autosave') || 'null');
    if (s && s.project && s.project.clips && s.project.clips.length) {
      const bn = $('#banner'); bn.innerHTML = '';
      bn.append(h('span', {}, `Restore your last session “${s.project.name}” (${s.project.clips.length} clips, ${new Date(s.saved).toLocaleString()})? You'll re-drop the media files to relink them.`),
        h('button', { class: 'primary', onclick: () => { bn.hidden = true; try { loadProject(s); } catch (e) { toast(e.message, true); } } }, 'Restore'),
        h('button', { onclick: () => { bn.hidden = true; } }, 'Dismiss'));
      bn.hidden = false;
    }
  } catch (e) { }
  let seen = false; try { seen = !!localStorage.getItem('reeledit.seenHelp'); localStorage.setItem('reeledit.seenHelp', '1'); } catch (e) { }
  if (!seen) setTimeout(() => toast('Drop some clips in to start — press ? for shortcuts'), 600);
}
/* ---------- version & updates ----------
   APP_VER comes from version.json at build time. The feed is a small public latest.json
   ({version, build, date, url, notes}); a higher build number than ours means a newer release. */
const fmtDay = d => { try { return new Date(d + 'T12:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return d; } };
const verLine = () => `Reel Edit v${APP_VER.version} · build ${APP_VER.build} · ${fmtDay(APP_VER.date)}`;
let newRelease = null;
async function checkUpdates(manual) {
  if (!APP_VER.feed) { if (manual) toast('No update feed is set for this build', true); return; }
  try {
    const r = await fetch(APP_VER.feed + '?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (!(+j.build > APP_VER.build)) { if (manual) toast(`You're up to date: v${APP_VER.version} (build ${APP_VER.build})`); return; }
    newRelease = j;
    const b = $('#upd'); b.textContent = `Update available: v${j.version}`; b.title = `Build ${j.build} · ${fmtDay(j.date)} — you have v${APP_VER.version} (build ${APP_VER.build})`; b.hidden = false;
    if (manual) openUpdate();
  } catch (e) { if (manual) toast("Couldn't check for updates: " + e.message, true); }
}
function openUpdate() {
  const j = newRelease; if (!j) return;
  openModal(h('div', {}, h('h2', {}, `Reel Edit v${j.version} is available`),
    h('p', {}, `Build ${j.build} · released ${fmtDay(j.date)}. You have v${APP_VER.version} (build ${APP_VER.build}, ${fmtDay(APP_VER.date)}).`),
    j.notes ? h('p', { style: 'white-space:pre-line' }, j.notes) : null,
    h('p', { style: 'color:var(--tx2)' }, DESKTOP ? 'Download the new zip, close Reel Edit and replace ReelEdit.exe with the new one. Your settings and autosave stay.' : 'Download the new zip and open the new ReelEdit.html.'),
    h('div', { class: 'foot' }, h('button', { onclick: closeModal }, 'Later'),
      j.url ? h('button', { class: 'primary', onclick: () => { window.open(j.url, '_blank', 'noopener'); closeModal(); } }, 'Download') : null)));
}
$('#ver').textContent = 'v' + APP_VER.version; $('#ver').title = verLine();
$('#upd').onclick = openUpdate;
setTimeout(() => checkUpdates(false), 4000); setInterval(() => checkUpdates(false), 6 * 3600e3);

/* ---------- desktop shell bridge (ReelEdit.exe hosts this page in WebView2) ---------- */
const DESKTOP = !!(window.chrome && window.chrome.webview);
if (DESKTOP) {
  // files dropped on the exe / "Open with" arrive as URLs the shell streams from disk
  window.chrome.webview.addEventListener('message', async e => {
    const d = e.data; if (!d || d.type !== 'open') return;
    const files = [];
    for (const f of d.files) {
      try { files.push(new File([await (await fetch(f.url)).blob()], f.name)); } catch (err) { toast('Could not open ' + f.name, true); }
    }
    const proj = files.find(f => /\.json$/i.test(f.name));
    if (proj) { try { loadProject(JSON.parse(await proj.text())); } catch (err) { toast('Could not open project: ' + err.message, true); } }
    const med = files.filter(f => f !== proj);
    if (med.length) { await importFiles(med); renderBin(); }
  });
}
window.ReelEdit = { P, UI, media, importFiles, placeMedia, resolveDrop, clipsOn, cend, cdur, trackValid, edit, setTime, play, pause, cmdSplit, cmdAddXfade, detectBeats, cmdBeats, beatCut, undo, redo, renderBin, changed, renderHeads };
boot();
