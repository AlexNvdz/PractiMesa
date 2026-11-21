"use client";

import { useCallback } from "react";
import { ApiError, useAuth } from "./auth";

/** JSON call to the API for the current location; failures throw ApiError with the API's message. */
export function useApi() {
  const { apiFetch } = useAuth();
  return useCallback(
    async <T,>(path: string, method = "GET", body?: unknown): Promise<T> => {
      const res = await apiFetch(`/api${path}`, {
        method,
        ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      });
      const data: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const message = (data as { message?: unknown } | null)?.message;
        throw new ApiError(res.status, typeof message === "string" ? message : undefined);
      }
      return data as T;
    },
    [apiFetch],
  );
}

/** What to tell the person when a call fails. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError && err.detail) return err.detail;
  if (err instanceof ApiError && err.status === 403) return "Tu usuario no tiene permiso para hacer esto.";
  if (err instanceof ApiError) return "Algo falló de nuestro lado. Inténtalo de nuevo en un momento.";
  return "No pudimos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.";
}
