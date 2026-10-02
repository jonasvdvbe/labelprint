// labelcore.js – pure functions (no DOM) for LabelPrint:
// label detection, 1‑bit conversion and printer language encoders.

export const LABEL_SIZES = [
  { id: "102x152", name: "4 × 6 in (102 × 152 mm) – standard shipping", w: 101.6, h: 152.4 },
  { id: "100x150", name: "100 × 150 mm – shipping (EU)", w: 100, h: 150 },
  { id: "100x100", name: "100 × 100 mm", w: 100, h: 100 },
  { id: "102x102", name: "4 × 4 in (102 × 102 mm)", w: 101.6, h: 101.6 },
  { id: "100x200", name: "100 × 200 mm", w: 100, h: 200 },
  { id: "102x76", name: "4 × 3 in (102 × 76 mm)", w: 101.6, h: 76.2 },
  { id: "104x159", name: "Dymo 4XL 1744907 (104 × 159 mm)", w: 104, h: 159 },
  { id: "54x101", name: "Dymo 99014 (54 × 101 mm)", w: 54, h: 101 },
  { id: "62x100", name: "Brother DK‑11202 (62 × 100 mm)", w: 62, h: 100 },
  { id: "103x164", name: "Brother DK‑11241 (102 × 152 mm, 103 × 164 roll)", w: 102, h: 152 },
  { id: "57x32", name: "57 × 32 mm", w: 57, h: 32 },
  { id: "custom", name: "Custom size…", w: 100, h: 150 },
];

export const LANGUAGES = [
  { id: "zpl", name: "ZPL – Zebra (GK420d, ZD‑series, GX, ZT…) & ZPL emulation" },
  { id: "epl", name: "EPL2 – older Zebra/Eltron (LP/TLP 2844…)" },
  { id: "tspl", name: "TSPL – TSC, Xprinter, Munbyn, iDPRT, HPRT, Polono…" },
  { id: "driver", name: "Windows driver – any brand (Dymo, Brother, Rollo, …)" },
];

export const CROP_PRESETS = [
  { id: "auto", name: "Auto – detect the label" },
  { id: "auto-multi", name: "Auto – every label on the page separately" },
  { id: "full", name: "Whole page" },
  { id: "content", name: "All content (trim white margins)" },
  { id: "top", name: "Top half", r: [0, 0, 1, 0.5] },
  { id: "bottom", name: "Bottom half", r: [0, 0.5, 1, 0.5] },
  { id: "left", name: "Left half", r: [0, 0, 0.5, 1] },
  { id: "right", name: "Right half", r: [0.5, 0, 0.5, 1] },
  { id: "tl", name: "Top‑left quarter", r: [0, 0, 0.5, 0.5] },
  { id: "tr", name: "Top‑right quarter", r: [0.5, 0, 0.5, 0.5] },
  { id: "bl", name: "Bottom‑left quarter", r: [0, 0.5, 0.5, 0.5] },
  { id: "br", name: "Bottom‑right quarter", r: [0.5, 0.5, 0.5, 0.5] },
  { id: "manual", name: "Manual – drag a rectangle on the page" },
];

export const mmToDots = (mm, dpi) => Math.round((mm / 25.4) * dpi);

// ---------------------------------------------------------------------------
// Luminance helpers

