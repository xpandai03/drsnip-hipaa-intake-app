// /admin/ask-ai — self-serve guide for connecting the DrSnip reporting MCP
// (an aggregate-only, PHI-free analytics connector) to Claude or ChatGPT.
//
// The connector URL is public and shown to everyone. The OAuth login password
// and bearer token are ADMIN-ONLY: they are fetched from the admin-gated
// /api/admin/reporting-connector endpoint (requireAdmin → 403 for viewers) and
// are NEVER hardcoded in this bundle. Viewers see a "contact your
// administrator" placeholder where the secrets would be. The setup steps below
// REFERENCE the access password but never print it.
//
// Provider-specific setup lives in the Claude / ChatGPT tabs. Everything that
// applies to both (what-it-is, credentials, example questions) stays outside
// the tabs so the admin-gated credentials block is never duplicated.
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
  Info,
  Image as ImageIcon,
  MessagesSquare,
} from "lucide-react";
import { AdminLayout } from "./AdminLayout";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

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

/**
 * Screenshot slot. EMPTY-SAFE: with no `src` it renders a fixed aspect-ratio
 * dashed placeholder showing the alt text — so the layout never shifts and no
 * broken-image icon appears. Drop a PNG into `public/images/askai/` and set
 * `src` to swap in the real screenshot; nothing else changes.
 */
