import { useState, useMemo } from "react";
import { Copy, Check, Link2 } from "lucide-react";
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
import cjLogo from "@assets/cj-ss_1773942560897.png";

const QUICK_CHANNELS = [
  { id: "fnn", label: "FNN Webinar", source: "fnn", description: "FNN: Webinar" },
  { id: "internal", label: "Internal Marketing", source: "internal", description: "Internal: Webinar" },
  { id: "federal", label: "Federal Agency", source: "federal", description: "SOFA: Webinar" },
];

const SOURCE_OPTIONS = [
  { value: "fnn", label: "fnn — FNN: Webinar" },
  { value: "internal", label: "internal — Internal: Webinar" },
  { value: "federal", label: "federal — SOFA: Webinar" },
];

function buildUrl(params: Record<string, string>): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const base = `${origin}/`;
  const search = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v.trim() !== ""),
  );
  const qs = search.toString();
  return qs ? `${base}?${qs}` : base;
}

export default function LinkGenerator() {
  const [source, setSource] = useState("");
  const [campaign, setCampaign] = useState("");
  const [eventName, setEventName] = useState("");
  const [copied, setCopied] = useState<string | null>(null);

  const customUrl = useMemo(
    () => buildUrl({ source, campaign, event: eventName }),
    [source, campaign, eventName],
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
    <div className="min-h-screen font-sans">
      {/* Hero logo — centered, sized to dominate the top of the page. On
          desktop the AdminLayout tab nav drops to top-32 so it sits below
          the logo; on mobile the nav lives at the bottom of the screen
          (no overlap to worry about). The logo shrinks on small viewports
          so it doesn't collide with the top-right user chip. */}
      <header className="w-full pt-6 md:pt-6 px-12 sm:px-6 flex justify-center">
        <img
          src={cjLogo}
          alt="CJC Wealth Management"
          className="h-16 sm:h-20 md:h-24 w-auto object-contain"
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
            {QUICK_CHANNELS.map((ch) => {
              const url = buildUrl({ source: ch.source });
              const isCopied = copied === ch.id;
              return (
                <div
                  key={ch.id}
                  className="flex items-center justify-between gap-4 p-4 bg-slate-50 border border-slate-200 rounded-2xl"
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-slate-900">{ch.label}</div>
                    <div className="text-xs text-slate-500 mb-1">
                      Lead Source: {ch.description}
                    </div>
                    <div className="font-mono text-xs text-slate-600 truncate">
                      {url}
                    </div>
                  </div>
                  <Button
                    onClick={() => copy(url, ch.id)}
                    size="sm"
                    className="shrink-0 bg-[#A82020] text-white hover:bg-[#8B1A1A] border-[#8B1A1A]"
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
            <div className="grid gap-5 md:grid-cols-3">
              <div className="space-y-2">
                <Label className="text-sm font-medium text-slate-500">Source</Label>
                <Select value={source} onValueChange={setSource}>
                  <SelectTrigger className="h-11">
                    <SelectValue placeholder="Choose source" />
                  </SelectTrigger>
                  <SelectContent>
                    {SOURCE_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label className="text-sm font-medium text-slate-500">Campaign</Label>
                <Input
                  placeholder="e.g. q2-2026"
                  value={campaign}
                  onChange={(e) => setCampaign(e.target.value)}
                  className="text-base py-2.5"
                />
              </div>
              <div className="space-y-2">
                <Label className="text-sm font-medium text-slate-500">Event</Label>
                <Input
                  placeholder="e.g. capitol-may-15"
                  value={eventName}
                  onChange={(e) => setEventName(e.target.value)}
                  className="text-base py-2.5"
                />
              </div>
            </div>
            <div className="space-y-2 pt-2">
              <Label className="text-sm font-medium text-slate-500">Generated URL</Label>
              <div className="flex items-center gap-3">
                <code className="flex-1 px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-700 break-all font-mono">
                  {customUrl}
                </code>
                <Button
                  onClick={() => copy(customUrl, "custom")}
                  className="shrink-0 bg-[#A82020] text-white hover:bg-[#8B1A1A] border-[#8B1A1A]"
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
          </CardContent>
        </Card>

        <p className="text-xs text-white/60 text-center">
          URLs generated here are tagged with attribution data that flows into Salesforce.
        </p>
      </main>
    </div>
  );
}
