"use client";

import { Eye, EyeOff, LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { FormAlert } from "@/components/form-alert";
import { button, choice, field } from "@/components/ui";
import { errorMessage, useApi } from "@/lib/api";
import { ApiError, ROLE_LABEL, type Role, useAuth } from "@/lib/auth";

interface DemoOrganization {
  handle: string;
  name: string;
  plan_tier: "SINGLE" | "MULTI";
}

/** Step 1 answer (Q32): the business and, if this browser is one of its authorized devices, that device. */
interface Business {
  handle: string;
  name: string;
  plan_tier: "SINGLE" | "MULTI";
  locations: { id: string; name: string }[];
  device: { id: string; name: string; location: { id: string; name: string } } | null;
}

const DEMO_ROLES: { role: Role; label: string }[] = [
  { role: "OWNER", label: "Dueño" },
  { role: "ADMIN", label: "Admin" },
  { role: "CASHIER", label: "Cajero" },
  { role: "WAITER", label: "Mesero" },
  { role: "KITCHEN", label: "Cocina" },
];
const PIN_ROLES: Role[] = ["CASHIER", "WAITER", "KITCHEN", "ADMIN", "OWNER"];
const START: Partial<Record<Role, string>> = { CASHIER: "/mesas", WAITER: "/mesas", KITCHEN: "/cocina" };
/** The business typed on this browser, so the team skips step 1 (Q32). */
const HANDLE_KEY = "pm_handle";
const labelClass = "mb-1.5 block text-sm font-medium text-ink-2";

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
  const [withEmail, setWithEmail] = useState(false);
  // While the device is being authorized right after login, stay here.
  const [holding, setHolding] = useState(false);
  const [demo, setDemo] = useState<DemoOrganization[]>([]);
  const [demoError, setDemoError] = useState<string | null>(null);
  const demoId = useId();

  useEffect(() => {
    // Cashiers and waiters work on the table map, the kitchen on its screen; everyone else starts at the summary.
    if (status === "authenticated" && !holding) router.replace(START[me?.user.role ?? "OWNER"] ?? "/");
  }, [status, me, router, holding]);

  useEffect(() => {
    const remembered = localStorage.getItem(HANDLE_KEY);
    // Nothing remembered (or no longer found): ask for the handle.
    (remembered ? lookup(remembered) : Promise.reject(new Error("none"))).then(setBusiness, () => setBusiness(null));
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

  const found = (b: Business) => {
    localStorage.setItem(HANDLE_KEY, b.handle);
    setWithEmail(false);
    setBusiness(b);
  };
  const change = () => {
    localStorage.removeItem(HANDLE_KEY);
    setBusiness(null);
  };

  return (
    <main className="flex min-h-dvh justify-center px-5 pt-[12vh] pb-12">
      <div className="w-full max-w-[400px]">
        <p className="enter mb-8 text-center text-xl font-semibold tracking-[-0.02em]">PractiMesa</p>

        <div className="enter rounded-panel border border-line bg-surface p-7 [--i:1] sm:p-8">
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
                  <h1 className="truncate text-2xl font-semibold tracking-[-0.02em]">{business.name}</h1>
                  <p className="mt-0.5 truncate text-[15px] text-muted">
                    @{business.handle}
                    {business.device && ` · ${business.device.location.name}`}
                  </p>
                </div>
                <button type="button" onClick={change} className={`${button.ghost} -mr-3 -mt-1`}>
                  Cambiar
                </button>
              </div>
              {business.device && !withEmail ? (
                <PinStep onEmail={() => setWithEmail(true)} />
              ) : (
                <EmailStep business={business} onHold={setHolding} onPin={business.device ? () => setWithEmail(false) : undefined} />
              )}
            </>
          )}
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
              <div key={org.handle} className="mt-4">
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
                      onClick={() => void enterDemo(org.handle, role)}
                      className={`${button.secondary} ${role === "OWNER" || role === "ADMIN" ? "col-span-3" : "col-span-2 px-2"}`}
                    >
                      {label}
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

        <p className={`enter mt-6 text-center text-sm text-muted text-pretty ${demo.length ? "[--i:3]" : "[--i:2]"}`}>
          ¿No tienes acceso? Pídele una cuenta al dueño de tu restaurante.
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

function HandleStep({ onFound }: { onFound: (business: Business) => void }) {
  const [handle, setHandle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!/^[A-Za-z0-9_]{3,30}$/.test(handle)) return setError("Escribe el identificador de tu negocio, por ejemplo @PizzeriaDario.");
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
      <h1 className="text-2xl font-semibold tracking-[-0.02em] text-balance">Inicia sesión</h1>
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
              placeholder="PizzeriaDario"
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

function PinStep({ onEmail }: { onEmail: () => void }) {
  const { pinLogin } = useAuth();
  const [role, setRole] = useState<Role>("CASHIER");
  const [username, setUsername] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!username || pin.length < 4) return setError("Escribe tu usuario y tu PIN.");
    setBusy(true);
    setError(null);
    try {
      await pinLogin(role, username, pin);
    } catch (err) {
      setError(messageFor(err, "Usuario o PIN incorrecto."));
      setPin("");
      setBusy(false);
    }
  }

  const invalid = error ? { "aria-invalid": true, "aria-describedby": errorId } : {};
  return (
    <form className="space-y-5" onSubmit={onSubmit} noValidate>
      <fieldset>
        <legend className={labelClass}>Entras como</legend>
        <div className="grid grid-cols-3 gap-2">
          {PIN_ROLES.map((r) => (
            <label key={r} className={`${choice} px-2`}>
              <input type="radio" name="role" checked={role === r} onChange={() => setRole(r)} className="sr-only" />
              {r === "ADMIN" ? "Admin" : ROLE_LABEL[r]}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="block">
        <span className={labelClass}>Usuario</span>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value.toLowerCase().trim())}
          maxLength={30}
          autoCapitalize="none"
          autoComplete="username"
          spellCheck={false}
          placeholder="alex.navarro"
          className={`${field} font-mono`}
          {...invalid}
        />
      </label>
      <label className="block">
        <span className={labelClass}>PIN</span>
        <input
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
      <p className="text-center text-sm text-muted">
        ¿Eres el dueño o administrador?{" "}
        <button type="button" onClick={onEmail} className="font-medium text-accent-strong underline-offset-2 hover:underline">
          Entrar con correo
        </button>
      </p>
    </form>
  );
}

function EmailStep({ business, onHold, onPin }: { business: Business; onHold: (hold: boolean) => void; onPin?: () => void }) {
  const { login } = useAuth();
  const api = useApi();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(false);
  const [deviceName, setDeviceName] = useState("");
  const [locationId, setLocationId] = useState(business.locations[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Signed in, but this device could not be remembered: say so before going on.
  const [inside, setInside] = useState(false);
  const errorId = useId();
  const multi = business.plan_tier === "MULTI";

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!email.trim() || !password) return setError("Escribe tu correo y tu contraseña.");
    if (remember && !deviceName.trim()) return setError("Ponle un nombre a este dispositivo, por ejemplo Caja principal.");
    setBusy(true);
    setError(null);
    onHold(remember);
    try {
      await login(email, password, business.handle);
    } catch (err) {
      setError(messageFor(err));
      setBusy(false);
      onHold(false);
      return;
    }
    if (!remember) return;
    try {
      await api("/devices", "POST", { name: deviceName.trim(), ...(multi ? { location_id: locationId } : {}) });
      onHold(false);
    } catch (err) {
      setInside(true);
      setError(`Entraste, pero no pudimos recordar este dispositivo: ${errorMessage(err)}`);
    }
  }

  const invalid = error && !inside ? { "aria-invalid": true, "aria-describedby": errorId } : {};
  return (
    <form className="space-y-5" onSubmit={onSubmit} noValidate>
      {!onPin && (
        <p className="-mt-2 text-sm text-muted text-pretty">
          Dueño o administrador: entra con tu correo. Para que tu equipo entre con usuario y PIN aquí, recuerda este dispositivo.
        </p>
      )}
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
          placeholder="tu@restaurante.com"
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

      {!onPin && (
        <div className="rounded-control border border-line p-4">
          <label className="flex items-start gap-3 text-[15px]">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="mt-0.5 size-5 shrink-0 accent-accent"
            />
            <span>
              Recordar este dispositivo para el equipo
              <span className="block text-sm text-muted">Cajeros, meseros y cocina podrán entrar aquí con su usuario y PIN.</span>
            </span>
          </label>
          {remember && (
            <div className="mt-4 space-y-4">
              <label className="block">
                <span className={labelClass}>Nombre del dispositivo</span>
                <input
                  value={deviceName}
                  onChange={(e) => setDeviceName(e.target.value)}
                  maxLength={80}
                  placeholder="Caja principal"
                  className={field}
                />
              </label>
              {multi && (
                <label className="block">
                  <span className={labelClass}>Sede</span>
                  <select value={locationId} onChange={(e) => setLocationId(e.target.value)} className={field}>
                    {business.locations.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          )}
        </div>
      )}

      {error && <FormAlert id={errorId}>{error}</FormAlert>}
      {inside ? (
        <button type="button" onClick={() => onHold(false)} className={`${button.primary} w-full`}>
          Continuar al panel
        </button>
      ) : (
        <button type="submit" disabled={busy} className={`${button.primary} w-full`}>
          {busy && spinner}
          {busy ? "Entrando…" : "Entrar"}
        </button>
      )}
      {onPin && (
        <p className="text-center text-sm text-muted">
          <button type="button" onClick={onPin} className="font-medium text-accent-strong underline-offset-2 hover:underline">
            Entrar con usuario y PIN
          </button>
        </p>
      )}
    </form>
  );
}
