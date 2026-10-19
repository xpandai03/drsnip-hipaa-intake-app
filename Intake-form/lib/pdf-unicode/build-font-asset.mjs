// Builds artifacts/intake-form/public/pdf-fonts/noto-sans-v1.json from the
// subset TTFs: per weight, the deflated font program plus the metrics a PDF
// writer needs (codepoint -> glyph id, advance widths, descriptor values), so
// the n8n Code nodes can embed the font with no TTF parser and no zlib.
// Usage: node lib/pdf-unicode/build-font-asset.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "../../artifacts/intake-form/public/pdf-fonts/noto-sans-v1.json");

function tables(buf) {
  const n = buf.readUInt16BE(4);
  const t = {};
  for (let i = 0; i < n; i++) {
    const o = 12 + i * 16;
    t[buf.toString("latin1", o, o + 4)] = { off: buf.readUInt32BE(o + 8), len: buf.readUInt32BE(o + 12) };
  }
  return t;
}

function parseCmap(buf, off) {
  const n = buf.readUInt16BE(off + 2);
  let best = null;
  for (let i = 0; i < n; i++) {
    const r = off + 4 + i * 8;
    const pid = buf.readUInt16BE(r), eid = buf.readUInt16BE(r + 2), so = off + buf.readUInt32BE(r + 4);
    const fmt = buf.readUInt16BE(so);
    if (fmt === 12 && pid === 3 && eid === 10) best = { fmt, so };
    else if (fmt === 4 && pid === 3 && eid === 1 && !best) best = { fmt, so };
  }
  const map = new Map();
  if (best.fmt === 12) {
    const groups = buf.readUInt32BE(best.so + 12);
    for (let g = 0; g < groups; g++) {
      const p = best.so + 16 + g * 12;
      const s = buf.readUInt32BE(p), e = buf.readUInt32BE(p + 4), gid = buf.readUInt32BE(p + 8);
      for (let c = s; c <= e; c++) map.set(c, gid + (c - s));
    }
  } else {
    const so = best.so, segX2 = buf.readUInt16BE(so + 6), seg = segX2 / 2;
    const ends = so + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
    for (let i = 0; i < seg; i++) {
      const e = buf.readUInt16BE(ends + i * 2), s = buf.readUInt16BE(starts + i * 2);
      const d = buf.readInt16BE(deltas + i * 2), ro = buf.readUInt16BE(ranges + i * 2);
      for (let c = s; c <= e && c !== 0xffff; c++) {
        let gid;
        if (ro === 0) gid = (c + d) & 0xffff;
        else {
          const gi = ranges + i * 2 + ro + (c - s) * 2;
          gid = buf.readUInt16BE(gi);
          if (gid !== 0) gid = (gid + d) & 0xffff;
        }
        if (gid) map.set(c, gid);
      }
    }
  }
  return map;
}

function build(file, psName) {
  const buf = readFileSync(join(here, "fonts", file));
  const t = tables(buf);
  const head = t.head.off, hhea = t.hhea.off, maxp = t.maxp.off, os2 = t["OS/2"].off, post = t.post.off;
  const upem = buf.readUInt16BE(head + 18);
  const bbox = [0, 2, 4, 6].map((k) => buf.readInt16BE(head + 36 + k));
  const numGlyphs = buf.readUInt16BE(maxp + 4);
  const numHM = buf.readUInt16BE(hhea + 34);
  const widths = [];
  let last = 0;
  for (let g = 0; g < numGlyphs; g++) {
    if (g < numHM) last = buf.readUInt16BE(t.hmtx.off + g * 4);
    widths.push(last);
  }
  const cmap = parseCmap(buf, t.cmap.off);
  const pairs = [];
  for (const [c, g] of [...cmap.entries()].sort((a, b) => a[0] - b[0])) pairs.push(c, g);
  const italicAngle = buf.readInt32BE(post + 4) / 65536;
  return {
    psName,
    unitsPerEm: upem,
    bbox,
    ascent: buf.readInt16BE(os2 + 68),
    descent: buf.readInt16BE(os2 + 70),
    capHeight: buf.readUInt16BE(t["OS/2"].len >= 90 ? os2 + 88 : os2 + 68),
    italicAngle,
    cmap: pairs,
    widths,
    length1: buf.length,
    sha256: createHash("sha256").update(buf).digest("hex"),
    ttfDeflateB64: deflateSync(buf, { level: 9 }).toString("base64"),
  };
}

const asset = {
  version: 1,
  license: "Noto Sans, SIL Open Font License 1.1 — see lib/pdf-unicode/fonts/OFL.txt",
  fonts: {
    regular: build("NotoSans-Regular.subset.ttf", "NotoSans-Regular"),
    bold: build("NotoSans-Bold.subset.ttf", "NotoSans-Bold"),
    italic: build("NotoSans-Italic.subset.ttf", "NotoSans-Italic"),
  },
};
writeFileSync(OUT, JSON.stringify(asset));
console.log("wrote", OUT, Math.round(JSON.stringify(asset).length / 1024) + "KB",
  Object.fromEntries(Object.entries(asset.fonts).map(([k, f]) => [k, { glyphs: f.widths.length, codepoints: f.cmap.length / 2 }])));