/** RGBA ImageData-like → Uint8Array luminance (transparent = white). */
export function toLuma(rgba, w, h) {
  const out = new Uint8Array(w * h);
  for (let i = 0, j = 0; j < out.length; i += 4, j++) {
    const a = rgba[i + 3] / 255;
    const l = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    out[j] = Math.round(l * a + 255 * (1 - a));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Label detection
//
// Works on a low resolution luminance image of a page. Steps:
//  1. ink mask
//  2. remove long thin lines that span much of the page (scissor / cut lines),
//     because they would glue the label to the instructions next to it
//  3. dilate a few mm so that the elements of one label merge into a blob
//  4. connected components → candidate blocks, scored on size, ink density,
//     border presence and similarity to the target label aspect ratio

export function detectBlocks(luma, w, h, pxPerMm, opts = {}) {
  const inkThr = opts.inkThreshold ?? 190;
  const targetAspect = opts.targetAspect ?? 1.5;
  const ink = new Uint8Array(w * h);
  let total = 0;
  for (let i = 0; i < ink.length; i++) if (luma[i] < inkThr) { ink[i] = 1; total++; }
  if (total === 0) return [];
  const integral = integralImage(ink, w, h);
  const inkIn = (x0, y0, x1, y1) => integral[(y1 + 1) * (w + 1) + x1 + 1] - integral[y0 * (w + 1) + x1 + 1] - integral[(y1 + 1) * (w + 1) + x0] + integral[y0 * (w + 1) + x0];
  const aspectScore = (bw, bh) => Math.exp(-Math.abs(Math.log(Math.max(bw, bh) / Math.min(bw, bh) / targetAspect)) * 1.2);
  const pageArea = w * h;

  // A) rectangles drawn around a label (most carriers draw a frame) – strongest signal
  const boxes = [];
  for (const c of components(dilate(ink, w, h, Math.max(1, Math.round(0.7 * pxPerMm))), ink, w, h)) {
    const bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1;
    if (bw < 25 * pxPerMm || bh < 25 * pxPerMm) continue;
    if (bw * bh > 0.85 * pageArea) continue; // a frame around the whole page
    const border = borderScore(ink, w, c.x0, c.y0, c.x1, c.y1, Math.max(2, Math.round(1.2 * pxPerMm)));
    if (border < 0.7) continue;
    boxes.push({ x: c.x0, y: c.y0, w: bw, h: bh, border });
  }
  // keep only outermost boxes
  const outer = boxes.filter((b) => !boxes.some((o) => o !== b && o.w * o.h > b.w * b.h && overlap(b, o) > 0.9 * b.w * b.h));

  // B) blobs of content (for labels without a frame)
  removeCutLines(ink, w, h, pxPerMm);
  const blobs = [];
  const rad = Math.max(2, Math.round(2.5 * pxPerMm));
  for (const c of components(dilate(ink, w, h, rad), ink, w, h)) {
    const bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1;
    const b = { x: c.x0, y: c.y0, w: bw, h: bh };
    if (outer.some((o) => overlap(b, o) > 0.5 * o.w * o.h || overlap(b, o) > 0.85 * bw * bh)) continue;
    blobs.push(b);
  }

  // labels without a frame consist of separate blobs (address, barcode, …) – group
  // nearby blobs as long as the group still fits the physical label size
  if (opts.labelMM && blobs.length > 1 && blobs.length < 400) {
    const capL = Math.max(...opts.labelMM) * 1.12 * pxPerMm, capS = Math.min(...opts.labelMM) * 1.12 * pxPerMm;
    const maxGap = 40 * pxPerMm;
    const union = (a, b) => {
      const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
      return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
    };
    const gap = (a, b) => Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w), a.y - (b.y + b.h), b.y - (a.y + a.h));
    for (;;) {
      let best = null;
      for (let i = 0; i < blobs.length; i++) for (let j = i + 1; j < blobs.length; j++) {
        const g = gap(blobs[i], blobs[j]);
        if (g > maxGap || (best && g >= best.g)) continue;
        const u = union(blobs[i], blobs[j]);
        if (Math.max(u.w, u.h) > capL || Math.min(u.w, u.h) > capS) continue;
        if (outer.some((o) => overlap(u, o) > 0)) continue;
        best = { i, j, g, u };
      }
      if (!best) break;
      blobs[best.i] = best.u;
      blobs.splice(best.j, 1);
    }
  }

  const minSide = 12 * pxPerMm;
  const bigBlobs = blobs.filter((b) => b.w >= minSide && b.h >= minSide);
  const result = [];
  for (const b of outer) {
    const area = b.w * b.h, density = inkIn(b.x, b.y, b.x + b.w - 1, b.y + b.h - 1) / area;
    if (density < 0.02) continue; // empty frame
    result.push({ ...b, area, density, framed: true, score: area * Math.sqrt(Math.min(density, 0.5)) * (0.5 + aspectScore(b.w, b.h)) * 2 });
  }
  for (const b of bigBlobs) {
    const area = b.w * b.h, density = inkIn(b.x, b.y, b.x + b.w - 1, b.y + b.h - 1) / area;
    result.push({ ...b, area, density, framed: false, score: area * Math.sqrt(Math.min(density, 0.5)) * (0.5 + aspectScore(b.w, b.h)) });
  }
  result.sort((a, b) => b.score - a.score);
  return result;
}

function overlap(a, b) {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  return x1 > x0 && y1 > y0 ? (x1 - x0) * (y1 - y0) : 0;
}

function integralImage(m, w, h) {
  const I = new Uint32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) { row += m[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row; }
  }
  return I;
}

