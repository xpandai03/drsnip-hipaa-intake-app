// /admin/ask-ai — self-serve guide for connecting the DrSnip reporting MCP
// (an aggregate-only, PHI-free analytics connector) to claude.ai.
//
// The connector URL is public and shown to everyone. The OAuth login password
// and bearer token are ADMIN-ONLY: they are fetched from the admin-gated
// /api/admin/reporting-connector endpoint (requireAdmin → 403 for viewers) and
// are NEVER hardcoded in this bundle. Viewers see a "contact your
// administrator" placeholder where the secrets would be.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Sparkles,
  ShieldCheck,
  Copy,
  Check,
  Link2,
  KeyRound,
  MessageSquareText,
  Clock,
  Lock,
} from "lucide-react";
import { AdminLayout } from "./AdminLayout";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";

// The connector URL is public (non-secret) — safe to ship in the bundle. Only
// the credentials are admin-gated (served by the endpoint below).
const CONNECTOR_URL = "https://drsnip-reporting-mcp.fly.dev/mcp";

type ConnectorInfo = {
  url: string;
  oauthLoginPassword: string | null;
  bearerToken: string | null;
  configured: boolean;
};

async function fetchConnector(): Promise<ConnectorInfo> {
  const res = await fetch("/api/admin/reporting-connector", {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`connector fetch ${res.status}`);
  return (await res.json()) as ConnectorInfo;
}

async function copy(value: string, label: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(`${label} copied`);
  } catch {
    toast.error("Couldn't copy");
  }
}

