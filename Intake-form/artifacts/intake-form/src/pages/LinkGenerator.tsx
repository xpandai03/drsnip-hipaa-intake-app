import { useEffect, useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Copy, Check, Link2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/Input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";

const DRSNIP_LOGO = "/images/drsnip-logo.png";

// ---------------------------------------------------------------------------
// Source list: was hardcoded {fnn, internal, federal}; now driven by the
// admin-editable marketing_sources table via /api/admin/marketing-sources.
// The Quick Links block below stays scoped to the three legacy webinar
// sources for muscle-memory — marketing's day-to-day campaign URLs come
// out of the Custom Link form instead.
// ---------------------------------------------------------------------------

type MarketingSource = {
  id: string;
  sourceKey: string;
  displayName: string;
  leadSource: string;
  defaultMedium: string | null;
  isActive: boolean;
};

const LEGACY_QUICK_LINK_KEYS = ["fnn", "internal", "federal"] as const;

// utm_medium taxonomy: the four values Google Analytics 4 recognizes as
// canonical channel buckets. Marketing teams can extend if needed, but
// these cover paid, social, email, and unpaid web traffic without
// further config.
const MEDIUM_OPTIONS = [
  { value: "cpc", label: "cpc (paid)" },
  { value: "social", label: "social" },
  { value: "email", label: "email" },
  { value: "organic", label: "organic" },
] as const;

async function fetchSources(): Promise<MarketingSource[]> {
  const res = await fetch("/api/admin/marketing-sources", {
    credentials: "same-origin",
  });
  if (!res.ok) throw new Error(`Failed to load sources (${res.status})`);
  const data = (await res.json()) as { sources: MarketingSource[] };
  return data.sources ?? [];
}

/**
 * Build the campaign URL. Always includes ?source=<key> first so the
 * existing Salesforce attribution pipeline (Home.tsx → SOURCE_MAP) is
 * preserved byte-for-byte. UTM params are appended; any empty utm_*
 * value is omitted so ad-platform URL builders see a clean URL.
 */
function buildUrl(params: {
  source: string;
  medium: string;
  campaign: string;
  content: string;
}): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const base = `${origin}/`;
  if (!params.source) return base;
  const sp = new URLSearchParams();
  sp.set("source", params.source);
  sp.set("utm_source", params.source);
  if (params.medium.trim() !== "") sp.set("utm_medium", params.medium);
  if (params.campaign.trim() !== "") sp.set("utm_campaign", params.campaign);
  if (params.content.trim() !== "") sp.set("utm_content", params.content);
  return `${base}?${sp.toString()}`;
}

