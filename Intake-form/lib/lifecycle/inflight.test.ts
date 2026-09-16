// Train 2 — drain-on-shutdown tests.
//
// The property under test is the one that failed on 8faf35fc: a fire-and-forget
// bridge promise must finish (and get its write-back in) before the process
// exits.

import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";
import {
  DRAIN_CAP_MS,
  drain,
  gracefulShutdown,
  inflightCount,
  resetInflightForTests,
  resetShutdownForTests,
  track,
} from "./inflight";

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  resetInflightForTests();
  resetShutdownForTests();
});

describe("track", () => {
  it("returns the same promise and resolves to the same value", async () => {
    const p = Promise.resolve("bridge-outcome");
    assert.equal(track(p), p);
    assert.equal(await p, "bridge-outcome");
  });

  it("registers while pending and deregisters once settled", async () => {
    let release!: () => void;
    track(new Promise<void>((r) => (release = r)));
    assert.equal(inflightCount(), 1);
    release();
    await sleep(5);
    assert.equal(inflightCount(), 0);
  });

  it("deregisters a rejected promise without an unhandled rejection", async () => {
    const p = Promise.reject(new Error("bridge blew up"));
    track(p);
    await assert.rejects(p, /bridge blew up/);
    await sleep(5);
    assert.equal(inflightCount(), 0);
  });
});

describe("drain", () => {
  it("returns immediately when nothing is in flight", async () => {
    const r = await drain(1000);
    assert.deepEqual(
      { started: r.started, remaining: r.remaining, timedOut: r.timedOut },
      { started: 0, remaining: 0, timedOut: false },
    );
  });

  it("waits for an in-flight write-back before returning", async () => {
    let wroteBack = false;
    track(
      sleep(60).then(() => {
        wroteBack = true;
      }),
    );
    const r = await drain(5000);
    assert.equal(wroteBack, true, "drain returned before the write-back landed");
    assert.equal(r.started, 1);
    assert.equal(r.remaining, 0);
    assert.equal(r.timedOut, false);
    assert.ok(r.elapsedMs >= 50, `drain returned too fast (${r.elapsedMs}ms)`);
  });

  it("waits for several in-flight calls", async () => {
    const done: number[] = [];
    for (const ms of [20, 40, 70]) {
      track(sleep(ms).then(() => void done.push(ms)));
    }
    const r = await drain(5000);
    assert.deepEqual(done.sort((a, b) => a - b), [20, 40, 70]);
    assert.equal(r.started, 3);
    assert.equal(r.timedOut, false);
  });

  it("gives up at the cap and reports what is still outstanding", async () => {
    track(sleep(5000));
    const r = await drain(50);
    assert.equal(r.timedOut, true);
    assert.equal(r.remaining, 1);
    assert.ok(r.elapsedMs < 1000, "cap was not honoured");
  });

  it("a rejected in-flight promise still counts as settled", async () => {
    track(sleep(20).then(() => Promise.reject(new Error("write failed"))).catch(() => {}));
    const r = await drain(5000);
    assert.equal(r.timedOut, false);
    assert.equal(r.remaining, 0);
  });
});

describe("gracefulShutdown", () => {
  it("closes the server, waits for the bridge call, then exits 0", async () => {
    const order: string[] = [];
    track(
      sleep(60).then(() => {
        order.push("write-back");
      }),
    );
    let code: number | undefined;
    await gracefulShutdown({
      signal: "SIGTERM",
      closeServer: () => void order.push("close"),
      exit: (c) => {
        code = c;
        order.push("exit");
      },
      capMs: 5000,
      log: () => {},
    });
    assert.deepEqual(order, ["close", "write-back", "exit"]);
    assert.equal(code, 0);
  });

  it("exits 1 when the drain times out", async () => {
    track(sleep(5000));
    let code: number | undefined;
    await gracefulShutdown({
      signal: "SIGTERM",
      closeServer: () => {},
      exit: (c) => {
        code = c;
      },
      capMs: 50,
      log: () => {},
    });
    assert.equal(code, 1);
  });

  it("ignores a second signal instead of cutting the first drain short", async () => {
    let wroteBack = false;
    track(
      sleep(80).then(() => {
        wroteBack = true;
      }),
    );
    const exits: number[] = [];
    const opts = {
      closeServer: () => {},
      exit: (c: number) => void exits.push(c),
      capMs: 5000,
      log: () => {},
    };
    const first = gracefulShutdown({ signal: "SIGTERM", ...opts });
    await gracefulShutdown({ signal: "SIGINT", ...opts });
    await first;
    assert.equal(exits.length, 1, "second signal must not trigger a second exit");
    assert.equal(wroteBack, true);
  });

  it("still drains when closing the server throws", async () => {
    let wroteBack = false;
    track(
      sleep(40).then(() => {
        wroteBack = true;
      }),
    );
    let code: number | undefined;
    await gracefulShutdown({
      signal: "SIGTERM",
      closeServer: () => {
        throw new Error("close failed");
      },
      exit: (c) => {
        code = c;
      },
      capMs: 5000,
      log: () => {},
    });
    assert.equal(wroteBack, true);
    assert.equal(code, 0);
  });
});

describe("cap vs fly.toml kill_timeout", () => {
  it("leaves headroom under the 45s kill_timeout for the 30s bridge abort", () => {
    assert.ok(DRAIN_CAP_MS > 30_000, "cap must exceed the bridge's 30s abort");
    assert.ok(DRAIN_CAP_MS < 45_000, "cap must finish before Fly SIGKILLs at 45s");
  });
});