function Shot({ src, alt }: { src?: string; alt: string }) {
  if (!src) {
    return (
      <div
        role="img"
        aria-label={`Screenshot placeholder — ${alt}`}
        className="mt-2 flex aspect-video w-full items-center justify-center rounded-lg border-2 border-dashed border-slate-200 bg-slate-50 px-4 text-center"
      >
        <span className="flex items-center gap-2 text-xs text-slate-400">
          <ImageIcon className="w-4 h-4 shrink-0" />
          {alt}
        </span>
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      className="mt-2 w-full rounded-lg border border-slate-200 shadow-sm"
    />
  );
}

type Step = {
  text: React.ReactNode;
  /** Optional screenshot under the step. `src` empty until real images land. */
  shot?: { src?: string; alt: string };
};

function NumberedSteps({ steps }: { steps: Step[] }) {
  return (
    <ol className="space-y-3">
      {steps.map((s, i) => (
        <li key={i} className="flex gap-3">
          <span className="shrink-0 w-6 h-6 rounded-full bg-primary text-white text-xs font-semibold inline-flex items-center justify-center">
            {i + 1}
          </span>
          <div className="min-w-0 flex-1 pt-0.5">
            <div className="text-sm text-slate-700 leading-relaxed">{s.text}</div>
            {s.shot && <Shot src={s.shot.src} alt={s.shot.alt} />}
          </div>
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Claude — existing flow, substance unchanged.
// ---------------------------------------------------------------------------
const CLAUDE_STEPS: Step[] = [
  { text: <>In <strong>claude.ai</strong>, open <strong>Settings → Connectors</strong>.</> },
  { text: <>Click <strong>Add custom connector</strong>.</> },
  { text: <>Paste the <strong>Connector URL</strong> below into the URL field and continue.</> },
  {
    text: <>When prompted to sign in, enter the <strong>DrSnip connector access password</strong> (admins: see <strong>Connection credentials</strong> below).</>,
    shot: {
      src: "/images/askai/oauth-password-prompt.png",
      alt: "The “Connect to DrSnip Reporting” page asking for the access password",
    },
  },
  { text: <>Approve the connection. You can now ask Claude questions about the intake data in plain English.</> },
];

// ---------------------------------------------------------------------------
// ChatGPT — verified working 2026-07-13. Screenshot slots at setup steps 2, 4,
// 5 and per-conversation step 1. To add real images, drop files at the paths
// named below and set `src`.
// ---------------------------------------------------------------------------
const CHATGPT_SETUP_STEPS: Step[] = [
  {
    text: (
      <>
        In ChatGPT, open <strong>Settings → Security and login</strong> and turn{" "}
        <strong>ON Developer mode</strong>.
      </>
    ),
    shot: {
      src: "/images/askai/chatgpt-setup-1.png",
      alt: "ChatGPT Settings → Security and login, with the Developer mode toggle switched on",
    },
  },
  {
    text: (
      <>
        Go to <strong>Settings → Plugins</strong> (or{" "}
        <code className="text-xs">chatgpt.com/plugins</code>) and click{" "}
        <strong>+</strong> to create a new app.
      </>
    ),
    shot: {
      src: "/images/askai/chatgpt-setup-2.png",
      alt: "The ChatGPT Plugins page, with the + button in the top right to create a new app",
    },
  },
  {
    text: (
      <>
        Fill in the app details:
        <ul className="mt-1.5 ml-4 list-disc space-y-1 text-slate-600">
          <li><strong>Name:</strong> drsnip-mcp</li>
          <li><strong>Connection:</strong> Server URL → paste the URL below</li>
          <li><strong>Authentication:</strong> OAuth</li>
        </ul>
      </>
    ),
    shot: {
      src: "/images/askai/chatgpt-setup-3.png",
      alt: "The New App dialog filled in — Name drsnip-mcp, the Server URL, and Authentication set to OAuth",
    },
  },
  {
    text: (
      <>
        Tick <strong>“I understand and want to continue.”</strong> This warning is standard for
        any custom connector — this one is DrSnip's own reporting tool and is{" "}
        <strong>read-only</strong>.
      </>
    ),
    shot: {
      src: "/images/askai/chatgpt-setup-4.png",
      alt: "The “I understand and want to continue” confirmation checkbox, ticked",
    },
  },
  {
    text: (
      <>
        Click <strong>Create</strong>, then click <strong>“Sign in with drsnip-mcp”</strong> — the
        button label shows whatever <strong>Name</strong> you entered in step 3 — and enter the{" "}
        <strong>DrSnip connector access password</strong> (from your administrator — admins: see{" "}
        <strong>Connection credentials</strong> below).
      </>
    ),
    shot: {
      src: "/images/askai/chatgpt-setup-5.png",
      alt: "The “Add to ChatGPT” dialog with the “Sign in with drsnip-mcp” button",
    },
  },
];

const CHATGPT_CHAT_STEPS: Step[] = [
  {
    text: (
      <>
        In a new chat, click the <strong>+</strong> button → <strong>Developer mode</strong> →
        toggle on <strong>drsnip-mcp</strong>.
      </>
    ),
    // No screenshot slot here — the step is a single toggle and we have no
    // capture of the + menu. Text-only keeps the page free of placeholders.
  },
  {
    text: (
      <>
        Ask your question. For example:
        <span className="mt-1.5 block rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 text-slate-700">
          “Give me a breakdown of registration vs consultation submissions in the past 7 days”
        </span>
        <span className="mt-1.5 block text-xs text-slate-500">
          More example questions in <strong>Try asking</strong> below.
        </span>
      </>
    ),
    shot: {
      src: "/images/askai/chatgpt-chat-2.png",
      alt: "A ChatGPT chat using the DrSnip connector: the question about registration vs consultation submissions, answered with a table of counts for the past 7 days",
    },
  },
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
            Connect the DrSnip reporting assistant to <strong>Claude</strong> or{" "}
            <strong>ChatGPT</strong> and ask questions about your intake data in plain English.
          </p>
        </header>

        {/* What it is — PHI-safety front and center (applies to both providers) */}
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

        {/* Provider-specific setup */}
        <Tabs defaultValue="claude" className="w-full">
          <TabsList className="grid w-full grid-cols-2 h-auto gap-1 rounded-xl border border-white/20 bg-white/10 p-1 backdrop-blur">
            <TabsTrigger
              value="claude"
              data-testid="askai-tab-claude"
              className="rounded-lg py-2.5 text-sm font-medium text-white/80 data-[state=active]:bg-white data-[state=active]:text-primary"
            >
              Claude
            </TabsTrigger>
            <TabsTrigger
              value="chatgpt"
              data-testid="askai-tab-chatgpt"
              className="rounded-lg py-2.5 text-sm font-medium text-white/80 data-[state=active]:bg-white data-[state=active]:text-primary"
            >
              ChatGPT
            </TabsTrigger>
          </TabsList>

          {/* ---------------- Claude ---------------- */}
          <TabsContent value="claude" className="mt-4 space-y-5">
            <Card icon={<Link2 className="w-5 h-5" />} title="Add it to Claude">
              <NumberedSteps steps={CLAUDE_STEPS} />
              <div className="mt-4">
                <CopyRow label="Connector URL" value={CONNECTOR_URL} />
              </div>
            </Card>
          </TabsContent>

          {/* ---------------- ChatGPT ---------------- */}
          <TabsContent value="chatgpt" className="mt-4 space-y-5">
            {/* Requirements — surfaced BEFORE the steps so nobody fails at step 1 */}
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5 sm:p-6">
              <h2 className="flex items-center gap-2 text-base font-semibold text-amber-900 mb-2">
                <Info className="w-5 h-5 shrink-0" />
                Before you start
              </h2>
              <ul className="space-y-1.5 text-sm text-amber-900">
                <li>
                  <strong>Setup takes about 3 minutes and is done once.</strong>
                </li>
                <li>
                  You need a <strong>paid ChatGPT plan</strong> — Plus, Pro, Business, Enterprise,
                  or Edu. <strong>Free plans can't do this.</strong>
                </li>
                <li>
                  You must use ChatGPT in a <strong>web browser</strong> (
                  <code className="text-xs">chatgpt.com</code>). Developer Mode is{" "}
                  <strong>not available in the desktop or mobile apps</strong>.
                </li>
              </ul>
            </div>

            <Card icon={<Link2 className="w-5 h-5" />} title="One-time setup">
              <NumberedSteps steps={CHATGPT_SETUP_STEPS} />
              <div className="mt-4">
                <CopyRow label="Server URL" value={CONNECTOR_URL} />
              </div>
            </Card>

            <Card icon={<MessagesSquare className="w-5 h-5" />} title="Every conversation">
              <NumberedSteps steps={CHATGPT_CHAT_STEPS} />
            </Card>

            <Card icon={<Info className="w-5 h-5" />} title="Good to know">
              <ul className="space-y-2 text-sm text-slate-700">
                <li className="flex gap-2">
                  <span className="text-slate-400">•</span>
                  <span>
                    Answers are <strong>aggregate-only</strong> — you'll get counts and trends, never
                    individual patient details. That's by design.
                  </span>
                </li>
                <li className="flex gap-2">
                  <span className="text-slate-400">•</span>
                  <span>
                    Channels or categories with <strong>fewer than 5 responses are hidden</strong>{" "}
                    from reports.
                  </span>
                </li>
                <li className="flex gap-2">
                  <span className="text-slate-400">•</span>
                  <span>
                    If your first question in a while seems slow, wait a few seconds and ask again —
                    the connector wakes up on the first request.
                  </span>
                </li>
              </ul>
            </Card>
          </TabsContent>
        </Tabs>

        {/* Credentials — ADMIN ONLY. Outside the tabs: one password, both providers. */}
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
                  Enter the <strong>OAuth login password</strong> when <strong>Claude</strong> or{" "}
                  <strong>ChatGPT</strong> prompts you to sign in. The{" "}
                  <strong>bearer token</strong> is an alternative for programmatic clients (e.g.
                  Claude Desktop) — you don't need it for either setup above.
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

        {/* Examples — apply to both providers */}
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
            Tip: ask Claude or ChatGPT to call <code className="text-xs">drsnip_data_notes</code>{" "}
            first — it explains what's available and the reporting caveats.
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
