// Embed-frame protocol (artifacts/intake-form/src/lib/embed-frame.ts) — the
// detection + { type: "drsnip:height", height } contract shared by the
// insurance form and the registration form's embed mode.
//
// Pure-module tests plus source guards; the layout itself (inline bar, no inner
// scroll, pixel parity when not embedded) is verified in a real browser — see
// DRSNIP_REGISTRATION_EMBED_PARITY.md.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  HEIGHT_MESSAGE_TYPE,
  PARENT_ORIGINS,
  buildHeightMessage,
  isEmbedded,
  postEmbedHeight,
} from "../../artifacts/intake-form/src/lib/embed-frame";

function frame(embedded: boolean) {
  const posted: { message: unknown; origin: string }[] = [];
  const parent = {
    postMessage: (message: unknown, origin: string) => {
      posted.push({ message, origin });
    },
  };
  const win: { parent: typeof parent } = { parent };
  if (!embedded) (win as { parent: unknown }).parent = win;
  return { win: win as { parent: typeof parent }, posted };
}

const src = (rel: string) =>
  readFileSync(new URL(`../../artifacts/intake-form/src/${rel}`, import.meta.url), "utf8");
// Code only: line comments (which legitimately describe the contract) removed.
const code = (rel: string) => src(rel).replace(/^\s*\/\/.*$/gm, "");

describe("height message contract", () => {
  it("is exactly { type: 'drsnip:height', height } with an integer height", () => {
    const m = buildHeightMessage(1411.2);
    assert.deepEqual(Object.keys(m).sort(), ["height", "type"]);
    assert.equal(m.type, "drsnip:height");
    assert.equal(HEIGHT_MESSAGE_TYPE, "drsnip:height");
    assert.equal(m.height, 1412, "rounded UP so the frame never clips a pixel");
  });

  it("posts to each drsnip.com origin — never '*'", () => {
    const { win, posted } = frame(true);
    postEmbedHeight(1412, PARENT_ORIGINS, win);
    assert.deepEqual(
      posted.map((p) => p.origin),
      ["https://drsnip.com", "https://www.drsnip.com"],
    );
    for (const p of posted) assert.deepEqual(p.message, { type: "drsnip:height", height: 1412 });
    assert.ok(!posted.some((p) => p.origin === "*"));
  });

  it("posts on shrink as well as growth (no high-water mark)", () => {
    const { win, posted } = frame(true);
    postEmbedHeight(2889, PARENT_ORIGINS, win);
    postEmbedHeight(556, PARENT_ORIGINS, win);
    assert.equal((posted.at(-1)!.message as { height: number }).height, 556);
  });

  it("is a no-op when not in an iframe", () => {
    const { win, posted } = frame(false);
    assert.equal(isEmbedded(win), false);
    postEmbedHeight(1412, PARENT_ORIGINS, win);
    assert.equal(posted.length, 0);
  });

  it("a throwing postMessage (origin mismatch) never escapes", () => {
    const win = { parent: { postMessage: () => { throw new Error("mismatch"); } } };
    assert.doesNotThrow(() => postEmbedHeight(10, PARENT_ORIGINS, win));
  });

  it("dev-only localhost origins are compiled out of production (Vite DEV guard)", () => {
    assert.match(src("lib/embed-frame.ts"), /import\.meta\.env\.DEV\s*\?\s*\["http:\/\/localhost:5173"/);
  });
});

describe("one mechanism, not two", () => {
  it("insurance and the shared shell both use the shared hook; no private poster remains", () => {
    const ins = code("pages/Insurance.tsx");
    const shell = code("components/MultiStepForm.tsx");
    assert.ok(ins.includes("useEmbedHeight(rootRef)"));
    assert.ok(shell.includes("useEmbedHeight(rootRef, embedded)"));
    for (const s of [ins, shell]) {
      assert.equal(s.includes("postMessage"), false, "no private postMessage poster");
      assert.equal(s.includes('"drsnip:height"'), false, "no private copy of the message type");
    }
  });
});

describe("registration embed mode is opt-in and layout-scoped", () => {
  const shell = src("components/MultiStepForm.tsx");

  it("detects embedding with the insurance mechanism (window.parent !== window), once", () => {
    assert.ok(shell.includes("useState(() => embeddable && isEmbedded())"));
  });

  it("only registration opts in; consultation is untouched", () => {
    assert.match(src("pages/Home.tsx"), /<MultiStepForm[\s\S]*?\bembeddable\b[\s\S]*?\/>/);
    assert.equal(/\bembeddable\b/.test(src("pages/Consultation.tsx")), false);
  });

  it("bar is fixed when not embedded and in document flow when embedded", () => {
    assert.ok(shell.includes('embedded ? "relative" : "fixed bottom-0 left-0"'));
  });

  it("min-h-screen (100vh of the frame) is dropped only when embedded — wizard and success screen", () => {
    assert.equal((shell.match(/!embedded && "min-h-screen"/g) ?? []).length, 2);
    assert.equal(/className="min-h-screen/.test(shell), false);
  });

  it("the measured wrapper exists only when embedded, around wizard AND success screen", () => {
    assert.ok(shell.includes('<div ref={rootRef} data-drsnip-embed="">'));
    assert.ok(shell.includes("return frame(\n      <SuccessScreen"));
  });
});
