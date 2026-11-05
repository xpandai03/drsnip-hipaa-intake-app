// AdsWizz pixel (client request, 2026-11-05): one image on a confirmed
// registration success, from the form's own document; nothing anywhere else.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ADSWIZZ_REGISTRATION_PIXEL_URL,
  appendRegistrationPixel,
  registrationPixelOnResult,
} from "../../artifacts/intake-form/src/lib/adswizz";

type FakeEl = { tagName: string; attrs: Record<string, string>; style: Record<string, string>; setAttribute(k: string, v: string): void };
function fakeDocument() {
  const appended: FakeEl[] = [];
  const order: string[] = [];
  const doc = {
    createElement(tag: string): FakeEl {
      return { tagName: tag.toUpperCase(), attrs: {}, style: {}, setAttribute(k, v) { this.attrs[k] = v; order.push(k); } };
    },
    body: { appendChild(el: FakeEl) { appended.push(el); return el; } },
    documentElement: { appendChild() { throw new Error("must use body when there is one"); } },
  };
  return { doc: doc as unknown as Document, appended, order };
}

const read = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

test("the URL is the client's, an https URL, not the placeholder", () => {
  assert.notEqual(ADSWIZZ_REGISTRATION_PIXEL_URL, "ADSWIZZ_PIXEL_URL_PENDING", "paste the URL from scratchpad/pixel-adswizz.txt");
  assert.equal(new URL(ADSWIZZ_REGISTRATION_PIXEL_URL).protocol, "https:");
});

test("a confirmed registration appends exactly one hidden, no-referrer img with that src", () => {
  const { doc, appended, order } = fakeDocument();
  registrationPixelOnResult(true, doc);
  assert.equal(appended.length, 1);
  const img = appended[0];
  assert.equal(img.tagName, "IMG");
  assert.deepEqual(img.attrs, {
    referrerpolicy: "no-referrer", alt: "", width: "0", height: "0", src: ADSWIZZ_REGISTRATION_PIXEL_URL,
  });
  assert.equal(img.style.display, "none");
  assert.equal(order[order.length - 1], "src", "src is set last, after referrerpolicy");
});

test("a failed submit appends none", () => {
  const { doc, appended } = fakeDocument();
  registrationPixelOnResult(false, doc);
  assert.equal(appended.length, 0);
});

test("a broken document never throws into the form", () => {
  assert.doesNotThrow(() => appendRegistrationPixel({ createElement() { throw new Error("x"); } } as unknown as Document));
});

test("registration fires it once, after the server-confirmed ok, never in the error path", () => {
  const src = read("artifacts/intake-form/src/pages/Home.tsx");
  assert.equal((src.match(/registrationPixelOnResult\(/g) ?? []).length, 1);
  const ok = src.indexOf("const ok = res.ok && json.success === true;");
  const call = src.indexOf("registrationPixelOnResult(ok);");
  assert.ok(ok > 0 && call > ok, "fires after ok is computed from the server's answer");
  assert.ok(call > src.indexOf('if (ok) postConversion("registration");'), "at the same point as the conversion message");
  const catchBlock = src.slice(src.indexOf("} catch {", call), src.indexOf("return false;", call));
  assert.ok(!catchBlock.includes("registrationPixelOnResult"), "the error path fires nothing");
});

test("consultation and insurance append none: they never reference the pixel", () => {
  for (const rel of ["artifacts/intake-form/src/pages/Consultation.tsx", "artifacts/intake-form/src/pages/Insurance.tsx"]) {
    const src = read(rel);
    assert.ok(!/adswizz|registrationPixel|appendRegistrationPixel/i.test(src), rel);
  }
});

test("the Intrepy conversion message is unchanged: still exactly one call per form", () => {
  for (const [rel, form] of [["Home", "registration"], ["Consultation", "consultation"], ["Insurance", "insurance"]]) {
    const src = read(`artifacts/intake-form/src/pages/${rel}.tsx`);
    assert.equal((src.match(/postConversion\(/g) ?? []).length, 1, rel);
    assert.ok(src.includes(`postConversion("${form}")`), rel);
  }
});

test("only the registration form imports the module", () => {
  const app = read("artifacts/intake-form/src/App.tsx");
  assert.ok(!/adswizz/i.test(app));
});
