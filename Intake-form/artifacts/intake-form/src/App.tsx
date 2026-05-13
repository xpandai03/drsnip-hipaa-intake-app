import { useEffect, useState } from "react";
import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as SonnerToaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import Home from "@/pages/Home";
import NotFound from "@/pages/not-found";
import LinkGenerator from "@/pages/LinkGenerator";
import SignIn from "@/pages/admin/SignIn";
import AdminLinks from "@/pages/admin/Links";
import AdminSubmissions from "@/pages/admin/Submissions";
import AdminActivity from "@/pages/admin/Activity";
import AdminScoringRules from "@/pages/admin/ScoringRules";
import AdminHeldLeads from "@/pages/admin/HeldLeads";
import { AuthProvider } from "@/lib/auth-context";

const queryClient = new QueryClient();

// Wraps an admin route with the AuthProvider so the protected page can
// call /api/auth/me on mount and consume the user from context.
function WithAuth({ children }: { children: React.ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

/**
 * Public intake only when the share link includes ?source= (values come from
 * the admin link generator). Bare `/` is the app entry for admins → sign-in.
 */
function RootIntakeGate() {
  const [allowForm, setAllowForm] = useState<boolean | null>(null);

  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get("source");
    setAllowForm(Boolean(raw?.trim()));
  }, []);

  if (allowForm === null) return null;
  if (!allowForm) return <Redirect to="/admin/signin" />;
  return <Home />;
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={RootIntakeGate} />
      {/* Phase 1 legacy: kept for existing bookmarks. Sprint 3 will redirect
          this to /admin/links. */}
      <Route path="/internal-tools-x9k2" component={LinkGenerator} />
      {/* Phase 2 admin tree. */}
      <Route path="/admin">
        <Redirect to="/admin/links" />
      </Route>
      <Route path="/admin/signin">
        <WithAuth>
          <SignIn />
        </WithAuth>
      </Route>
      <Route path="/admin/links">
        <WithAuth>
          <AdminLinks />
        </WithAuth>
      </Route>
      <Route path="/admin/submissions">
        <WithAuth>
          <AdminSubmissions />
        </WithAuth>
      </Route>
      <Route path="/admin/activity">
        <WithAuth>
          <AdminActivity />
        </WithAuth>
      </Route>
      <Route path="/admin/scoring-rules">
        <WithAuth>
          <AdminScoringRules />
        </WithAuth>
      </Route>
      <Route path="/admin/held-leads">
        <WithAuth>
          <AdminHeldLeads />
        </WithAuth>
      </Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
        <SonnerToaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