function CopyRow({
  label,
  value,
  masked = false,
}: {
  label: string;
  value: string;
  masked?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const display = masked && !revealed ? "•".repeat(Math.min(value.length, 32)) : value;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-slate-500">{label}</span>
      <div className="flex items-stretch gap-2">
        <code className="flex-1 min-w-0 break-all rounded-lg bg-slate-100 border border-slate-200 px-3 py-2 text-sm text-slate-800 font-mono">
          {display}
        </code>
        {masked && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => setRevealed((r) => !r)}
          >
            {revealed ? "Hide" : "Show"}
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          data-testid={`copy-${label.toLowerCase().replace(/\s+/g, "-")}`}
          onClick={async () => {
            await copy(value, label);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
          <span className="ml-1 hidden sm:inline">{copied ? "Copied" : "Copy"}</span>
        </Button>
      </div>
    </div>
  );
}

function Card({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5 sm:p-6">
      <h2 className="flex items-center gap-2 text-base font-semibold text-slate-900 mb-3">
        <span className="text-primary">{icon}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

const STEPS: Array<{ text: React.ReactNode }> = [
  { text: <>In <strong>claude.ai</strong>, open <strong>Settings → Connectors</strong>.</> },
  { text: <>Click <strong>Add custom connector</strong>.</> },
  { text: <>Paste the <strong>Connector URL</strong> below into the URL field and continue.</> },
  { text: <>When prompted to sign in, enter the <strong>OAuth login password</strong> (admins: see the Credentials card below).</> },
  { text: <>Approve the connection. You can now ask Claude questions about the intake data in plain English.</> },
];

const EXAMPLES: string[] = [
  "Call drsnip_data_notes first, then: what's our manual-review rate this month?",
  "Show the how-heard breakdown for consultations.",
  "New vs returning patients this week.",
  "Submission volume by office location.",
  "Give me the outcome funnel: success / manual review / failed.",
];

export default function AskAI() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const { data, isLoading, isError } = useQuery({
    queryKey: ["reporting-connector"],
    queryFn: fetchConnector,
    enabled: isAdmin, // viewers never call the admin endpoint
    staleTime: 5 * 60 * 1000,
  });

  return (
    <AdminLayout>
      <div className="mx-auto max-w-3xl px-4 pt-20 md:pt-24 pb-28 md:pb-16 space-y-5">
        {/* Hero */}
        <header className="text-white px-1">
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Sparkles className="w-6 h-6" />
            Ask AI
          </h1>
          <p className="mt-1 text-white/80 text-sm">
            Connect the DrSnip reporting assistant to claude.ai and ask questions about
            your intake data in plain English.
          </p>
        </header>

        {/* What it is — PHI-safety front and center */}
        <Card icon={<ShieldCheck className="w-5 h-5" />} title="What it is — and why it's safe">
          <p className="text-sm text-slate-700 leading-relaxed">
            A <strong>HIPAA-safe, aggregate-only</strong> analytics connector. You can ask
            questions about intake volume, outcomes, marketing sources, and new-vs-returning
            patients — and get counts and trends back.
          </p>
          <div className="mt-3 flex items-start gap-2 rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2">
            <Lock className="w-4 h-4 text-emerald-700 mt-0.5 shrink-0" />
            <p className="text-sm text-emerald-800">
              <strong>No patient PHI is ever exposed.</strong> It reads a PHI-free database view
              through a read-only role that cannot access patient names, dates of birth, contact
              info, addresses, insurance IDs, or medical answers — by design. Small group counts
              (under 5) are shown as “&lt;5”.
            </p>
          </div>
        </Card>

        {/* Steps */}
        <Card icon={<Link2 className="w-5 h-5" />} title="Add it to claude.ai">
          <ol className="space-y-3">
            {STEPS.map((s, i) => (
              <li key={i} className="flex gap-3">
                <span className="shrink-0 w-6 h-6 rounded-full bg-primary text-white text-xs font-semibold inline-flex items-center justify-center">
                  {i + 1}
                </span>
                <span className="text-sm text-slate-700 leading-relaxed pt-0.5">{s.text}</span>
              </li>
            ))}
          </ol>
          <div className="mt-4">
            <CopyRow label="Connector URL" value={CONNECTOR_URL} />
          </div>
        </Card>

        {/* Credentials — ADMIN ONLY */}
        <Card icon={<KeyRound className="w-5 h-5" />} title="Connection credentials">
          {isAdmin ? (
            isLoading ? (
              <p className="text-sm text-slate-500">Loading credentials…</p>
            ) : isError ? (
              <p className="text-sm text-red-600">
                Couldn't load credentials. Try refreshing; if it persists, check the connector
                secrets on the server.
              </p>
            ) : data && data.configured ? (
              <div className="space-y-4">
                <p className="text-sm text-slate-600">
                  Enter the <strong>OAuth login password</strong> when claude.ai prompts you to
                  sign in. The <strong>bearer token</strong> is an alternative for programmatic
                  clients (e.g. Claude Desktop) — you don't need it for the claude.ai flow above.
                </p>
                <CopyRow label="OAuth login password" value={data.oauthLoginPassword!} masked />
                <CopyRow label="Bearer token" value={data.bearerToken!} masked />
                <p className="text-xs text-slate-400">
                  Treat these as secrets. They're shown only to administrators.
                </p>
              </div>
            ) : (
              <p className="text-sm text-amber-700">
                Credentials aren't configured on the server yet. Set{" "}
                <code className="text-xs">REPORTING_MCP_OAUTH_PASSWORD</code> and{" "}
                <code className="text-xs">REPORTING_MCP_BEARER</code> as app secrets.
              </p>
            )
          ) : (
            <div className="flex items-start gap-2 rounded-lg bg-slate-50 border border-slate-200 px-3 py-3">
              <Lock className="w-4 h-4 text-slate-500 mt-0.5 shrink-0" />
              <p className="text-sm text-slate-600">
                <strong>Contact your administrator for connection credentials.</strong> The setup
                steps and connector URL above are all you need once you have them.
              </p>
            </div>
          )}
        </Card>

        {/* Examples */}
        <Card icon={<MessageSquareText className="w-5 h-5" />} title="Try asking">
          <ul className="space-y-2">
            {EXAMPLES.map((q, i) => (
              <li
                key={i}
                className="text-sm text-slate-700 rounded-lg bg-slate-50 border border-slate-200 px-3 py-2"
              >
                “{q}”
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-slate-500">
            Tip: ask Claude to call <code className="text-xs">drsnip_data_notes</code> first — it
            explains what's available and the reporting caveats.
          </p>
        </Card>

        {/* Cold-start note */}
        <div className="flex items-center gap-2 text-white/70 text-xs px-1">
          <Clock className="w-4 h-4 shrink-0" />
          <span>
            The first question may take a few seconds — the connector sleeps when idle and wakes
            on the first request.
          </span>
        </div>
      </div>
    </AdminLayout>
  );
}
