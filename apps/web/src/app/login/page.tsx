"use client";

import { AlertCircle, Eye, EyeOff, LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { button } from "@/components/ui";
import { ApiError, type Role, useAuth } from "@/lib/auth";

interface DemoOrganization {
  slug: string;
  name: string;
  plan_tier: "SINGLE" | "MULTI";
}

const DEMO_ROLES: { role: Role; label: string }[] = [
  { role: "OWNER", label: "Dueño" },
  { role: "ADMIN", label: "Admin" },
  { role: "CASHIER", label: "Cajero" },
  { role: "WAITER", label: "Mesero" },
  { role: "KITCHEN", label: "Cocina" },
];

const START: Partial<Record<Role, string>> = { CASHIER: "/mesas", WAITER: "/mesas", KITCHEN: "/cocina" };

function messageFor(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return "Correo o contraseña incorrectos.";
    if (err.status === 429) return "Demasiados intentos. Espera un minuto e inténtalo de nuevo.";
    if (err.status === 400) return "Escribe tu correo y tu contraseña.";
    return "Algo falló de nuestro lado. Inténtalo de nuevo en un momento.";
  }
  return "No pudimos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.";
}

// Infrequent icon swap: both icons stay mounted and cross-fade (scale and blur only when motion is allowed).
const swap =
  "col-start-1 row-start-1 transition-[opacity,scale,filter] duration-300 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-opacity";
const hidden = "opacity-0 scale-25 blur-[4px] motion-reduce:scale-100 motion-reduce:blur-none";

export default function LoginPage() {
  const { status, me, login, demoLogin } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [demo, setDemo] = useState<DemoOrganization[]>([]);
  const errorId = useId();
  const demoId = useId();

  useEffect(() => {
    // Cashiers and waiters work on the table map, the kitchen on its screen; everyone else starts at the summary.
    if (status === "authenticated") router.replace(START[me?.user.role ?? "OWNER"] ?? "/");
  }, [status, me, router]);

  // The API answers 404 where demo login is off: then there are no demo buttons.
  useEffect(() => {
    fetch("/api/auth/demo")
      .then((res) => (res.ok ? (res.json() as Promise<DemoOrganization[]>) : []))
      .then(setDemo, () => undefined);
  }, []);

  async function enterDemo(slug: string, role: Role) {
    setError(null);
    setSubmitting(true);
    try {
      await demoLogin(slug, role);
    } catch (err) {
      setError(messageFor(err));
      setSubmitting(false);
    }
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
    } catch (err) {
      setError(messageFor(err));
      setSubmitting(false);
    }
  }

  const fieldClass =
    "h-11 w-full rounded-control border border-line-strong bg-surface px-3 text-base text-ink placeholder:text-muted transition-[border-color] duration-150 hover:border-muted focus:border-accent focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent aria-[invalid=true]:border-danger";

  return (
    <main className="flex min-h-dvh justify-center px-5 pt-[14vh] pb-12">
      <div className="w-full max-w-[400px]">
        <p className="enter mb-8 text-center text-xl font-semibold tracking-[-0.02em]">PractiMesa</p>

        <div className="enter rounded-panel border border-line bg-surface p-7 [--i:1] sm:p-8">
          <h1 className="text-2xl font-semibold tracking-[-0.02em] text-balance">Inicia sesión</h1>
          <p className="mt-1.5 text-[15px] text-muted">Entra al panel de tu restaurante.</p>

          <form className="mt-7 space-y-5" onSubmit={onSubmit}>
            <div className="space-y-1.5">
              <label htmlFor="email" className="block text-sm font-medium text-ink-2">
                Correo
              </label>
              <input
                id="email"
                name="email"
                type="email"
                inputMode="email"
                autoComplete="username"
                enterKeyHint="next"
                autoCapitalize="none"
                spellCheck={false}
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
                className={fieldClass}
                placeholder="tu@restaurante.com"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="password" className="block text-sm font-medium text-ink-2">
                Contraseña
              </label>
              <div className="relative">
                <input
                  id="password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  enterKeyHint="done"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? errorId : undefined}
                  className={`${fieldClass} pr-11`}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
                  aria-pressed={showPassword}
                  className="absolute inset-y-0 right-0 grid w-11 place-items-center rounded-r-control text-muted transition-[color] duration-150 hover:text-ink"
                >
                  <Eye size={18} aria-hidden className={`${swap} ${showPassword ? hidden : ""}`} />
                  <EyeOff size={18} aria-hidden className={`${swap} ${showPassword ? "" : hidden}`} />
                </button>
              </div>
            </div>

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

            <button
              type="submit"
              disabled={submitting}
              className="flex h-11 w-full items-center justify-center gap-2 rounded-control bg-accent text-[15px] font-medium text-white transition-[background-color,scale] duration-150 ease-out hover:bg-accent-strong disabled:cursor-wait disabled:opacity-80 motion-safe:enabled:active:scale-[0.96]"
            >
              {submitting && <LoaderCircle size={18} className="animate-spin motion-reduce:[animation-duration:6s]" aria-hidden />}
              {submitting ? "Entrando…" : "Entrar"}
            </button>
          </form>
        </div>

        {demo.length > 0 && (
          <section aria-labelledby={demoId} className="enter mt-4 rounded-panel border border-line bg-surface p-5 [--i:2] sm:px-8">
            <h2 id={demoId} className="text-[15px] font-semibold">
              Entrar como demo
            </h2>
            <p className="mt-0.5 text-sm text-muted text-pretty">
              {demo.length === 1 ? `${demo[0].name}, con datos de ejemplo.` : "Negocios con datos de ejemplo."} Elige un rol para ver su
              pantalla.
            </p>
            {demo.map((org) => (
              <div key={org.slug} className="mt-4">
                {demo.length > 1 && (
                  <p className="mb-2 text-sm font-medium text-ink-2">
                    {org.name} · {org.plan_tier === "SINGLE" ? "1 sede" : "varias sedes"}
                  </p>
                )}
                {/* Managers on the first row, the three staff roles on the second. */}
                <div className="grid grid-cols-6 gap-2">
                  {DEMO_ROLES.map(({ role, label }) => (
                    <button
                      key={role}
                      type="button"
                      disabled={submitting}
                      onClick={() => void enterDemo(org.slug, role)}
                      className={`${button.secondary} ${role === "OWNER" || role === "ADMIN" ? "col-span-3" : "col-span-2 px-2"}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </section>
        )}

        <p className={`enter mt-6 text-center text-sm text-muted text-pretty ${demo.length ? "[--i:3]" : "[--i:2]"}`}>
          ¿No tienes acceso? Pídele una cuenta al dueño de tu restaurante.
        </p>
      </div>
    </main>
  );
}
