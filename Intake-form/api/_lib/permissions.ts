// Phase 4 Block D — admin/viewer permission model. PURE logic, no DB, no IO,
// so it is unit-testable in isolation (see api/_test/permissions.test.ts).
//
// Two roles only:
//   admin   full access — delete submissions, CSV export, generate intake links
//   viewer  read-only — sees submissions/detail/PDF + link history, but is
//           blocked SERVER-SIDE from delete / export / link generation.
//
// The HTTP guards (requireAdmin / enforceAdmin) live in api/_lib/auth.ts; they
// consume isAdmin() from here. UI hiding is convenience only — the server is
// the gate.

export type Role = "admin" | "viewer";

/**
 * Resolve a stored role value to a Role. Anything that isn't exactly 'viewer'
 * resolves to 'admin' — this matches migration 0007's `DEFAULT 'admin'` and the
 * rollout rule that existing accounts keep full access. Privilege is then
 * granted only on an explicit `role === 'admin'` (see isAdmin), so the default
 * never *grants* more than intended for a genuine viewer.
 */
export function normalizeRole(value: unknown): Role {
  return value === "viewer" ? "viewer" : "admin";
}

/** True only for the admin role. All privileged actions gate on this. */
export function isAdmin(role: Role): boolean {
  return role === "admin";
}

// Named action predicates — one per privileged action, all admin-only. Kept
// explicit (rather than a bare isAdmin call at each call site) so the
// permission matrix is greppable and the unit tests read as a spec.
export function canDeleteSubmission(role: Role): boolean {
  return isAdmin(role);
}
export function canExportSubmissions(role: Role): boolean {
  return isAdmin(role);
}
export function canGenerateLinks(role: Role): boolean {
  return isAdmin(role);
}
/** Raw insurance-card base64 is PHI. Admin-only — though note it is currently
 *  never persisted/served (stripped at submit), so this is defense-in-depth for
 *  any future card-bytes endpoint. */
export function canViewCardImageBytes(role: Role): boolean {
  return isAdmin(role);
}

// ---------------------------------------------------------------------------
// Definition approval (attendance status review).
//
// NOT a third role, and NOT inherited from `admin`.
//
// `normalizeRole()` above resolves anything that is not literally 'viewer' to
// 'admin' — a deliberate rollout choice in migration 0007, and the reason every
// developer and operations account is an admin today. Approving what a clinic's
// records MEAN is not the same privilege as exporting a CSV, and a role model
// with two values cannot tell them apart.
//
// So approval hangs off an explicit per-user capability that defaults to false.
// It is additive, it cannot widen access by accident, and — because the check
// requires the flag to be exactly `true` — it fails closed for a malformed,
// missing or unknown role rather than defaulting open the way the role does.
// ---------------------------------------------------------------------------

export type Approver = { role: unknown; canApproveDefinitions: unknown };

/**
 * True only for an admin carrying the explicit capability.
 *
 * Both halves are checked strictly. `role` is normalised (so a junk value
 * resolves to 'admin' as it does everywhere else), but the capability must be
 * the boolean `true` — a string "true", a 1, or an absent column all deny.
 */
export function canApproveDefinitions(u: Approver): boolean {
  return isAdmin(normalizeRole(u.role)) && u.canApproveDefinitions === true;
}

/** Save or edit a draft classification. Admin, no capability required. */
export function canEditDefinitionDraft(role: Role): boolean {
  return isAdmin(role);
}

/** Run an impact preview over a draft. Admin — a preview is an unapproved number. */
export function canPreviewDefinitions(role: Role): boolean {
  return isAdmin(role);
}
