"use client";

import { ArrowLeft, Eye, EyeOff, KeyRound, LoaderCircle, Mail } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { FormAlert } from "@/components/form-alert";
import { Logo } from "@/components/logo";
import { button, field } from "@/components/ui";
import { ApiError, ROLE_LABEL, type Role, useAuth } from "@/lib/auth";

interface DemoOrganization {
  handle: string;
  name: string;
  plan_tier: "SINGLE" | "MULTI";
}

type Device = { id: string; name: string; location: { id: string; name: string } };
/** Step 1 answer: the business and, if this browser is one of its linked devices, that device. */
interface Business {
  handle: string;
  name: string;
  device: Device | null;
}
/** Step 2: PIN on a linked device; on another one, link it with a code or the owner signs in with email. */
type Mode = "pin" | "unlinked" | "code" | "email";

const DEMO_ROLES: Role[] = ["OWNER", "ADMIN", "CASHIER", "WAITER", "KITCHEN"];
const START: Partial<Record<Role, string>> = { CASHIER: "/mesas", WAITER: "/mesas", KITCHEN: "/cocina" };
/** The business typed on this browser, so the team skips step 1. */
const HANDLE_KEY = "pm_handle";
const labelClass = "mb-1.5 block text-sm font-semibold text-ink-2";
const card = "rounded-sheet bg-surface shadow-panel ring-1 ring-ink/5";
const heading = "font-display text-2xl font-bold tracking-[-0.02em] text-balance";

function messageFor(err: unknown, unauthorized = "Correo o contraseña incorrectos."): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return err.detail && err.detail !== "Unauthorized" ? err.detail : unauthorized;
    // The PIN lockout explains itself; the generic rate limit does not (and comes in English).
    if (err.status === 429)
      return err.detail?.startsWith("Demasiados") ? err.detail : "Demasiados intentos. Espera un minuto e inténtalo de nuevo.";
    if (err.status === 400) return "Revisa los datos e inténtalo de nuevo.";
    if (err.detail && err.status < 500) return err.detail;
    return "Algo falló de nuestro lado. Inténtalo de nuevo en un momento.";
  }
  return "No pudimos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.";
}

const spinner = <LoaderCircle size={18} className="animate-spin motion-reduce:[animation-duration:6s]" aria-hidden />;

