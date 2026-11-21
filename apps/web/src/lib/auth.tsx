"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

export type Role = "OWNER" | "ADMIN" | "CASHIER" | "WAITER" | "KITCHEN";

export interface Me {
  user: { id: string; full_name: string; email: string; role: Role };
  organization: { id: string; name: string; slug: string; plan_tier: "SINGLE" | "MULTI" };
  locations: { id: string; name: string; city: string }[];
  current_location_id: string | null;
}

type Status = "loading" | "anonymous" | "authenticated";

interface AuthContextValue {
  status: Status;
  me: Me | null;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
  /** fetch against the API with the access token; refreshes once on 401. */
  apiFetch(path: string, init?: RequestInit): Promise<Response>;
}

/** Error with the HTTP status so screens can pick the right message. */
export class ApiError extends Error {
  constructor(public status: number) {
    super(`HTTP ${status}`);
  }
}

const AuthContext = createContext<AuthContextValue | null>(null);

interface TokenResponse {
  access_token: string;
  expires_in: number;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [me, setMe] = useState<Me | null>(null);
  // Access token lives in memory only; the refresh token is an httpOnly cookie.
  const token = useRef<string | null>(null);
  const refreshing = useRef<Promise<string | null> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const store = useCallback((body: TokenResponse, renew: () => Promise<string | null>) => {
    token.current = body.access_token;
    clearTimeout(timer.current);
    // Renew a minute before expiry so the cashier never hits a 401 mid-sale.
    timer.current = setTimeout(() => void renew(), Math.max(body.expires_in - 60, 30) * 1000);
  }, []);

  const refresh = useCallback(
    function renew(): Promise<string | null> {
    // Single flight: parallel callers share one rotation (the server rejects a second one).
    refreshing.current ??= fetch("/api/auth/refresh", { method: "POST" })
      .then(async (res) => {
        if (!res.ok) return null;
        const body = (await res.json()) as TokenResponse;
        store(body, renew);
        return body.access_token;
      })
      .catch(() => null)
      .finally(() => {
        refreshing.current = null;
      });
      return refreshing.current;
    },
    [store],
  );

  const apiFetch = useCallback(
    async (path: string, init: RequestInit = {}) => {
      const send = (t: string | null) =>
        fetch(path, { ...init, headers: { ...init.headers, ...(t ? { Authorization: `Bearer ${t}` } : {}) } });
      let res = await send(token.current);
      if (res.status === 401) {
        const renewed = await refresh();
        if (!renewed) {
          token.current = null;
          setMe(null);
          setStatus("anonymous");
          return res;
        }
        res = await send(renewed);
      }
      return res;
    },
    [refresh],
  );

  const loadMe = useCallback(async () => {
    const res = await apiFetch("/api/me");
    if (!res.ok) throw new ApiError(res.status);
    setMe((await res.json()) as Me);
    setStatus("authenticated");
  }, [apiFetch]);

  useEffect(() => {
    void (async () => {
      if (await refresh()) await loadMe().catch(() => setStatus("anonymous"));
      else setStatus("anonymous");
    })();
    return () => clearTimeout(timer.current);
  }, [refresh, loadMe]);

  const login = useCallback(
    async (email: string, password: string) => {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) throw new ApiError(res.status);
      store((await res.json()) as TokenResponse, refresh);
      await loadMe();
    },
    [store, refresh, loadMe],
  );

  const logout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    clearTimeout(timer.current);
    token.current = null;
    setMe(null);
    setStatus("anonymous");
  }, []);

  const value = useMemo(() => ({ status, me, login, logout, apiFetch }), [status, me, login, logout, apiFetch]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

/** Page-level guard: the session user, or null while loading; anonymous visitors go to /login. */
export function useRequiredMe(): Me | null {
  const { status, me } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (status === "anonymous") router.replace("/login");
  }, [status, router]);
  return status === "authenticated" ? me : null;
}

export const ROLE_LABEL: Record<Role, string> = {
  OWNER: "Dueño",
  ADMIN: "Administrador",
  CASHIER: "Cajero",
  WAITER: "Mesero",
  KITCHEN: "Cocina",
};
