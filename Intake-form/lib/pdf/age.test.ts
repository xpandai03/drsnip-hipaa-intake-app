// Tests for calculateAge — run via the repo's node:test + tsx setup:
//   node --import tsx --test lib/pdf/age.test.ts   (or `pnpm test:pdf`)

import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateAge } from "./age.ts";

// Fixed reference "today" so the relative-DOB cases are deterministic.
const TODAY = new Date(2026, 4, 20); // 2026-05-20 (local)

function isoYearsAgo(years: number, month: number, day: number): string {
  const y = TODAY.getFullYear() - years;
  return `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

test("birthday today → full year diff", () => {
  // DOB = today's month/day, 40 years ago.
  const dob = isoYearsAgo(40, TODAY.getMonth() + 1, TODAY.getDate());
  assert.equal(calculateAge(dob, TODAY), 40);
});

test("birthday tomorrow → full year diff minus one", () => {
  const tomorrow = new Date(TODAY);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dob = isoYearsAgo(40, tomorrow.getMonth() + 1, tomorrow.getDate());
  assert.equal(calculateAge(dob, TODAY), 39);
});

test("birthday yesterday → full year diff (already passed)", () => {
  const yesterday = new Date(TODAY);
  yesterday.setDate(yesterday.getDate() - 1);
  const dob = isoYearsAgo(40, yesterday.getMonth() + 1, yesterday.getDate());
  assert.equal(calculateAge(dob, TODAY), 40);
});

test("leap-day DOB — checked on Feb 28 (birthday not yet)", () => {
  assert.equal(calculateAge("2000-02-29", new Date(2024, 1, 28)), 23);
});

test("leap-day DOB — checked on Mar 1 (birthday passed)", () => {
  assert.equal(calculateAge("2000-02-29", new Date(2024, 2, 1)), 24);
});

test("leap-day DOB — checked on Feb 29 of a leap year (birthday)", () => {
  assert.equal(calculateAge("2000-02-29", new Date(2024, 1, 29)), 24);
});

test("null / empty / undefined → null", () => {
  assert.equal(calculateAge(null), null);
  assert.equal(calculateAge(""), null);
  assert.equal(calculateAge(undefined), null);
});

test("garbage string → null", () => {
  assert.equal(calculateAge("not a date"), null);
  assert.equal(calculateAge("2026-13-99"), null);
});

test("future DOB → 0", () => {
  const dob = isoYearsAgo(-5, 1, 1); // 5 years in the future
  assert.equal(calculateAge(dob, TODAY), 0);
});

test("accepts a Date object", () => {
  assert.equal(calculateAge(new Date(1990, 0, 1), TODAY), 36);
});
