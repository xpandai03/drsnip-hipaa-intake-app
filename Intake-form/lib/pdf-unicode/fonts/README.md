# Noto Sans subsets for registration documents

`NotoSans-{Regular,Bold,Italic}.subset.ttf` are subsets of Noto Sans
(notofonts/notofonts.github.io, `fonts/NotoSans/hinted/ttf`), licensed under the
SIL Open Font License 1.1 (`OFL.txt`), which permits embedding in documents.

Subset with fontTools `pyftsubset` (no hinting, no layout features) to:
Basic Latin, Latin-1, Latin Extended-A/B/C/D/Additional (incl. Vietnamese),
IPA and spacing modifiers, Greek (+ Extended), Cyrillic (+ Supplement,
Extended-B/C), general punctuation, currency, letterlike symbols, arrows, U+FFFD.

Scripts that need shaping or right-to-left layout (Arabic, Hebrew, Indic, Thai,
…) and CJK are deliberately NOT covered: documents mark such text as "cannot be
displayed" instead of altering it (see `lib/pdf-unicode/support.ts`).

`node lib/pdf-unicode/build-font-asset.mjs` regenerates
`artifacts/intake-form/public/pdf-fonts/noto-sans-v1.json`, the asset the n8n
registration PDF nodes fetch when a document contains non-WinAnsi text.
