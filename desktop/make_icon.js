// Draws the Reel Edit logo (film frame + play triangle) into a multi-size .ico. No dependencies.
const fs = require('fs'), path = require('path'), zlib = require('zlib');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(w, h, rgba) {
  const chunk = (type, data) => { const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length, 0); b.write(type, 4, 'latin1'); data.copy(b, 8); b.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 8 + data.length); return b; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
// signed distance helpers (unit square coords 0..1)
const sdRoundBox = (x, y, cx, cy, hw, hh, r) => { const qx = Math.abs(x - cx) - hw + r, qy = Math.abs(y - cy) - hh + r; return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r; };
function sdTri(x, y, a, b, c) { // inside-negative distance to triangle
  const ed = (px, py, ax, ay, bx, by) => { const ex = bx - ax, ey = by - ay, wx = px - ax, wy = py - ay, t = Math.max(0, Math.min(1, (wx * ex + wy * ey) / (ex * ex + ey * ey))); return [Math.hypot(wx - ex * t, wy - ey * t), ex * wy - ey * wx]; };
  const e = [ed(x, y, ...a, ...b), ed(x, y, ...b, ...c), ed(x, y, ...c, ...a)];
  const d = Math.min(e[0][0], e[1][0], e[2][0]), inside = e.every(v => v[1] >= 0) || e.every(v => v[1] <= 0);
  return inside ? -d : d;
}
function render(N) {
  const out = Buffer.alloc(N * N * 4), ss = 4;
  const ORANGE = [255, 138, 61], BG = [20, 22, 27];
  for (let py = 0; py < N; py++) for (let px = 0; px < N; px++) {
    let acc = [0, 0, 0, 0];
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const x = (px + (sx + 0.5) / ss) / N, y = (py + (sy + 0.5) / ss) / N;
      let col = null, a = 0;
      if (sdRoundBox(x, y, 0.5, 0.5, 0.48, 0.48, 0.2) < 0) { col = BG; a = 1; }
      const frame = sdRoundBox(x, y, 0.5, 0.5, 0.36, 0.27, 0.07);
      if (Math.abs(frame) < 0.035) col = ORANGE;
      for (const fx of [0.3, 0.7]) if (Math.abs(x - fx) < 0.012 && Math.abs(y - 0.5) < 0.25) col = [200, 110, 50];
      if (sdTri(x, y, [0.43, 0.38], [0.43, 0.62], [0.62, 0.5]) < 0) col = ORANGE;
      if (a) { acc[0] += col[0]; acc[1] += col[1]; acc[2] += col[2]; acc[3] += 255; }
    }
    const n = ss * ss, o = (py * N + px) * 4, al = acc[3] / n;
    out[o] = al ? acc[0] / (acc[3] / 255) : 0; out[o + 1] = al ? acc[1] / (acc[3] / 255) : 0; out[o + 2] = al ? acc[2] / (acc[3] / 255) : 0; out[o + 3] = al;
  }
  return png(N, N, out);
}
const sizes = [256, 64, 48, 32, 24, 16], imgs = sizes.map(render);
const head = Buffer.alloc(6 + 16 * sizes.length); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
let off = head.length;
sizes.forEach((s, i) => { const e = 6 + i * 16; head[e] = s >= 256 ? 0 : s; head[e + 1] = s >= 256 ? 0 : s; head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6); head.writeUInt32LE(imgs[i].length, e + 8); head.writeUInt32LE(off, e + 12); off += imgs[i].length; });
fs.writeFileSync(path.join(__dirname, 'app.ico'), Buffer.concat([head, ...imgs]));
fs.writeFileSync(path.join(__dirname, 'icon_preview.png'), imgs[0]);
console.log('app.ico written');
