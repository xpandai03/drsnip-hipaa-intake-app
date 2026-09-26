// Test helper: extract the text of a hand-built (uncompressed) registration
// PDF the way a viewer does — WinAnsi literal strings for the standard fonts,
// glyph-id hex strings for the embedded fonts decoded through each font's own
// ToUnicode CMap. Returns one line per Tj, in drawing order.

const WINANSI_HIGH: Record<number, string> = {
  0x80: "€", 0x82: "‚", 0x83: "ƒ", 0x84: "„", 0x85: "…",
  0x86: "†", 0x87: "‡", 0x88: "ˆ", 0x89: "‰", 0x8a: "Š",
  0x8b: "‹", 0x8c: "Œ", 0x8e: "Ž", 0x91: "‘", 0x92: "’",
  0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—",
  0x98: "˜", 0x99: "™", 0x9a: "š", 0x9b: "›", 0x9c: "œ",
  0x9e: "ž", 0x9f: "Ÿ",
};

function winAnsiChar(b: number): string {
  if (b >= 0x80 && b <= 0x9f) return WINANSI_HIGH[b] ?? "�";
  return String.fromCharCode(b);
}

function obj(src: string, id: number): string {
  const m = new RegExp(`(?:^|\\n)${id} 0 obj\\n([\\s\\S]*?)\\nendobj`).exec(src);
  return m ? m[1] : "";
}

/** Map resource name (U1/U2/U3) -> glyph id -> text, from ToUnicode CMaps. */
function unicodeMaps(src: string): Record<string, Map<number, string>> {
  const out: Record<string, Map<number, string>> = {};
  const res = /\/F1 \d+ 0 R \/F2 \d+ 0 R \/F3 \d+ 0 R((?: \/U\d \d+ 0 R)*)/.exec(src);
  if (!res) return out;
  for (const m of res[1].matchAll(/\/(U\d) (\d+) 0 R/g)) {
    const t0 = obj(src, Number(m[2]));
    const tu = /\/ToUnicode (\d+) 0 R/.exec(t0);
    const map = new Map<number, string>();
    if (tu) {
      const cmap = obj(src, Number(tu[1]));
      for (const p of cmap.matchAll(/<([0-9a-f]{4})> <([0-9a-f]+)>/gi)) {
        const units = p[2].match(/.{4}/g)!.map((h) => parseInt(h, 16));
        map.set(parseInt(p[1], 16), String.fromCharCode(...units));
      }
    }
    out[m[1]] = map;
  }
  return out;
}

export function pdfText(bytes: Buffer): string {
  const src = bytes.toString("latin1");
  const maps = unicodeMaps(src);
  const lines: string[] = [];
  const re = /BT \/(\w+) [\d.]+ Tf [-\d.]+ [-\d.]+ Td (?:\(((?:\\.|[^\\)])*)\)|<([0-9a-f]*)>) Tj ET/gi;
  for (const m of src.matchAll(re)) {
    if (m[3] !== undefined) {
      const map = maps[m[1]] ?? new Map();
      lines.push((m[3].match(/.{4}/g) ?? []).map((h) => map.get(parseInt(h, 16)) ?? "�").join(""));
    } else {
      let s = "";
      const lit = m[2];
      for (let i = 0; i < lit.length; i++) {
        const c = lit[i];
        if (c !== "\\") { s += winAnsiChar(c.charCodeAt(0)); continue; }
        const oct = /^[0-7]{3}/.exec(lit.slice(i + 1));
        if (oct) { s += winAnsiChar(parseInt(oct[0], 8)); i += 3; }
        else { s += lit[i + 1]; i += 1; }
      }
      lines.push(s);
    }
  }
  return lines.join("\n");
}

/** Font resource used for each drawn line containing `needle`. */
export function fontsFor(bytes: Buffer, needle: string): string[] {
  const src = bytes.toString("latin1");
  const text = pdfText(bytes).split("\n");
  const fonts = [...src.matchAll(/BT \/(\w+) /g)].map((m) => m[1]);
  return text.flatMap((t, i) => (t.includes(needle) ? [fonts[i]] : []));
}
