import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Check, Link2, Loader2, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/Input";
import { RadioCard } from "@/components/ui/RadioCard";
import { Label } from "@/components/ui/label";

// DrSnip patient-form link generator (Phase 2 polish). Generates trackable
// links for the Registration or Consultation form, records them in
// link_generations, and lists the 10 most recent.

const DRSNIP_LOGO = "/images/drsnip-logo.png";

type FormType = "registration" | "consultation";

type RecentLink = {
  id: string;
  createdAt: string;
  formType: string | null;
  campaign: string | null;
  notes: string | null;
  generatedUrl: string;
};

// Registration → /?source=<campaign>
// Consultation → /consultation?source=<campaign>&patient_id=<uuid>
// (the Consultation form is gated on a source/patient_id param).
function buildUrl(formType: FormType, campaign: string): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const source = campaign.trim() || "direct";
  if (formType === "consultation") {
    const sp = new URLSearchParams({
      source,
      patient_id: crypto.randomUUID(),
    });
    return `${origin}/consultation?${sp.toString()}`;
  }
  const sp = new URLSearchParams({ source });
  return `${origin}/?${sp.toString()}`;
}

function formTypeLabel(ft: string | null): string {
  if (ft === "consultation") return "Consultation";
  if (ft === "registration") return "Registration";
  return ft ?? "—";
}

async function fetchRecentLinks(): Promise<RecentLink[]> {
  const res = await fetch("/api/admin/links", { credentials: "same-origin" });
  if (!res.ok) throw new Error(`Failed to load links (${res.status})`);
  const data = (await res.json()) as { links: RecentLink[] };
  return data.links ?? [];
}