/** connected components (4-connectivity) of mask; bbox computed from the real ink */
function components(mask, ink, w, h) {
  const lab = new Int32Array(w * h);
  const comps = [];
  const stack = new Int32Array(w * h);
  let next = 0;
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || lab[s]) continue;
    next++;
    let sp = 0; stack[sp++] = s; lab[s] = next;
    while (sp) {
      const p = stack[--sp];
      const x = p % w;
      if (x > 0 && mask[p - 1] && !lab[p - 1]) { lab[p - 1] = next; stack[sp++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && !lab[p + 1]) { lab[p + 1] = next; stack[sp++] = p + 1; }
      if (p >= w && mask[p - w] && !lab[p - w]) { lab[p - w] = next; stack[sp++] = p - w; }
      if (p + w < mask.length && mask[p + w] && !lab[p + w]) { lab[p + w] = next; stack[sp++] = p + w; }
    }
    comps.push({ x0: w, y0: h, x1: -1, y1: -1, ink: 0 });
  }
  for (let y = 0, p = 0; y < h; y++) {
    for (let x = 0; x < w; x++, p++) {
      if (!ink[p] || !lab[p]) continue;
      const c = comps[lab[p] - 1];
      c.ink++;
      if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x;
      if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
    }
  }
  return comps.filter((c) => c.ink > 0);
}

