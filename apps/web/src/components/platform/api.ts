import { ApiError } from "@/lib/auth";

/** Platform API: the session is the httpOnly pm_platform cookie, not the panel's token. */
export async function platformApi<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(`/api/platform${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (data as { message?: unknown } | null)?.message;
    throw new ApiError(res.status, typeof message === "string" ? message : undefined);
  }
  return data as T;
}

export interface PlatformAdmin {
  id: string;
  email: string;
  full_name: string;
}

export interface Organization {
  id: string;
  handle: string;
  name: string;
  nit: string | null;
  plan_tier: "SINGLE" | "MULTI";
  max_locations: number;
  suspended_at: string | null;
  created_at: string;
  _count: { locations: number };
}

export const PLAN_LABEL = { SINGLE: "Pequeño", MULTI: "Multilocal" } as const;