export default function LinkGenerator() {
  const queryClient = useQueryClient();
  const [formType, setFormType] = useState<FormType | "">("");
  const [campaign, setCampaign] = useState("");
  const [notes, setNotes] = useState("");
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const recentQuery = useQuery({
    queryKey: ["admin-links"],
    queryFn: fetchRecentLinks,
    refetchOnWindowFocus: false,
  });

  const saveMutation = useMutation({
    mutationFn: async (payload: {
      formType: FormType;
      campaign: string;
      notes: string;
      generatedUrl: string;
    }) => {
      const res = await fetch("/api/admin/links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`Save failed (${res.status})`);
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin-links"] });
    },
  });

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

  const onGenerate = async () => {
    if (formType === "") return;
    const url = buildUrl(formType, campaign);
    setGeneratedUrl(url);
    try {
      await saveMutation.mutateAsync({
        formType,
        campaign: campaign.trim(),
        notes: notes.trim(),
        generatedUrl: url,
      });
      toast.success("Link generated and saved");
    } catch {
      // The URL is still usable even if persistence failed.
      toast.error("Link generated, but saving to history failed.");
    }
  };

  const recent = recentQuery.data ?? [];

  return (
    <div className="min-h-screen font-sans bg-primary">
      <header className="w-full pt-6 px-12 sm:px-6 flex justify-center">
        <img
          src={DRSNIP_LOGO}
          alt="DrSnip"
          className="h-14 sm:h-16 md:h-20 w-auto object-contain"
        />
      </header>

      <main className="w-full max-w-3xl mx-auto px-4 sm:px-6 pt-6 md:pt-24 pb-28 md:pb-16 space-y-6">
        {/* Generator */}
        <Card className="rounded-3xl shadow-2xl shadow-black/20 border-0">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-slate-900 text-lg">
              <Link2 className="w-5 h-5" />
              Generate Patient Form Link
            </CardTitle>
            <p className="text-sm text-slate-500">
              Create trackable links for Registration or Consultation forms
            </p>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-2">
              <Label className="text-sm font-medium text-slate-500">
                Form type <span className="text-primary">*</span>
              </Label>
              <div className="grid gap-3 sm:grid-cols-2">
                <RadioCard
                  label="Registration"
                  selected={formType === "registration"}
                  onClick={() => setFormType("registration")}
                />
                <RadioCard
                  label="Consultation"
                  selected={formType === "consultation"}
                  onClick={() => setFormType("consultation")}
                />
              </div>
            </div>

            <div className="grid gap-5 sm:grid-cols-2">
              <div className="space-y-2">
                <Label className="text-sm font-medium text-slate-500">
                  Campaign / source
                </Label>
                <Input
                  placeholder="e.g. facebook-ad, referral-acme"
                  value={campaign}
                  onChange={(e) => setCampaign(e.target.value)}
                  className="text-base py-2.5"
                />
              </div>
              <div className="space-y-2">
                <Label className="text-sm font-medium text-slate-500">
                  Notes (internal)
                </Label>
                <Input
                  placeholder="For the team's reference"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="text-base py-2.5"
                />
              </div>
            </div>

            <Button
              onClick={() => void onGenerate()}
              disabled={formType === "" || saveMutation.isPending}
              className="bg-primary text-white hover:bg-primary/90 border-primary"
            >
              {saveMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Link2 className="w-4 h-4" />
              )}
              Generate Link
            </Button>

            {generatedUrl && (
              <div className="space-y-2 pt-1">
                <Label className="text-sm font-medium text-slate-500">
                  Generated URL
                </Label>
                <div className="flex items-center gap-3">
                  <code
                    className="flex-1 px-4 py-3 bg-primary/5 border border-primary/20 rounded-xl text-sm text-slate-800 break-all font-mono"
                    data-testid="generated-url"
                  >
                    {generatedUrl}
                  </code>
                  <Button
                    onClick={() => copy(generatedUrl, "current")}
                    className="shrink-0 bg-primary text-white hover:bg-primary/90 border-primary"
                  >
                    {copied === "current" ? (
                      <Check className="w-4 h-4" />
                    ) : (
                      <Copy className="w-4 h-4" />
                    )}
                    {copied === "current" ? "Copied" : "Copy"}
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recent links */}
        <Card className="rounded-3xl shadow-2xl shadow-black/20 border-0">
          <CardHeader className="pb-2">
            <CardTitle className="text-slate-900 text-lg">
              Recent links
            </CardTitle>
            <p className="text-sm text-slate-500">
              The 10 most recently generated links
            </p>
          </CardHeader>
          <CardContent>
            {recentQuery.isLoading ? (
              <div className="flex items-center gap-2 text-sm text-slate-500 py-4">
                <Loader2 className="w-4 h-4 animate-spin" />
                Loading…
              </div>
            ) : recentQuery.isError ? (
              <div className="flex items-center gap-2 text-sm text-slate-500 py-4">
                <AlertCircle className="w-4 h-4 text-slate-400" />
                Recent links are unavailable.
              </div>
            ) : recent.length === 0 ? (
              <p className="text-sm text-slate-500 py-4">
                No links generated yet.
              </p>
            ) : (
              <div className="space-y-3">
                {recent.map((link) => (
                  <div
                    key={link.id}
                    className="flex items-center justify-between gap-4 p-4 bg-slate-50 border border-slate-200 rounded-2xl"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border border-primary/20 bg-primary/5 text-primary">
                          {formTypeLabel(link.formType)}
                        </span>
                        <span className="text-xs text-slate-500">
                          {link.campaign || "direct"}
                        </span>
                        <span className="text-xs text-slate-400">
                          · {new Date(link.createdAt).toLocaleString()}
                        </span>
                      </div>
                      <div className="font-mono text-xs text-slate-600 truncate">
                        {link.generatedUrl}
                      </div>
                    </div>
                    <Button
                      onClick={() => copy(link.generatedUrl, link.id)}
                      size="sm"
                      variant="outline"
                      className="shrink-0"
                    >
                      {copied === link.id ? (
                        <Check className="w-4 h-4" />
                      ) : (
                        <Copy className="w-4 h-4" />
                      )}
                      {copied === link.id ? "Copied" : "Copy"}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
