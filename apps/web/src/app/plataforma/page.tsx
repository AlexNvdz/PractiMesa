"use client";

import { AlertCircle, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { platformApi, type PlatformAdmin } from "@/components/platform/api";
import { Businesses } from "@/components/platform/businesses";
import { Invitations } from "@/components/platform/invitations";
import { button, field } from "@/components/ui";
import { ApiError } from "@/lib/auth";

function messageFor(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return "Correo o contraseña incorrectos.";
    if (err.status === 429) return "Demasiados intentos. Espera un minuto e inténtalo de nuevo.";
    if (err.status === 400) return "Escribe tu correo y tu contraseña.";
    return "Algo falló de nuestro lado. Inténtalo de nuevo en un momento.";
  }
  return "No pudimos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.";
}

/** SaaS owner console (Q27): own login and cookie, separate from the restaurant panel. */
export default function PlataformaPage() {
  const [admin, setAdmin] = useState<PlatformAdmin | null | undefined>(undefined);
  const endSession = useCallback(() => setAdmin(null), []);
  const [section, setSection] = useState<"businesses" | "invitations">("businesses");

  useEffect(() => {
    platformApi<PlatformAdmin>("/me").then(setAdmin, () => setAdmin(null));
  }, []);

  if (admin === undefined) {
    return (
      <div role="status" className="flex min-h-dvh items-center justify-center text-muted">
        <LoaderCircle size={22} className="animate-spin motion-reduce:[animation-duration:6s]" aria-hidden />
        <span className="sr-only">Cargando…</span>
      </div>
    );
  }
  if (!admin) return <PlatformLogin onLogin={setAdmin} />;

  const logout = async () => {
    await platformApi("/auth/logout", "POST").catch(() => undefined);
    setAdmin(null);
  };

  return (
    <div className="min-h-dvh">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-5">
          <p className="text-xl font-semibold tracking-[-0.02em]">PractiMesa</p>
          <span className="rounded-full bg-ground px-2 py-0.5 text-xs font-medium text-muted">Plataforma</span>
          <nav aria-label="Secciones" className="ml-4 flex gap-1">
            {(
              [
                ["businesses", "Negocios"],
                ["invitations", "Invitaciones"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-current={section === value ? "page" : undefined}
                onClick={() => setSection(value)}
                className="flex h-10 items-center rounded-control px-3 text-sm text-ink-2 transition-[background-color,color] duration-150 hover:bg-ground hover:text-ink aria-[current=page]:bg-accent-soft aria-[current=page]:font-medium aria-[current=page]:text-accent-strong"
              >
                {label}
              </button>
            ))}
          </nav>
          <span className="ml-auto hidden truncate text-sm text-muted sm:block">{admin.full_name}</span>
          <button type="button" onClick={() => void logout()} className={`${button.ghost} -mr-3`}>
            Salir
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-5 py-8">
        {section === "businesses" ? <Businesses onSessionEnd={endSession} /> : <Invitations onSessionEnd={endSession} />}
      </main>
    </div>
  );
}

function PlatformLogin({ onLogin }: { onLogin: (admin: PlatformAdmin) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await platformApi("/auth/login", "POST", { email, password });
      onLogin(await platformApi<PlatformAdmin>("/me"));
    } catch (err) {
      setError(messageFor(err));
      setSubmitting(false);
    }
  }

  const invalid = error ? { "aria-invalid": true, "aria-describedby": errorId } : {};

  return (
    <main className="flex min-h-dvh justify-center px-5 pt-[14vh] pb-12">
      <div className="w-full max-w-[400px]">
        <p className="enter mb-8 text-center text-xl font-semibold tracking-[-0.02em]">PractiMesa</p>
        <div className="enter rounded-panel border border-line bg-surface p-7 [--i:1] sm:p-8">
          <h1 className="text-2xl font-semibold tracking-[-0.02em] text-balance">Plataforma</h1>
          <p className="mt-1.5 text-[15px] text-muted">Administra los negocios de PractiMesa.</p>
          <form className="mt-7 space-y-5" onSubmit={onSubmit}>
            <label className="block space-y-1.5">
              <span className="block text-sm font-medium text-ink-2">Correo</span>
              <input
                type="email"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={field}
                {...invalid}
              />
            </label>
            <label className="block space-y-1.5">
              <span className="block text-sm font-medium text-ink-2">Contraseña</span>
              <input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={field}
                {...invalid}
              />
            </label>
            {error && (
              <p
                id={errorId}
                role="alert"
                className="flex items-start gap-2 rounded-control bg-danger-soft px-3 py-2.5 text-sm text-danger"
              >
                <AlertCircle size={16} strokeWidth={2.25} className="mt-0.5 shrink-0" aria-hidden />
                {error}
              </p>
            )}
            <button type="submit" disabled={submitting} className={`${button.primary} w-full`}>
              {submitting && <LoaderCircle size={18} className="animate-spin motion-reduce:[animation-duration:6s]" aria-hidden />}
              {submitting ? "Entrando…" : "Entrar"}
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}