export default function LinkGenerator() {
  const sourcesQuery = useQuery({
    queryKey: ["marketing-sources"],
    queryFn: fetchSources,
    refetchOnWindowFocus: false,
  });
  const sources = useMemo<MarketingSource[]>(
    () => sourcesQuery.data ?? [],
    [sourcesQuery.data],
  );

  const [source, setSource] = useState("");
  const [medium, setMedium] = useState("");
  const [mediumTouched, setMediumTouched] = useState(false);
  const [campaign, setCampaign] = useState("");
  const [content, setContent] = useState("");
  const [copied, setCopied] = useState<string | null>(null);

  // When source changes, default medium to that source's default_medium
  // unless the user has manually edited the field.
  useEffect(() => {
    if (mediumTouched) return;
    const match = sources.find((s) => s.sourceKey === source);
    setMedium(match?.defaultMedium ?? "");
  }, [source, sources, mediumTouched]);

  // The three legacy webinar quick-links — still hardcoded keys, but
  // their display labels come from whatever the DB says today (admins
  // can rename them via the Sources tab without breaking these cards).
  const quickLinks = useMemo(
    () =>
      LEGACY_QUICK_LINK_KEYS.map((key) => {
        const match = sources.find((s) => s.sourceKey === key);
        return {
          id: key,
          label: match?.displayName ?? key,
          leadSource: match?.leadSource ?? key,
          source: key,
        };
      }),
    [sources],
  );

  const customUrl = useMemo(
    () => buildUrl({ source, medium, campaign, content }),
    [source, medium, campaign, content],
  );

  const copy = async (url: string, key: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(key);
      toast.success("Link copied to clipboard");
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 2000);
    } catch {
      toast.error("Couldn't copy. Select the URL manually.");
    }
  };

  return (
    <div className="min-h-screen font-sans bg-primary">
      <header className="w-full pt-6 md:pt-6 px-12 sm:px-6 flex justify-center">
        <img
          src={DRSNIP_LOGO}
          alt="DrSnip"
          className="h-14 sm:h-16 md:h-20 w-auto object-contain"
        />
      </header>

      <main className="w-full max-w-4xl mx-auto px-4 sm:px-6 pt-6 md:pt-24 pb-28 md:pb-16 space-y-6">
        <Card className="rounded-3xl shadow-2xl shadow-black/20 border-0">
          <CardHeader className="pb-4">
            <CardTitle className="flex items-center gap-2 text-slate-900 text-lg">
              <Link2 className="w-5 h-5" />
              Quick Links
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {quickLinks.map((ch) => {
              const url = buildUrl({
                source: ch.source,
                medium: "",
                campaign: "",
                content: "",
              });
              const isCopied = copied === ch.id;
              return (
                <div
                  key={ch.id}
                  className="flex items-center justify-between gap-4 p-4 bg-slate-50 border border-slate-200 rounded-2xl"
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-slate-900">{ch.label}</div>
                    <div className="text-xs text-slate-500 mb-1">
                      Lead Source: {ch.leadSource}
                    </div>
                    <div className="font-mono text-xs text-slate-600 truncate">
                      {url}
                    </div>
                  </div>
                  <Button
                    onClick={() => copy(url, ch.id)}
                    size="sm"
                    className="shrink-0 bg-primary text-white hover:bg-primary/90 border-primary"
                  >
                    {isCopied ? (
                      <Check className="w-4 h-4" />
                    ) : (
                      <Copy className="w-4 h-4" />
                    )}
                    {isCopied ? "Copied" : "Copy"}
                  </Button>
                </div>
              );
            })}
          </CardContent>
        </Card>

        <Card className="rounded-3xl shadow-2xl shadow-black/20 border-0">
          <CardHeader className="pb-4">
            <CardTitle className="text-slate-900 text-lg">Custom Link</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            {sourcesQuery.isLoading ? (
              <div className="flex items-center gap-2 text-sm text-slate-500 py-4">
                <Loader2 className="w-4 h-4 animate-spin" />
                Loading sources…
              </div>
            ) : sourcesQuery.isError ? (
              <div className="text-sm text-red-600 py-4">
                Failed to load sources. Refresh the page to retry.
              </div>
            ) : (
              <>
                <div className="grid gap-5 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label className="text-sm font-medium text-slate-500">
                      Source
                    </Label>
                    <Select value={source} onValueChange={setSource}>
                      <SelectTrigger className="h-11" data-testid="source-select">
                        <SelectValue placeholder="Choose source" />
                      </SelectTrigger>
                      <SelectContent>
                        {sources.map((opt) => (
                          <SelectItem key={opt.sourceKey} value={opt.sourceKey}>
                            {opt.sourceKey} — {opt.leadSource}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label className="text-sm font-medium text-slate-500">
                      Medium
                    </Label>
                    <Select
                      value={medium}
                      onValueChange={(v) => {
                        setMediumTouched(true);
                        setMedium(v);
                      }}
                    >
                      <SelectTrigger className="h-11" data-testid="medium-select">
                        <SelectValue placeholder="Choose medium" />
                      </SelectTrigger>
                      <SelectContent>
                        {MEDIUM_OPTIONS.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value}>
                            {opt.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="grid gap-5 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label className="text-sm font-medium text-slate-500">
                      Campaign
                    </Label>
                    <Input
                      placeholder="e.g. federal-q2-2026"
                      value={campaign}
                      onChange={(e) => setCampaign(e.target.value)}
                      className="text-base py-2.5"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-sm font-medium text-slate-500">
                      Content
                    </Label>
                    <Input
                      placeholder="e.g. carousel-a"
                      value={content}
                      onChange={(e) => setContent(e.target.value)}
                      className="text-base py-2.5"
                    />
                  </div>
                </div>
                <div className="space-y-2 pt-2">
                  <Label className="text-sm font-medium text-slate-500">
                    Generated URL
                  </Label>
                  <div className="flex items-center gap-3">
                    <code
                      className="flex-1 px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-700 break-all font-mono"
                      data-testid="generated-url"
                    >
                      {customUrl}
                    </code>
                    <Button
                      onClick={() => copy(customUrl, "custom")}
                      className="shrink-0 bg-primary text-white hover:bg-primary/90 border-primary"
                    >
                      {copied === "custom" ? (
                        <Check className="w-4 h-4" />
                      ) : (
                        <Copy className="w-4 h-4" />
                      )}
                      {copied === "custom" ? "Copied" : "Copy"}
                    </Button>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <p className="text-xs text-white/60 text-center">
          URLs generated here are tagged with attribution data that flows into Salesforce.
        </p>
      </main>
    </div>
  );
}
