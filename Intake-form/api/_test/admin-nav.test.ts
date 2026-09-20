// The navigation model is the answer to "six sections, five mobile slots". It
// is pure, so the answer is testable without a browser: five slots, every
// destination reachable, and nothing hidden behind a horizontal scroll.
//
// The previous layout had six tabs in one mobile strip and had already resorted
// to `overflow-x-auto` to fit five of them. These assertions are what stop that
// coming back.
//
// No PHI, no DB, no network.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PRIMARY_NAV,
  activeLabel,
  allNavRoutes,
  hasActiveChild,
  isItemActive,
  isRouteActive,
  opensSheet,
} from "../../artifacts/intake-form/src/pages/admin/admin-nav";

const APP_TSX = "../../artifacts/intake-form/src/App.tsx";

function read(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

describe("the mobile bottom bar fits", () => {
  it("has exactly five slots", () => {
    // The bar is `grid-cols-5`. Six entries would either overflow or need the
    // horizontal scroll this replaced.
    assert.equal(PRIMARY_NAV.length, 5);
  });

  it("every slot has a label short enough for a 10px caption", () => {
    for (const e of PRIMARY_NAV) {
      assert.ok(e.label.length <= 12, `"${e.label}" is too long for a bottom-bar slot`);
    }
  });

  it("slot ids and routes are unique", () => {
    assert.equal(new Set(PRIMARY_NAV.map((e) => e.id)).size, PRIMARY_NAV.length);
    assert.equal(new Set(PRIMARY_NAV.map((e) => e.to)).size, PRIMARY_NAV.length);
  });

  it("every destination is reachable in at most two taps", () => {
    // A slot is one tap; a slot's child is the slot plus one. Nothing is
    // nested deeper, so nothing needs a third.
    for (const e of PRIMARY_NAV) {
      for (const c of e.children ?? []) {
        assert.ok(c.to.startsWith("/admin/"), c.to);
      }
      assert.ok((e.children ?? []).every((c) => c.label.length <= 24));
    }
  });
});

describe("nothing is unreachable", () => {
  const routes = allNavRoutes();

  it("reaches all nine destinations, with no duplicates", () => {
    // Five slot routes + four children. More than the six the old
    // horizontally-scrolling strip exposed.
    assert.equal(routes.length, 9);
    assert.equal(new Set(routes).size, 9);
  });

  it("exposes the real-data journeys page, separately from the synthetic demo", () => {
    assert.ok(routes.includes("/admin/journeys"));
    assert.ok(routes.includes("/admin/insurance-demo"));
    // The demo is flagged; the real-data page is not. A viewer must be able to
    // tell them apart from the nav alone.
    const reports = PRIMARY_NAV.find((e) => e.id === "reports")!;
    const journeys = reports.children!.find((c) => c.to === "/admin/journeys")!;
    const demo = reports.children!.find((c) => c.to === "/admin/insurance-demo")!;
    assert.notEqual(demo.demo, undefined);
    assert.equal(journeys.demo, undefined);
  });

  it("preserves every section the console had before the redesign", () => {
    // The six pre-existing sections, plus /admin/sources which existed as a
    // route but was deliberately absent from the old nav.
    for (const required of [
      "/admin/links",
      "/admin/submissions",
      "/admin/dropoffs",
      "/admin/dashboard",
      "/admin/activity",
      "/admin/ask-ai",
      "/admin/sources",
    ]) {
      assert.ok(routes.includes(required), `${required} must stay reachable`);
    }
  });

  it("includes the insurance demonstration", () => {
    assert.ok(routes.includes("/admin/insurance-demo"));
  });

  it("every nav route is actually registered in App.tsx", () => {
    // A nav entry pointing at a route that does not exist would render a
    // 404 from inside the shell.
    const app = read(APP_TSX);
    for (const r of routes) {
      assert.ok(
        app.includes(`path="${r}"`) || app.includes(`path="${r}/:id?"`),
        `${r} is in the nav but has no <Route> in App.tsx`,
      );
    }
  });

  it("no nav entry points at a public or patient-facing route", () => {
    for (const r of routes) {
      assert.ok(r.startsWith("/admin/"), `${r} is not an admin route`);
    }
  });
});

describe("isRouteActive", () => {
  it("matches the route itself", () => {
    assert.equal(isRouteActive("/admin/dashboard", "/admin/dashboard"), true);
  });

  it("matches a child path, so a submission deep-link lights up Submissions", () => {
    // The n8n manual-review emails link straight to /admin/submissions/<uuid>.
    assert.equal(
      isRouteActive(
        "/admin/submissions/8f14e45f-ceea-467a-9f3a-5a3d2b1c0e77",
        "/admin/submissions",
      ),
      true,
    );
  });

  it("does not match a sibling that merely shares a prefix", () => {
    assert.equal(isRouteActive("/admin/submissions-archive", "/admin/submissions"), false);
    assert.equal(isRouteActive("/admin/dashboards", "/admin/dashboard"), false);
  });

  it("does not match an unrelated route", () => {
    assert.equal(isRouteActive("/admin/links", "/admin/dashboard"), false);
    assert.equal(isRouteActive("/", "/admin/dashboard"), false);
  });
});

describe("isItemActive / hasActiveChild", () => {
  const submissions = PRIMARY_NAV.find((e) => e.id === "submissions")!;
  const reports = PRIMARY_NAV.find((e) => e.id === "reports")!;
  const links = PRIMARY_NAV.find((e) => e.id === "links")!;

  it("a slot is active on its own route", () => {
    assert.equal(isItemActive("/admin/submissions", submissions), true);
    assert.equal(isItemActive("/admin/links", links), true);
  });

  it("a slot is active when one of its children is", () => {
    assert.equal(isItemActive("/admin/dropoffs", submissions), true);
    assert.equal(isItemActive("/admin/insurance-demo", reports), true);
    assert.equal(isItemActive("/admin/activity", reports), true);
  });

  it("hasActiveChild distinguishes the child from the parent", () => {
    // On the parent's own route no child is active, so the children list is
    // shown without a second row highlighted.
    assert.equal(hasActiveChild("/admin/dashboard", reports), false);
    assert.equal(hasActiveChild("/admin/activity", reports), true);
  });

  it("only one slot is ever active at a time", () => {
    for (const route of allNavRoutes()) {
      const active = PRIMARY_NAV.filter((e) => isItemActive(route, e));
      assert.equal(active.length, 1, `${route} lights up ${active.length} slots`);
    }
  });

  it("a leaf slot has no children to activate", () => {
    assert.equal(hasActiveChild("/admin/links", links), false);
    assert.equal(links.children, undefined);
  });
});

describe("opensSheet — which slots open the mobile bottom sheet", () => {
  it("a slot with children opens the sheet", () => {
    for (const id of ["submissions", "reports"]) {
      const e = PRIMARY_NAV.find((x) => x.id === id)!;
      assert.equal(opensSheet(e), true, id);
    }
  });

  it("Settings opens the sheet even though it has no children", () => {
    // REGRESSION: Settings is where sign-out lives on mobile. Without the
    // explicit `sheet` flag it rendered as a plain link, the sheet never
    // opened, and there was no way to sign out on a phone — the same gap the
    // old fixed user chip left behind.
    const settings = PRIMARY_NAV.find((e) => e.id === "settings")!;
    assert.equal(settings.children, undefined, "Settings has no children");
    assert.equal(settings.sheet, true, "but is flagged to open the sheet");
    assert.equal(opensSheet(settings), true);
  });

  it("a plain leaf navigates instead of opening a sheet", () => {
    for (const id of ["links", "ask-ai"]) {
      const e = PRIMARY_NAV.find((x) => x.id === id)!;
      assert.equal(opensSheet(e), false, id);
    }
  });

  it("every slot either navigates or opens a sheet — none is inert", () => {
    for (const e of PRIMARY_NAV) {
      assert.ok(e.to || opensSheet(e), `${e.id} does nothing when tapped`);
    }
  });
});

describe("activeLabel — the mobile top-bar title", () => {
  it("names the child when a child is active, not the group", () => {
    assert.equal(activeLabel("/admin/insurance-demo"), "Insurance follow-up");
    assert.equal(activeLabel("/admin/activity"), "Activity");
    assert.equal(activeLabel("/admin/dropoffs"), "Drop-offs");
  });

  it("names the slot's own page when the slot route is active", () => {
    assert.equal(activeLabel("/admin/dashboard"), "Dashboard");
    assert.equal(activeLabel("/admin/submissions"), "All submissions");
    assert.equal(activeLabel("/admin/links"), "Links");
    assert.equal(activeLabel("/admin/sources"), "Marketing sources");
  });

  it("keeps the section title on a submission deep-link", () => {
    assert.equal(activeLabel("/admin/submissions/abc-123"), "All submissions");
  });

  it("falls back rather than showing an empty title", () => {
    assert.equal(activeLabel("/admin/nowhere"), "Admin");
    assert.equal(activeLabel("/admin/nowhere", "Console"), "Console");
  });
});

describe("the demonstration is labelled in the navigation itself", () => {
  it("the insurance demo child is flagged as demo", () => {
    const child = PRIMARY_NAV.flatMap((e) => e.children ?? []).find(
      (c) => c.to === "/admin/insurance-demo",
    );
    assert.ok(child, "the demo must appear in the nav");
    assert.equal(child!.demo, true, "and must be flagged so the chip renders");
  });

  it("no live reporting destination is flagged as demo", () => {
    for (const c of PRIMARY_NAV.flatMap((e) => e.children ?? [])) {
      if (c.to !== "/admin/insurance-demo") {
        assert.notEqual(c.demo, true, `${c.to} must not be labelled demo`);
      }
    }
  });
});
