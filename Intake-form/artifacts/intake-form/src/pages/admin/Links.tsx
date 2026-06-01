import { AdminLayout } from "./AdminLayout";
import LinkGenerator from "@/pages/LinkGenerator";
import { useAuth } from "@/lib/auth-context";

/**
 * Tab 1 — Link Generator (Sprint 1 placement).
 *
 * For Sprint 1 we reuse the existing public Link Generator UI inside the
 * authenticated admin shell. Sprint 3 redesigns this into proper tabs
 * (Links / Submissions / Settings / Scoring Rules) and wires in QR codes
 * + 30-day history. Until then, the user chip floats in the top-right
 * corner via AdminLayout.
 *
 * D.3 — viewers get a read-only generator (history visible, generate
 * disabled). The server enforces this on POST /api/admin/links via
 * requireAdmin; passing readOnly is the matching UI treatment.
 */
export default function AdminLinks() {
  const { user } = useAuth();
  return (
    <AdminLayout>
      <LinkGenerator readOnly={user?.role === "viewer"} />
    </AdminLayout>
  );
}
