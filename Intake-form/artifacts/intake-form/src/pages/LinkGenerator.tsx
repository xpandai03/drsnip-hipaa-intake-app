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
    <div
      className="min-h-screen font-sans relative overflow-hidden"
      style={{ background: "linear-gradient(135deg, #8B1A1A 0%, #A82020 40%, #C0282B 100%)" }}
    >
      <div className="absolute inset-0 z-0 pointer-events-none overflow-hidden">
        <div className="absolute -top-32 -right-32 w-96 h-96 rounded-full bg-white/5" />
        <div className="absolute top-1/3 -left-24 w-64 h-64 rounded-full bg-white/4" />
        <div className="absolute bottom-0 right-1/4 w-80 h-80 rounded-full bg-black/10" />
      </div>

      <header className="relative z-10 w-full max-w-4xl mx-auto px-6 py-6 flex items-center gap-4">
        <img
          src={cjLogo}
          alt="CJ Wealth Management"
          className="h-12 w-auto object-contain rounded-lg"
        />
        <div>
          <h1 className="text-xl md:text-2xl font-bold text-white leading-tight">
            CJC Intake Form — Link Generator
          </h1>
          <p className="text-sm text-white/70">
            Generate pre-tagged URLs for internal use.
          </p>
        </div>
      </header>

      <main className="relative z-10 w-full max-w-4xl mx-auto px-6 pb-16 space-y-6">
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