export default function LoginPage() {
  const { status, me, demoLogin } = useAuth();
  const router = useRouter();
  // undefined = still reading the remembered business; null = ask for it.
  const [business, setBusiness] = useState<Business | null | undefined>(undefined);
  const [mode, setMode] = useState<Mode>("pin");
  const [demo, setDemo] = useState<DemoOrganization[]>([]);
  const [demoError, setDemoError] = useState<string | null>(null);
  const demoId = useId();

  useEffect(() => {
    // Cashiers and waiters work on the table map, the kitchen on its screen; everyone else starts at the summary.
    if (status === "authenticated") router.replace(START[me?.user.role ?? "OWNER"] ?? "/");
  }, [status, me, router]);

  const found = (b: Business) => {
    localStorage.setItem(HANDLE_KEY, b.handle);
    setMode(b.device ? "pin" : "unlinked");
    setBusiness(b);
  };

  useEffect(() => {
    const remembered = localStorage.getItem(HANDLE_KEY);
    // Nothing remembered (or no longer found): ask for the handle.
    (remembered ? lookup(remembered) : Promise.reject(new Error("none"))).then(found, () => setBusiness(null));
  }, []);

  // The API answers 404 where demo login is off: then there are no demo buttons.
  useEffect(() => {
    fetch("/api/auth/demo")
      .then((res) => (res.ok ? (res.json() as Promise<DemoOrganization[]>) : []))
      .then(setDemo, () => undefined);
  }, []);

  async function enterDemo(handle: string, role: Role) {
    setDemoError(null);
    try {
      await demoLogin(handle, role);
    } catch (err) {
      setDemoError(messageFor(err));
    }
  }

  const change = () => {
    localStorage.removeItem(HANDLE_KEY);
    setBusiness(null);
  };

  return (
    <main className="relative flex min-h-dvh justify-center bg-surface px-4 pt-[10vh] pb-12">
      <div aria-hidden className="login-canvas" />
      <div className="relative w-full max-w-[420px]">

        {/* Next keeps this page mounted (hidden) while the panel is open: remounting on every session change
            clears typed PINs and passwords and the "Entrando…" state for the next person. */}
        <div key={status} className={`enter ${card} px-6 pt-8 pb-7 sm:px-8 sm:pt-9`}>
          <Logo size={44} className="mb-7 text-[26px]" />
          {business === undefined && (
            <div role="status" className="flex justify-center py-10 text-muted">
              {spinner}
              <span className="sr-only">Cargando…</span>
            </div>
          )}
          {business === null && <HandleStep onFound={found} />}
          {business && (
            <>
              <div className="mb-6 flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <h1 className={`truncate ${heading}`}>{business.name}</h1>
                  <p className="mt-0.5 truncate text-[15px] text-muted">
                    @{business.handle}
                    {business.device && ` · ${business.device.location.name}`}
                  </p>
                </div>
                <button type="button" onClick={change} className={`${button.ghost} -mt-1 -mr-3`}>
                  Cambiar
                </button>
              </div>
              {mode === "pin" && <PinStep onEmail={() => setMode("email")} />}
              {mode === "unlinked" && <UnlinkedStep onCode={() => setMode("code")} onEmail={() => setMode("email")} />}
              {mode === "code" && (
                <CodeStep handle={business.handle} onLinked={(device) => found({ ...business, device })} onBack={() => setMode("unlinked")} />
              )}
              {mode === "email" && (
                <EmailStep handle={business.handle} linked={!!business.device} onBack={() => setMode(business.device ? "pin" : "unlinked")} />
              )}
            </>
          )}
        </div>

        {demo.length > 0 && (
          <section aria-labelledby={demoId} className={`enter mt-4 ${card} p-5 [--i:1] sm:px-8`}>
            <h2 id={demoId} className="font-display text-[17px] font-bold tracking-[-0.01em]">
              Entrar como demo
            </h2>
            <p className="mt-0.5 text-sm text-muted text-pretty">
              {demo.length === 1 ? `${demo[0].name}, con datos de ejemplo.` : "Negocios con datos de ejemplo."} Elige un rol para ver su
              pantalla.
            </p>
            {demo.map((org) => (
              <div key={org.handle} className="mt-4">
                {demo.length > 1 && (
                  <p className="mb-2 text-sm font-medium text-ink-2">
                    {org.name} · {org.plan_tier === "SINGLE" ? "1 sede" : "varias sedes"}
                  </p>
                )}
                {/* Owner and supervisor on the first row, the three staff roles on the second. */}
                <div className="grid grid-cols-6 gap-2">
                  {DEMO_ROLES.map((role) => (
                    <button
                      key={role}
                      type="button"
                      onClick={() => void enterDemo(org.handle, role)}
                      className={`${button.secondary} h-10 rounded-full text-sm ${role === "OWNER" || role === "ADMIN" ? "col-span-3" : "col-span-2 px-2"}`}
                    >
                      {ROLE_LABEL[role]}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            {demoError && (
              <div className="mt-4">
                <FormAlert>{demoError}</FormAlert>
              </div>
            )}
          </section>
        )}

        <p className={`enter mt-6 text-center text-sm text-muted text-pretty ${demo.length ? "[--i:2]" : "[--i:1]"}`}>
          ¿No tienes usuario? Pídeselo al dueño de tu negocio.
        </p>
      </div>
    </main>
  );
}

async function lookup(handle: string): Promise<Business> {
  const res = await fetch(`/api/auth/business/${encodeURIComponent(handle)}`);
  if (!res.ok) throw new ApiError(res.status);
  return (await res.json()) as Business;
}

/** Link to the other way in, under the main button. */
function SwitchLink({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <p className="text-center">
      <button
        type="button"
        onClick={onClick}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-control px-2 text-sm font-semibold text-accent underline underline-offset-[3px] hover:text-accent-strong"
      >
        {children}
      </button>
    </p>
  );
}

function HandleStep({ onFound }: { onFound: (business: Business) => void }) {
  const [handle, setHandle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!/^[A-Za-z0-9_]{3,30}$/.test(handle)) return setError("El identificador lleva letras, números y _ (de 3 a 30).");
    setBusy(true);
    setError(null);
    try {
      onFound(await lookup(handle));
    } catch (err) {
      setError(err instanceof ApiError && err.status === 404 ? "No encontramos ese negocio. Revisa el identificador." : messageFor(err));
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className={heading}>Inicia sesión</h1>
      <p className="mt-1.5 text-[15px] text-muted">Escribe el identificador de tu negocio.</p>
      <form className="mt-7 space-y-5" onSubmit={onSubmit} noValidate>
        <label className="block">
          <span className={labelClass}>Identificador</span>
          <span className="relative block">
            <span aria-hidden className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-muted">
              @
            </span>
            <input
              value={handle}
              onChange={(e) => setHandle(e.target.value.replace(/^@/, "").trim())}
              maxLength={30}
              autoCapitalize="none"
              autoComplete="organization"
              spellCheck={false}
              enterKeyHint="go"
              placeholder="TuNegocio"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              className={`${field} pl-7`}
            />
          </span>
        </label>
        {error && <FormAlert id={errorId}>{error}</FormAlert>}
        <button type="submit" disabled={busy} className={`${button.primary} w-full`}>
          {busy && spinner}
          Continuar
        </button>
      </form>
    </>
  );
}

/** Username + PIN on a linked device: the API finds the role and the location from the user and the device. */
function PinStep({ onEmail }: { onEmail: () => void }) {
  const { pinLogin } = useAuth();
  const [username, setUsername] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const pinField = useRef<HTMLInputElement>(null);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!username || pin.length < 4) return setError("Escribe tu usuario y tu PIN.");
    setBusy(true);
    setError(null);
    try {
      await pinLogin(username, pin);
    } catch (err) {
      setError(messageFor(err, "Usuario o PIN incorrecto."));
      setPin("");
      setBusy(false);
      // A short shake says "wrong PIN" at a glance; the field stays focused for the next try.
      pinField.current?.focus();
      if (!matchMedia("(prefers-reduced-motion: reduce)").matches)
        pinField.current?.animate({ translate: ["0", "-6px", "6px", "-6px", "6px", "0"] }, { duration: 400 });
    }
  }

  const invalid = error ? { "aria-invalid": true, "aria-describedby": errorId } : {};
  return (
    <form className="space-y-5" onSubmit={onSubmit} noValidate>
      <label className="block">
        <span className={labelClass}>Usuario</span>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value.toLowerCase().trim())}
          maxLength={30}
          autoCapitalize="none"
          autoComplete="username"
          spellCheck={false}
          placeholder="usuario.ejemplo"
          className={`${field} font-mono`}
          {...invalid}
        />
      </label>
      <label className="block">
        <span className={labelClass}>PIN</span>
        <input
          ref={pinField}
          type="password"
          inputMode="numeric"
          autoComplete="current-password"
          enterKeyHint="go"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
          className={`${field} figures tracking-[0.3em]`}
          {...invalid}
        />
      </label>
      {error && <FormAlert id={errorId}>{error}</FormAlert>}
      <button type="submit" disabled={busy} className={`${button.primary} w-full`}>
        {busy && spinner}
        {busy ? "Entrando…" : "Entrar"}
      </button>
      <SwitchLink onClick={onEmail}>¿Eres el dueño? Entra con tu correo</SwitchLink>
    </form>
  );
}

/** A browser that is not linked: the team cannot use PIN here until the owner links it. */
function UnlinkedStep({ onCode, onEmail }: { onCode: () => void; onEmail: () => void }) {
  return (
    <div>
      <p className="-mt-2 text-[15px] text-ink-2 text-pretty">
        Este dispositivo no está vinculado. Para que tu equipo entre aquí con usuario y PIN, pídele al dueño un código de vinculación.
      </p>
      <div className="mt-6 space-y-3">
        <button type="button" onClick={onCode} className={`${button.primary} w-full`}>
          <KeyRound size={18} strokeWidth={2.25} aria-hidden />
          Tengo un código de vinculación
        </button>
        <button type="button" onClick={onEmail} className={`${button.secondary} w-full`}>
          <Mail size={18} strokeWidth={2.25} aria-hidden />
          Soy el dueño: entrar con correo
        </button>
      </div>
    </div>
  );
}

/** One-time code from the owner: links this browser to the location and name the owner chose. */
function CodeStep({ handle, onLinked, onBack }: { handle: string; onLinked: (device: Device) => void; onBack: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const hintId = useId();
  const clean = code.replace("-", "");

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (clean.length !== 8) return setError("El código tiene 8 caracteres.");
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/device", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle, code: clean }),
      });
      const body = (await res.json().catch(() => null)) as (Device & { message?: unknown }) | null;
      if (!res.ok) throw new ApiError(res.status, typeof body?.message === "string" ? body.message : undefined);
      onLinked(body as Device);
    } catch (err) {
      setError(messageFor(err, "Código incorrecto o vencido. Pide al dueño uno nuevo."));
      setBusy(false);
    }
  }

  return (
    <form className="space-y-5" onSubmit={onSubmit} noValidate>
      <label className="block">
        <span className={labelClass}>Código de vinculación</span>
        <input
          value={code}
          // Shown as ABCD-EFGH, the way the owner sees it; the API ignores the dash.
          onChange={(e) => {
            const raw = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
            setCode(raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw);
          }}
          autoCapitalize="characters"
          autoComplete="one-time-code"
          spellCheck={false}
          enterKeyHint="go"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${hintId} ${errorId}` : hintId}
          className={`${field} font-mono text-lg tracking-[0.2em]`}
        />
        <span id={hintId} className="mt-1.5 block text-sm text-muted text-pretty">
          El dueño lo genera en Dispositivos. Sirve una sola vez y vence a los 10 minutos.
        </span>
      </label>
      {error && <FormAlert id={errorId}>{error}</FormAlert>}
      <button type="submit" disabled={busy} className={`${button.primary} w-full`}>
        {busy && spinner}
        {busy ? "Vinculando…" : "Vincular dispositivo"}
      </button>
      <SwitchLink onClick={onBack}>
        <ArrowLeft size={16} strokeWidth={2.25} aria-hidden />
        Volver
      </SwitchLink>
    </form>
  );
}

/** Only the owner signs in with email + password, from any browser. */
function EmailStep({ handle, linked, onBack }: { handle: string; linked: boolean; onBack: () => void }) {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!email.trim() || !password) return setError("Escribe tu correo y tu contraseña.");
    setBusy(true);
    setError(null);
    try {
      await login(email, password, handle);
    } catch (err) {
      setError(messageFor(err));
      setBusy(false);
    }
  }

  const invalid = error ? { "aria-invalid": true, "aria-describedby": errorId } : {};
  return (
    <form className="space-y-5" onSubmit={onSubmit} noValidate>
      <p className="-mt-2 text-sm text-muted text-pretty">Solo el dueño entra con correo. Tu equipo entra con usuario y PIN.</p>
      <label className="block">
        <span className={labelClass}>Correo</span>
        <input
          type="email"
          inputMode="email"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="correo@ejemplo.com"
          className={field}
          {...invalid}
        />
      </label>
      <label className="block">
        <span className={labelClass}>Contraseña</span>
        <span className="relative block">
          <input
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={`${field} pr-11`}
            {...invalid}
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            aria-label={showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
            aria-pressed={showPassword}
            className="absolute inset-y-0 right-0 grid w-11 place-items-center rounded-r-control text-muted transition-[color] duration-150 hover:text-ink"
          >
            {showPassword ? <EyeOff size={18} aria-hidden /> : <Eye size={18} aria-hidden />}
          </button>
        </span>
      </label>
      {error && <FormAlert id={errorId}>{error}</FormAlert>}
      <button type="submit" disabled={busy} className={`${button.primary} w-full`}>
        {busy && spinner}
        {busy ? "Entrando…" : "Entrar"}
      </button>
      <SwitchLink onClick={onBack}>
        {linked ? (
          "Entrar con usuario y PIN"
        ) : (
          <>
            <ArrowLeft size={16} strokeWidth={2.25} aria-hidden />
            Volver
          </>
        )}
      </SwitchLink>
    </form>
  );
}
