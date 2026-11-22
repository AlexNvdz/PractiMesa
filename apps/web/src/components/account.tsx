"use client";

import { CircleCheck, LoaderCircle } from "lucide-react";
import { useId, useState } from "react";
import { FormAlert } from "@/components/form-alert";
import { button, field } from "@/components/ui";
import { errorMessage, useApi } from "@/lib/api";
import { type Me, ROLE_LABEL, useAuth } from "@/lib/auth";

const labelClass = "mb-1.5 block text-sm font-medium text-ink-2";
const hintClass = "mt-1.5 block text-sm text-muted text-pretty";
const panel = "rounded-panel border border-line bg-surface p-5 sm:p-6";
const spinner = <LoaderCircle size={18} className="animate-spin motion-reduce:[animation-duration:6s]" aria-hidden />;

function Saved({ children }: { children: React.ReactNode }) {
  return (
    <p role="status" className="flex items-center gap-2 text-sm font-medium text-success">
      <CircleCheck size={16} strokeWidth={2.25} aria-hidden />
      {children}
    </p>
  );
}

/** Mi cuenta: everyone changes its own PIN; the owner also its username, email and password. */
export function Account({ me }: { me: Me }) {
  return (
    <div className="max-w-2xl space-y-6">
      <section className={panel} aria-labelledby="account-who">
        <h2 id="account-who" className="text-[15px] font-semibold">
          {me.user.full_name}
        </h2>
        <p className="mt-0.5 text-sm text-muted">
          {ROLE_LABEL[me.user.role]} · @{me.organization.handle}
          {me.user.username && (
            <>
              {" · "}
              <span className="font-mono">{me.user.username}</span>
            </>
          )}
        </p>
        {me.user.role !== "OWNER" && (
          <p className="mt-3 text-sm text-muted text-pretty">Tu nombre, usuario, rol y sedes los cambia el dueño en Equipo.</p>
        )}
      </section>
      <PinForm me={me} />
      {me.user.role === "OWNER" && <OwnerForm me={me} />}
    </div>
  );
}

function PinForm({ me }: { me: Me }) {
  const api = useApi();
  const { reloadMe } = useAuth();
  const [current, setCurrent] = useState("");
  const [pin, setPin] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const titleId = useId();
  const hasPin = me.user.has_pin;
  const digits = (set: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => set(e.target.value.replace(/\D/g, "").slice(0, 6));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setDone(false);
    if (hasPin && current.length < 4) return setError("Escribe tu PIN actual.");
    if (!/^\d{4,6}$/.test(pin)) return setError("El PIN nuevo tiene de 4 a 6 dígitos.");
    if (pin !== repeat) return setError("Los dos PIN nuevos no coinciden.");
    setBusy(true);
    setError(null);
    try {
      await api("/me/pin", "PUT", { pin, ...(hasPin ? { current_pin: current } : {}) });
      setCurrent("");
      setPin("");
      setRepeat("");
      setDone(true);
      if (!hasPin) await reloadMe();
    } catch (err) {
      setError(errorMessage(err));
    }
    setBusy(false);
  };

  const pinField = `${field} figures tracking-[0.3em]`;
  return (
    <form onSubmit={submit} noValidate className={panel} aria-labelledby={titleId}>
      <h2 id={titleId} className="text-[15px] font-semibold">
        {hasPin ? "Cambiar mi PIN" : "Crear mi PIN"}
      </h2>
      <p className="mt-0.5 text-sm text-muted text-pretty">
        {me.user.role === "OWNER"
          ? "Con tu usuario y PIN entras rápido en los dispositivos vinculados del negocio."
          : "Con tu usuario y este PIN entras a trabajar. No se lo digas a nadie."}
      </p>
      <div className="mt-5 grid gap-4 sm:grid-cols-3">
        {hasPin && (
          <label className="block">
            <span className={labelClass}>PIN actual</span>
            <input type="password" inputMode="numeric" autoComplete="current-password" value={current} onChange={digits(setCurrent)} className={pinField} />
          </label>
        )}
        <label className="block">
          <span className={labelClass}>PIN nuevo</span>
          <input type="password" inputMode="numeric" autoComplete="new-password" value={pin} onChange={digits(setPin)} className={pinField} />
        </label>
        <label className="block">
          <span className={labelClass}>Repite el PIN nuevo</span>
          <input type="password" inputMode="numeric" autoComplete="new-password" value={repeat} onChange={digits(setRepeat)} className={pinField} />
        </label>
      </div>
      <span className={hintClass}>De 4 a 6 dígitos.</span>
      {error && (
        <div className="mt-4">
          <FormAlert>{error}</FormAlert>
        </div>
      )}
      <div className="mt-5 flex flex-wrap items-center justify-end gap-4 border-t border-line pt-5">
        {done && <Saved>PIN guardado</Saved>}
        <button type="submit" disabled={busy} className={button.primary}>
          {busy && spinner}
          {hasPin ? "Cambiar PIN" : "Crear PIN"}
        </button>
      </div>
    </form>
  );
}

