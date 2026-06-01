import { useEffect, useState } from "react";
import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as SonnerToaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import Home from "@/pages/Home";
import Consultation from "@/pages/Consultation";
import NotFound from "@/pages/not-found";
import LinkGenerator from "@/pages/LinkGenerator";
import SignIn from "@/pages/admin/SignIn";
import AdminLinks from "@/pages/admin/Links";
import AdminSubmissions from "@/pages/admin/Submissions";
import AdminActivity from "@/pages/admin/Activity";
import AdminSources from "@/pages/admin/Sources";
import { AuthProvider } from "@/lib/auth-context";

const queryClient = new QueryClient();

// Wraps an admin route with the AuthProvider so the protected page can
// call /api/auth/me on mount and consume the user from context.
function WithAuth({ children }: { children: React.ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

/**
 * The Consultation form is gated: it opens only with a `?source=` or
 * `?patient_id=` param (a consultation link is sent to a known patient).
 * Without one, visitors are sent to the public Registration form at `/`.
 */
function ConsultationGate() {
  const [allow, setAllow] = useState<boolean | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const source = params.get("source")?.trim();
    const patientId = params.get("patient_id")?.trim();
    setAllow(Boolean(source || patientId));
  }, []);

  if (allow === null) return null;
  if (!allow) return <Redirect to="/" />;
  return <Consultation />;
}

function Router() {
  return (
    <Switch>
      {/* Public patient Registration form. */}
      <Route path="/" component={Home} />
      {/* Pre-appointment Consultation — gated (see ConsultationGate). */}
      <Route path="/consultation" component={ConsultationGate} />
      {/* Internal link-generator tool (not linked from the public forms).
          Rendered via children so LinkGenerator's optional props (D.3
          `readOnly`) don't collide with wouter's RouteComponentProps. */}
      <Route path="/internal-tools-x9k2">
        <LinkGenerator />
      </Route>
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
      <Route path="/admin/sources">
        <WithAuth>
          <AdminSources />
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
