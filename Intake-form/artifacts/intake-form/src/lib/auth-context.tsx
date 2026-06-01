import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

export type Role = "admin" | "viewer";
export type AuthUser = { email: string; name: string; role: Role };

// Mirror the server's normalizeRole: only an explicit "viewer" is read-only;
// anything else is treated as admin. The server is the real gate — this only
// drives which controls the UI shows.
function normalizeRole(value: unknown): Role {
  return value === "viewer" ? "viewer" : "admin";
}

type AuthStatus = "loading" | "authenticated" | "unauthenticated";

type AuthContextValue = {
  status: AuthStatus;
  user: AuthUser | null;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

async function fetchMe(): Promise<AuthUser | null> {
  const res = await fetch("/api/auth/me", {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (res.status === 401) return null;
  if (!res.ok) {
    throw new Error(`auth/me returned ${res.status}`);
  }
  const body = (await res.json()) as { email: string; name: string; role?: unknown };
  return { email: body.email, name: body.name, role: normalizeRole(body.role) };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<AuthUser | null>(null);

  const refresh = useCallback(async () => {
    try {
      const me = await fetchMe();
      if (me) {
        setUser(me);
        setStatus("authenticated");
      } else {
        setUser(null);
        setStatus("unauthenticated");
      }
    } catch (err) {
      console.error("auth refresh failed", err);
      setUser(null);
      setStatus("unauthenticated");
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
      });
    } catch (err) {
      console.error("logout request failed", err);
    } finally {
      setUser(null);
      setStatus("unauthenticated");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <AuthContext.Provider value={{ status, user, refresh, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used inside <AuthProvider>");
  }
  return ctx;
}