/** bounding box of all ink (for "trim white margins") */
export function contentBox(luma, w, h, thr = 230) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0, p = 0; y < h; y++) for (let x = 0; x < w; x++, p++) {
    if (luma[p] < thr) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function borderScore(ink, w, x0, y0, x1, y1, band = 2) {
  // fraction of each edge that has ink within `band` px inwards; returns the weakest edge
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  const edge = (n, hit) => { let c = 0; for (let i = 0; i < n; i++) if (hit(i)) c++; return c / n; };
  const rowHit = (y, dir) => (i) => { for (let k = 0; k < band; k++) { const yy = y + dir * k; if (yy >= y0 && yy <= y1 && ink[yy * w + x0 + i]) return true; } return false; };
  const colHit = (x, dir) => (i) => { for (let k = 0; k < band; k++) { const xx = x + dir * k; if (xx >= x0 && xx <= x1 && ink[(y0 + i) * w + xx]) return true; } return false; };
  return Math.min(edge(bw, rowHit(y0, 1)), edge(bw, rowHit(y1, -1)), edge(bh, colHit(x0, 1)), edge(bh, colHit(x1, -1)));
}

function removeCutLines(ink, w, h, pxPerMm) {
  const near = Math.max(2, Math.ceil(1.2 * pxPerMm));
  const lineRows = [];
  for (let y = 0; y < h; y++) {
    const r = analyseLine((i) => ink[y * w + i], w);
    if (!r) continue;
    if (r.extent > 0.5 * w && r.runs >= 8) {
      const quiet = (yy) => yy < 0 || yy >= h || countRange((i) => ink[yy * w + i], r.first, r.last) < 0.03 * r.extent;
      if (quiet(y - near) && quiet(y + near)) lineRows.push(y);
    }
  }
  const lineCols = [];
  for (let x = 0; x < w; x++) {
    const r = analyseLine((i) => ink[i * w + x], h);
    if (!r) continue;
    if (r.extent > 0.5 * h && r.runs >= 8) {
      const quiet = (xx) => xx < 0 || xx >= w || countRange((i) => ink[i * w + xx], r.first, r.last) < 0.03 * r.extent;
      if (quiet(x - near) && quiet(x + near)) lineCols.push(x);
    }
  }
  for (const y of lineRows) ink.fill(0, y * w, y * w + w);
  for (const x of lineCols) for (let y = 0; y < h; y++) ink[y * w + x] = 0;
}

function analyseLine(get, n) {
  let first = -1, last = -1, runs = 0, prev = 0;
  for (let i = 0; i < n; i++) {
    const v = get(i);
    if (v) { if (first < 0) first = i; last = i; if (!prev) runs++; }
    prev = v;
  }
  if (first < 0) return null;
  return { first, last, extent: last - first + 1, runs };
}

function countRange(get, a, b) { let c = 0; for (let i = a; i <= b; i++) if (get(i)) c++; return c; }

function dilate(mask, w, h, r) {
  // separable square dilation using running counts
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let cnt = 0; const o = y * w;
    for (let x = 0; x < Math.min(r, w); x++) cnt += mask[o + x];
    for (let x = 0; x < w; x++) {
      if (x + r < w) cnt += mask[o + x + r];
      if (x - r - 1 >= 0) cnt -= mask[o + x - r - 1];
      tmp[o + x] = cnt > 0 ? 1 : 0;
    }
  }
  for (let x = 0; x < w; x++) {
    let cnt = 0;
    for (let y = 0; y < Math.min(r, h); y++) cnt += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      if (y + r < h) cnt += tmp[(y + r) * w + x];
      if (y - r - 1 >= 0) cnt -= tmp[(y - r - 1) * w + x];
      out[y * w + x] = cnt > 0 ? 1 : 0;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1-bit conversion

/**
 * Convert luminance to a packed 1-bit bitmap (MSB first, 1 = black).
 * mode: "threshold" (crisp, best for barcodes) or "dither" (Floyd–Steinberg, for photos/logos)
 */
export function toMono(luma, w, h, { mode = "threshold", threshold = 128 } = {}) {
  const bpr = Math.ceil(w / 8);
  const bits = new Uint8Array(bpr * h);
  if (mode === "dither") {
    const buf = new Float32Array(luma);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const old = buf[i];
        const nv = old < threshold ? 0 : 255;
        const err = old - nv;
        if (nv === 0) bits[y * bpr + (x >> 3)] |= 0x80 >> (x & 7);
        if (x + 1 < w) buf[i + 1] += (err * 7) / 16;
        if (y + 1 < h) {
          if (x > 0) buf[i + w - 1] += (err * 3) / 16;
          buf[i + w] += (err * 5) / 16;
          if (x + 1 < w) buf[i + w + 1] += err / 16;
        }
      }
    }
  } else {
    for (let y = 0; y < h; y++) {
      const o = y * w, ro = y * bpr;
      for (let x = 0; x < w; x++) if (luma[o + x] < threshold) bits[ro + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return { w, h, bpr, bits };
}

export function monoGet(m, x, y) { return (m.bits[y * m.bpr + (x >> 3)] >> (7 - (x & 7))) & 1; }

/** rotate 180° and/or shift (dots) a mono bitmap */
export function monoTransform(m, { flip = false, dx = 0, dy = 0 } = {}) {
  if (!flip && !dx && !dy) return m;
  const out = { w: m.w, h: m.h, bpr: m.bpr, bits: new Uint8Array(m.bits.length) };
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
    if (!monoGet(m, x, y)) continue;
    let nx = flip ? m.w - 1 - x : x, ny = flip ? m.h - 1 - y : y;
    nx += dx; ny += dy;
    if (nx < 0 || ny < 0 || nx >= m.w || ny >= m.h) continue;
    out.bits[ny * out.bpr + (nx >> 3)] |= 0x80 >> (nx & 7);
  }
  return out;
}

export function monoBlackRatio(m) {
  let c = 0;
  for (const b of m.bits) { let v = b; while (v) { c += v & 1; v >>= 1; } }
  return c / (m.w * m.h);
}

// ---------------------------------------------------------------------------
// Encoders – each returns a Uint8Array ready to send RAW to the printer.

const enc = new TextEncoder();
const concat = (parts) => {
  const arrs = parts.map((p) => (typeof p === "string" ? enc.encode(p) : p));
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};

const HEX = "0123456789ABCDEF";

/** ZPL ACS ("alternative compression scheme") repeat count prefix */
function zplCount(n) {
  let s = "";
  const hi = Math.floor(n / 20), lo = n % 20;
  if (hi) s += String.fromCharCode(0x67 + hi - 1); // g..z = 20..400
  if (lo) s += String.fromCharCode(0x47 + lo - 1); // G..Y = 1..19
  return s;
}

/** Compress one row of hex chars with the ZPL ACS scheme. */
export function zplCompressRow(hex) {
  // trailing zeros / ones can be replaced by "," / "!"
  let end = hex.length, tail = "";
  if (hex.endsWith("0")) { while (end > 0 && hex[end - 1] === "0") end--; tail = ","; }
  else if (hex.endsWith("F")) { while (end > 0 && hex[end - 1] === "F") end--; tail = "!"; }
  if (end === hex.length) tail = "";
  let out = "";
  let i = 0;
  while (i < end) {
    const c = hex[i];
    let j = i + 1;
    while (j < end && hex[j] === c) j++;
    let n = j - i;
    while (n > 400) { out += "z" + c; n -= 400; }
    out += n === 1 ? c : zplCount(n) + c;
    i = j;
  }
  return out + tail;
}

export function zplGraphic(m, compress = true) {
  const rows = [];
  let prev = null;
  for (let y = 0; y < m.h; y++) {
    let hex = "";
    const o = y * m.bpr;
    for (let i = 0; i < m.bpr; i++) { const b = m.bits[o + i]; hex += HEX[b >> 4] + HEX[b & 15]; }
    if (!compress) { rows.push(hex); continue; }
    if (hex === prev) rows.push(":");
    else rows.push(zplCompressRow(hex));
    prev = hex;
  }
  const total = m.bpr * m.h;
  return `^GFA,${total},${total},${m.bpr},${rows.join("")}`;
}

export function encodeZPL(labels, o) {
  let s = "";
  for (const m of labels) {
    s += "^XA";
    if (o.media === "gap") s += "^MNY"; else if (o.media === "mark") s += "^MNM"; else if (o.media === "continuous") s += "^MNN";
    s += `^PW${m.bpr * 8}^LL${m.h}^LH0,0^LS0^PON^PMN^FWN`;
    if (o.darkness !== undefined && o.darkness !== null && o.darkness !== "") s += `^MD${o.darkness}`;
    if (o.speed) s += `^PR${o.speed}`;
    s += `\n^FO0,0${zplGraphic(m, o.compress !== false)}^FS\n`;
    s += `^PQ${Math.max(1, o.copies | 0)},0,1,Y^XZ\n`;
  }
  return enc.encode(s);
}

function invertedBits(m) {
  const out = new Uint8Array(m.bits.length);
  for (let i = 0; i < out.length; i++) out[i] = ~m.bits[i] & 0xff;
  return out;
}

export function encodeEPL(labels, o) {
  const parts = [];
  for (const m of labels) {
    parts.push("\r\nN\r\n");
    parts.push(`q${m.bpr * 8}\r\n`);
    if (o.media === "continuous") parts.push(`Q${m.h},0\r\n`);
    else if (o.media === "gap") parts.push(`Q${m.h},${Math.round((o.gapMM ?? 3) / 25.4 * o.dpi)}\r\n`);
    else if (o.media === "mark") parts.push(`Q${m.h},B${Math.round((o.gapMM ?? 3) / 25.4 * o.dpi)}+0\r\n`);
    if (o.darkness !== undefined && o.darkness !== null && o.darkness !== "") parts.push(`D${Math.max(0, Math.min(15, o.darkness | 0))}\r\n`);
    if (o.speed) parts.push(`S${Math.max(1, Math.min(6, o.speed | 0))}\r\n`);
    parts.push("ZT\r\n");
    parts.push(`GW0,0,${m.bpr},${m.h},`); // EPL: 0 = black dot
    parts.push(invertedBits(m));
    parts.push(`\r\nP${Math.max(1, o.copies | 0)}\r\n`);
  }
  return concat(parts);
}

export function encodeTSPL(labels, o) {
  const parts = [];
  const f = (n) => (Math.round(n * 10) / 10).toString();
  for (const m of labels) {
    const wmm = o.widthMM ?? m.w / o.dpi * 25.4, hmm = o.heightMM ?? m.h / o.dpi * 25.4;
    parts.push(`SIZE ${f(wmm)} mm,${f(hmm)} mm\r\n`);
    if (o.media === "continuous") parts.push("GAP 0 mm,0 mm\r\n");
    else if (o.media === "mark") parts.push(`BLINE ${f(o.gapMM ?? 3)} mm,0 mm\r\n`);
    else parts.push(`GAP ${f(o.gapMM ?? 3)} mm,0 mm\r\n`);
    if (o.darkness !== undefined && o.darkness !== null && o.darkness !== "") parts.push(`DENSITY ${Math.max(0, Math.min(15, o.darkness | 0))}\r\n`);
    if (o.speed) parts.push(`SPEED ${o.speed}\r\n`);
    parts.push("DIRECTION 0,0\r\nREFERENCE 0,0\r\nOFFSET 0 mm\r\nSET TEAR ON\r\nCLS\r\n");
    parts.push(`BITMAP 0,0,${m.bpr},${m.h},0,`); // TSPL: 0 = black dot
    parts.push(invertedBits(m));
    parts.push(`\r\nPRINT 1,${Math.max(1, o.copies | 0)}\r\n`);
  }
  return concat(parts);
}

export function encodeLabels(lang, labels, o) {
  if (lang === "zpl") return encodeZPL(labels, o);
  if (lang === "epl") return encodeEPL(labels, o);
  if (lang === "tspl") return encodeTSPL(labels, o);
  throw new Error("unknown printer language " + lang);
}

/** Commands to make the printer measure the label length / gap. */
export function calibrateCommand(lang) {
  if (lang === "zpl") return enc.encode("~JC\n");
  if (lang === "epl") return enc.encode("\r\nxa\r\n");
  if (lang === "tspl") return enc.encode("GAPDETECT\r\n");
  return null;
}
