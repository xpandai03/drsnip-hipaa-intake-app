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
  READY_MESSAGE_TYPE,
  SCROLL_MESSAGE_TYPE,
  isParentReady,
  isReadyMessage,
  onParentReady,
  buildHeightMessage,
  buildScrollMessage,
  isEmbedded,
  postEmbedHeight,
  postEmbedScroll,
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

describe("scroll message (registration step changes)", () => {
  it("is exactly { type: 'drsnip:scroll', top } with a non-negative integer", () => {
    const m = buildScrollMessage(425.6);
    assert.deepEqual(Object.keys(m).sort(), ["top", "type"]);
    assert.equal(SCROLL_MESSAGE_TYPE, "drsnip:scroll");
    assert.equal(m.type, "drsnip:scroll");
    assert.equal(m.top, 426);
    assert.equal(buildScrollMessage(-12).top, 0);
  });

  it("goes only to the drsnip.com origins, and never when not framed", () => {
    const framed = frame(true);
    postEmbedScroll(300, PARENT_ORIGINS, framed.win);
    assert.deepEqual(framed.posted.map((p) => p.origin), PARENT_ORIGINS);
    const top = frame(false);
    postEmbedScroll(300, PARENT_ORIGINS, top.win);
    assert.equal(top.posted.length, 0);
  });

  it("the shell scrolls only when embedded, only on a CHANGE of step (never on load), and on success", () => {
    const shell = code("components/MultiStepForm.tsx");
    assert.ok(shell.includes("if (!embedded || shownStep.current === stepIndex) return;"));
    assert.ok(shell.includes('if (!embedded || submitState !== "success") return;'));
    assert.ok(shell.includes('el.scrollIntoView({ block: "nearest" });'));
    assert.ok(shell.includes("postEmbedScroll("));
    // The scroll target exists only in embed mode (standalone markup unchanged).
    assert.ok(shell.includes("{embedded && (\n              <div ref={stepTopRef}"));
  });
});

describe("ready handshake (registration stays v93 until the parent says ready)", () => {
  const parent = {};
  const win = { parent };
  const ok = { origin: "https://drsnip.com", source: parent, data: { type: "drsnip:ready" } };

  it("accepts only { type: 'drsnip:ready' } from an allowed origin AND the real parent", () => {
    assert.equal(READY_MESSAGE_TYPE, "drsnip:ready");
    assert.equal(isReadyMessage(ok, PARENT_ORIGINS, win), true);
    assert.equal(isReadyMessage({ ...ok, origin: "https://www.drsnip.com" }, PARENT_ORIGINS, win), true);
    assert.equal(isReadyMessage({ ...ok, origin: "https://evil.example" }, PARENT_ORIGINS, win), false);
    assert.equal(isReadyMessage({ ...ok, source: {} }, PARENT_ORIGINS, win), false, "not our parent");
    assert.equal(isReadyMessage({ ...ok, data: { type: "drsnip:height" } }, PARENT_ORIGINS, win), false);
    assert.equal(isReadyMessage({ ...ok, data: "drsnip:ready" }, PARENT_ORIGINS, win), false);
    assert.equal(isReadyMessage({ ...ok, data: null }, PARENT_ORIGINS, win), false);
  });

  it("is not ready by default (no window under node) and subscribers wait", () => {
    assert.equal(isParentReady(), false);
    let called = false;
    const off = onParentReady(() => (called = true));
    assert.equal(called, false);
    off();
  });

  it("the shell's embed layout and messages require framed AND parent-ready", () => {
    const shell = code("components/MultiStepForm.tsx");
    assert.ok(shell.includes("const embedded = framed && parentReady;"));
    assert.ok(shell.includes("useEmbedHeight(rootRef, embedded)"), "no height before ready");
    assert.ok(shell.includes('embedded ? "relative" : "fixed bottom-0 left-0"'), "pinned bar before ready");
  });

  it("the frame listens from module load, so a ready sent on the load event is not missed", () => {
    const lib = code("lib/embed-frame.ts");
    assert.match(lib, /\nif \(typeof window !== "undefined" && window\.parent !== window\) \{\n  window\.addEventListener\("message"/);
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