/** Owner only: its names, and sign-in data confirmed with the current password. */
function OwnerForm({ me }: { me: Me }) {
  const api = useApi();
  const { reloadMe } = useAuth();
  // Owners from sign-up have only full_name: first word = given names, rest = family names.
  const [given, setGiven] = useState(me.user.given_names ?? me.user.full_name.split(" ")[0] ?? "");
  const [family, setFamily] = useState(me.user.family_names ?? me.user.full_name.split(" ").slice(1).join(" "));
  const [username, setUsername] = useState(me.user.username ?? "");
  const [email, setEmail] = useState(me.user.email ?? "");
  const [password, setPassword] = useState("");
  const [current, setCurrent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const titleId = useId();

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setDone(false);
    const body: Record<string, string> = {};
    if (`${given.trim()} ${family.trim()}` !== me.user.full_name) {
      if (!given.trim() || !family.trim()) return setError("Escribe tus nombres y tus apellidos.");
      body.given_names = given.trim();
      body.family_names = family.trim();
    }
    const access = username !== (me.user.username ?? "") || email.trim() !== (me.user.email ?? "") || Boolean(password);
    if (username !== (me.user.username ?? "")) body.username = username;
    if (email.trim() !== (me.user.email ?? "")) body.email = email.trim();
    if (password) body.password = password;
    if (!Object.keys(body).length) return setError("No hay cambios para guardar.");
    if (body.username !== undefined && !/^[a-z0-9.]{3,30}$/.test(username)) return setError("El usuario lleva minúsculas, números y punto (de 3 a 30).");
    if (password && password.length < 8) return setError("La contraseña nueva debe tener al menos 8 caracteres.");
    if (access && !current) return setError("Escribe tu contraseña actual para confirmar el cambio de usuario, correo o contraseña.");
    setBusy(true);
    setError(null);
    try {
      await api("/me", "PATCH", access ? { ...body, current_password: current } : body);
      setPassword("");
      setCurrent("");
      setDone(true);
      await reloadMe();
    } catch (err) {
      setError(errorMessage(err));
    }
    setBusy(false);
  };

  return (
    <form onSubmit={submit} noValidate className={panel} aria-labelledby={titleId}>
      <h2 id={titleId} className="text-[15px] font-semibold">
        Tus datos
      </h2>
      <p className="mt-0.5 text-sm text-muted text-pretty">Solo tú entras con correo y contraseña, desde cualquier dispositivo.</p>
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className={labelClass}>Nombres</span>
          <input value={given} onChange={(e) => setGiven(e.target.value)} maxLength={80} autoComplete="given-name" className={field} />
        </label>
        <label className="block">
          <span className={labelClass}>Apellidos</span>
          <input value={family} onChange={(e) => setFamily(e.target.value)} maxLength={80} autoComplete="family-name" className={field} />
        </label>
        <label className="block">
          <span className={labelClass}>Usuario</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/\s/g, ""))}
            maxLength={30}
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            placeholder="usuario.ejemplo"
            className={`${field} font-mono`}
          />
          <span className={hintClass}>Para entrar con PIN.</span>
        </label>
        <label className="block">
          <span className={labelClass}>Correo</span>
          <input
            type="email"
            inputMode="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            maxLength={150}
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            className={field}
          />
        </label>
        <label className="block">
          <span className={labelClass}>Contraseña nueva</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            maxLength={200}
            autoComplete="new-password"
            placeholder="Déjala vacía para no cambiarla"
            className={field}
          />
        </label>
        <label className="block">
          <span className={labelClass}>Contraseña actual</span>
          <input
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            maxLength={200}
            autoComplete="current-password"
            className={field}
          />
          <span className={hintClass}>Solo para cambiar usuario, correo o contraseña.</span>
        </label>
      </div>
      {error && (
        <div className="mt-4">
          <FormAlert>{error}</FormAlert>
        </div>
      )}
      <div className="mt-5 flex flex-wrap items-center justify-end gap-4 border-t border-line pt-5">
        {done && <Saved>Cambios guardados</Saved>}
        <button type="submit" disabled={busy} className={button.primary}>
          {busy && spinner}
          Guardar
        </button>
      </div>
    </form>
  );
}
