"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

export type Role = "OWNER" | "ADMIN" | "CASHIER" | "WAITER" | "KITCHEN";

export interface Me {
  user: {
    id: string;
    full_name: string;
    given_names: string | null;
    family_names: string | null;
    email: string | null;
    role: Role;
    username: string | null;
    has_pin: boolean;
  };
  organization: { id: string; name: string; handle: string; plan_tier: "SINGLE" | "MULTI"; max_locations: number };
  locations: { id: string; name: string; city: string }[];
  current_location_id: string | null;
  /** Linked device of a PIN session (Q33); null when signed in with email. */
  device: { id: string; name: string } | null;
}

type Status = "loading" | "anonymous" | "authenticated";

interface AuthContextValue {
  status: Status;
  me: Me | null;
  /** Owner login; `handle` = the business typed in step 1. */
  login(email: string, password: string, handle?: string): Promise<void>;
  /** Username + PIN on a linked device; the role comes from the user. */
  pinLogin(username: string, pin: string): Promise<void>;
  /** "Entrar como demo": session as the example organization's user of that role. */
  demoLogin(handle: string, role: Role): Promise<void>;
  /** Sign-up with a platform invitation (Q28); ends logged in as the new owner. */
  register(token: string, data: object): Promise<void>;
  logout(): Promise<void>;
  /** Location every request works on (x-location-id); MULTI users pick it in the header. */
  setLocation(id: string): void;
  /** Reloads the session (after locations change, so the header picker shows them). */
  reloadMe(): Promise<void>;
  /** fetch against the API with the access token; refreshes once on 401. */
  apiFetch(path: string, init?: RequestInit): Promise<Response>;
}

/** Error with the HTTP status so screens can pick the right message. */
export class ApiError extends Error {
  /** detail = the API's own message (Spanish, written for the person using the screen). */
  constructor(
    public status: number,
    public detail?: string,
  ) {
    super(detail ?? `HTTP ${status}`);
  }
}

const AuthContext = createContext<AuthContextValue | null>(null);
const LOCATION_KEY = "pm_location";
const IDLE_LOCK_MS = 2 * 60 * 1000;

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
  const location = useRef<string | null>(null);

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
        fetch(path, {
          ...init,
          headers: {
            ...init.headers,
            ...(t ? { Authorization: `Bearer ${t}` } : {}),
            ...(location.current ? { "x-location-id": location.current } : {}),
          },
        });
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
    const body = (await res.json()) as Me;
    // A MULTI user gets no location until one is sent: reuse the last one picked on this device, else the first.
    const ids = body.locations.map((l) => l.id);
    const saved = localStorage.getItem(LOCATION_KEY);
    location.current = body.current_location_id ?? (saved && ids.includes(saved) ? saved : (ids[0] ?? null));
    setMe({ ...body, current_location_id: location.current });
    setStatus("authenticated");
  }, [apiFetch]);

  useEffect(() => {
    void (async () => {
      if (await refresh()) await loadMe().catch(() => setStatus("anonymous"));
      else setStatus("anonymous");
    })();
    return () => clearTimeout(timer.current);
  }, [refresh, loadMe]);

  const start = useCallback(
    async (path: string, body: object) => {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        // The API's explanation (suspended business, handle taken…); screens decide when to show it.
        const message = ((await res.json().catch(() => null)) as { message?: unknown } | null)?.message;
        throw new ApiError(res.status, typeof message === "string" ? message : undefined);
      }
      store((await res.json()) as TokenResponse, refresh);
      location.current = null; // a new session never inherits another business's location
      await loadMe();
    },
    [store, refresh, loadMe],
  );
  const login = useCallback(
    (email: string, password: string, handle?: string) => start("/api/auth/login", { email, password, handle }),
    [start],
  );
  const pinLogin = useCallback((username: string, pin: string) => start("/api/auth/pin", { username, pin }), [start]);
  const demoLogin = useCallback((handle: string, role: Role) => start("/api/auth/demo", { handle, role }), [start]);
  const register = useCallback((token: string, data: object) => start(`/api/auth/register/${encodeURIComponent(token)}`, data), [start]);

  const setLocation = useCallback((id: string) => {
    location.current = id;
    localStorage.setItem(LOCATION_KEY, id);
    setMe((current) => (current ? { ...current, current_location_id: id } : current));
  }, []);

  const logout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    clearTimeout(timer.current);
    token.current = null;
    location.current = null;
    setMe(null);
    setStatus("anonymous");
  }, []);

  // Q33: a PIN session on a shared device locks after 2 minutes without use (server logout included).
  // The kitchen screen is watched, not touched, so it stays on.
  const locks = Boolean(me?.device) && me?.user.role !== "KITCHEN";
  useEffect(() => {
    if (!locks) return;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const reset = () => {
      clearTimeout(idle);
      idle = setTimeout(() => void logout(), IDLE_LOCK_MS);
    };
    const events = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => {
      clearTimeout(idle);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [locks, logout]);

  const value = useMemo(
    () => ({ status, me, login, pinLogin, demoLogin, register, logout, setLocation, reloadMe: loadMe, apiFetch }),
    [status, me, login, pinLogin, demoLogin, register, logout, setLocation, loadMe, apiFetch],
  );
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
  ADMIN: "Supervisor",
  CASHIER: "Cajero",
  WAITER: "Mesero",
  KITCHEN: "Cocina",
};
