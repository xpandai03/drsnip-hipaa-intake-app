import { useEffect, type ReactNode } from "react";
import { useLocation } from "wouter";
import { Loader2, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth-context";

/**
 * Wraps every /admin/* page (except /admin/signin). Reads the auth status
 * from AuthProvider; on unauthenticated, redirects to /admin/signin with a
 * `?next=` pointing at the current path so the user lands back here after
 * a successful login. Shows a top bar with the signed-in user and a logout
 * button.
 *
 * The server is the gate (every protected /api/* handler uses requireAuth).
 * This guard is UX, not security — but it removes the flash-of-content
 * problem on the client.
 */
export function AdminLayout({ children }: { children: ReactNode }) {
  const [location, setLocation] = useLocation();
  const { status, user, logout } = useAuth();

  useEffect(() => {
    if (status === "unauthenticated") {
      const next = encodeURIComponent(location);
      setLocation(`/admin/signin?next=${next}`, { replace: true });
    }
  }, [status, location, setLocation]);

  if (status !== "authenticated" || !user) {
    return (
      <div
        className="min-h-screen flex items-center justify-center"
        style={{
          background:
            "linear-gradient(135deg, #8B1A1A 0%, #A82020 40%, #C0282B 100%)",
        }}
      >
        <Loader2 className="w-6 h-6 animate-spin text-white" />
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <div className="fixed top-4 right-4 z-50 flex items-center gap-3 bg-white/95 backdrop-blur rounded-full pl-4 pr-2 py-2 shadow-lg border border-slate-200">
        <span
          className="text-sm font-medium text-slate-800"
          data-testid="admin-user-chip"
        >
          {user.name}
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            void logout();
          }}
          className="h-8 px-2 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-full"
          data-testid="admin-logout-btn"
        >
          <LogOut className="w-4 h-4" />
          <span className="sr-only">Sign out</span>
        </Button>
      </div>
      {children}
    </div>
  );
}
