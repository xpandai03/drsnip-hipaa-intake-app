import { AdminLayout } from "./AdminLayout";
import LinkGenerator from "@/pages/LinkGenerator";

/**
 * Tab 1 — Link Generator (Sprint 1 placement).
 *
 * For Sprint 1 we reuse the existing public Link Generator UI inside the
 * authenticated admin shell. Sprint 3 redesigns this into proper tabs
 * (Links / Submissions / Settings / Scoring Rules) and wires in QR codes
 * + 30-day history. Until then, the user chip floats in the top-right
 * corner via AdminLayout.
 */
export default function AdminLinks() {
  return (
    <AdminLayout>
      <LinkGenerator />
    </AdminLayout>
  );
}
