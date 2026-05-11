import { useEffect, useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import { Loader2, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import cjLogo from "@assets/cj-ss_1773942560897.png";
import { useAuth } from "@/lib/auth-context";

function readNextParam(): string {
  if (typeof window === "undefined") return "/admin/links";
  const params = new URLSearchParams(window.location.search);
  const next = params.get("next");
  // Defense-in-depth: only allow same-origin /admin/* destinations as the
  // post-login redirect target, so an open-redirect query string can't
  // bounce a freshly logged-in admin to a phishing page.
  if (next && /^\/admin\/[A-Za-z0-9_\-/?&=]*$/.test(next)) return next;
  return "/admin/links";
}

export default function SignIn() {
  const [, setLocation] = useLocation();
  const { status, refresh } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // If the auth probe completes and the user is already signed in,
  // bounce straight to the destination.
  useEffect(() => {
    if (status === "authenticated") {
      setLocation(readNextParam(), { replace: true });
    }
  }, [status, setLocation]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (res.status === 200) {
        await refresh();
        setLocation(readNextParam(), { replace: true });
        return;
      }
      if (res.status === 429) {
        setError("Too many failed attempts. Try again in 15 minutes.");
        return;
      }
      if (res.status === 401) {
        setError("Invalid email or password.");
        return;
      }
      setError("Something went wrong. Please try again.");
    } catch (err) {
      console.error("login request failed", err);
      setError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
      // Keep email but clear the password so the user types it fresh.
      setPassword("");
    }
  };

  return (
    <div
      className="min-h-screen font-sans relative overflow-hidden flex items-center justify-center px-6"
      style={{
        background:
          "linear-gradient(135deg, #8B1A1A 0%, #A82020 40%, #C0282B 100%)",
      }}
    >
      <div className="absolute inset-0 z-0 pointer-events-none overflow-hidden">
        <div className="absolute -top-32 -right-32 w-96 h-96 rounded-full bg-white/5" />
        <div className="absolute top-1/3 -left-24 w-64 h-64 rounded-full bg-white/4" />
        <div className="absolute bottom-0 right-1/4 w-80 h-80 rounded-full bg-black/10" />
      </div>

      <div className="relative z-10 w-full max-w-md">
        <div className="flex flex-col items-center mb-6">
          <img
            src={cjLogo}
            alt="CJ Wealth Management"
            className="h-14 w-auto object-contain rounded-lg mb-3"
          />
          <h1 className="text-xl font-bold text-white">CJC Intake Console</h1>
        </div>

        <Card className="rounded-3xl shadow-2xl shadow-black/20 border-0">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-slate-900 text-lg">
              <Lock className="w-5 h-5" />
              Sign in
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="email" className="text-sm font-medium text-slate-600">
                  Email
                </Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={submitting}
                  className="text-base py-2.5"
                  data-testid="signin-email"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password" className="text-sm font-medium text-slate-600">
                  Password
                </Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={submitting}
                  className="text-base py-2.5"
                  data-testid="signin-password"
                />
              </div>

              {error && (
                <div
                  className="rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800"
                  role="alert"
                  data-testid="signin-error"
                >
                  {error}
                </div>
              )}

              <Button
                type="submit"
                disabled={submitting || !email || !password}
                className="w-full bg-[#A82020] text-white hover:bg-[#8B1A1A] border-[#8B1A1A] py-2.5 font-semibold"
                data-testid="signin-submit"
              >
                {submitting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Signing in…
                  </>
                ) : (
                  "Sign in"
                )}
              </Button>

              <p className="text-xs text-slate-500 text-center pt-2">
                Need help signing in?{" "}
                <a
                  href="mailto:raunek@xpandai.com"
                  className="underline hover:text-slate-700"
                >
                  Contact Raunek
                </a>
                .
              </p>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
