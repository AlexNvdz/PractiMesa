"use client";

import { ChevronRight, LoaderCircle, Plus, Search } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { RowSkeleton } from "@/components/skeleton";
import { Dialog } from "@/components/dialog";
import { FormAlert } from "@/components/form-alert";
import { button, choice, field, seg, segItem, tag } from "@/components/ui";
import { errorMessage, useApi } from "@/lib/api";
import { type Me, ROLE_LABEL, type Role } from "@/lib/auth";
import { fold } from "@/lib/format";

interface User {
  id: string;
  given_names: string | null;
  family_names: string | null;
  full_name: string;
  username: string | null;
  email: string | null;
  role: Role;
  allowed_location_ids: string[];
  is_active: boolean;
  has_pin: boolean;
}

/** Roles the owner assigns; everyone but the owner signs in with username + PIN. */
const STAFF: Role[] = ["ADMIN", "CASHIER", "WAITER", "KITCHEN"];
const labelClass = "mb-1.5 block text-sm font-medium text-ink-2";
const hintClass = "mt-1.5 block text-sm text-muted text-pretty";
const GROUPS: { role: Role; label: string }[] = [
  { role: "OWNER", label: "Dueño" },
  { role: "ADMIN", label: "Supervisores" },
  { role: "CASHIER", label: "Cajeros" },
  { role: "WAITER", label: "Meseros" },
  { role: "KITCHEN", label: "Cocina" },
];
/** Avatar colour says the role at a glance (initials stay for people who cannot tell colours apart). */
const AVATAR: Record<Role, string> = {
  OWNER: "bg-ready text-ready-ink",
  ADMIN: "bg-accent text-white",
  CASHIER: "bg-success-soft text-success",
  WAITER: "bg-accent-soft text-accent",
  KITCHEN: "bg-reserved-soft text-reserved",
};
const initials = (name: string) =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

/** First given name + first family name, lowercase, no accents ("Ana María" + "Pérez Gómez" → ana.perez), Q30. */
function suggestUsername(given: string, family: string, taken: Set<string>) {
  const first = (s: string) => fold(s.trim().split(/\s+/)[0] ?? "").replace(/[^a-z0-9]/g, "");
  const base = [first(given), first(family)].filter(Boolean).join(".").slice(0, 28);
  if (base.length < 3) return base;
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}${i}`;
  return name;
}

/**
 * Team (owner only): people of the selected location (MULTI: those assigned there or to every location),
 * with the owner first; the owner edits itself in Mi cuenta.
 */
export function Team({ me }: { me: Me }) {
  const api = useApi();
  const [users, setUsers] = useState<User[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<User | "new" | null>(null);
  const [sede, setSede] = useState<string | null>(null);
  const [text, setText] = useState("");
  const multi = me.organization.plan_tier === "MULTI";
  const locationName = new Map(me.locations.map((l) => [l.id, l.name]));

  useEffect(() => {
    api<User[]>("/users").then(setUsers, (err) => setError(errorMessage(err)));
  }, [api]);

  if (!users) {
    return error ? (
      <p role="alert" className="pm-card px-5 py-10 text-center text-[15px] text-danger">
        {error}
      </p>
    ) : (
      <RowSkeleton label="Cargando equipo…" />
    );
  }

  const user = editing === "new" ? undefined : (editing ?? undefined);
  // MULTI starts on the location being viewed; "Todas" shows everyone.
  const here = sede === null ? me.current_location_id : sede || null;
  const shown = users.filter(
    (u) =>
      (!multi || !here || u.role === "OWNER" || !u.allowed_location_ids.length || u.allowed_location_ids.includes(here)) &&
      (!text || fold(`${u.full_name} ${u.username ?? ""}`).includes(fold(text))),
  );
  const where = (u: User) =>
    u.allowed_location_ids.length ? u.allowed_location_ids.map((id) => locationName.get(id) ?? "Otra sede") : ["Todas las sedes"];

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2.5">
        <label className="relative min-w-0 max-w-[420px] flex-[1_1_260px] max-sm:max-w-none">
          <Search size={16} aria-hidden className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-muted" />
          <span className="sr-only">Buscar persona</span>
          <input
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value.trimStart())}
            placeholder="Buscar por nombre o usuario"
            autoComplete="off"
            className={`${field} h-11 pl-10`}
          />
        </label>
        {multi && (
          <fieldset className={`${seg} max-sm:order-3 max-sm:w-full`}>
            <legend className="sr-only">Sede</legend>
            {[{ id: "", name: "Todas" }, ...me.locations].map((l) => (
              <label key={l.id} className={`${segItem} max-sm:flex-1`}>
                <input type="radio" name="sede" checked={(here ?? "") === l.id} onChange={() => setSede(l.id)} className="sr-only" />
                {l.name}
              </label>
            ))}
          </fieldset>
        )}
        <button type="button" onClick={() => setEditing("new")} className={`${button.primary} ml-auto h-11 pl-3.5`}>
          <Plus size={16} strokeWidth={2.25} aria-hidden />
          Persona
        </button>
      </div>

      <div className="pm-card">
        {GROUPS.map(({ role, label }) => {
          const rows = shown.filter((u) => u.role === role);
          if (!rows.length) return null;
          return (
            <section key={role} aria-label={label}>
              <h2 className="flex gap-2 px-[18px] pt-3.5 pb-1.5 text-[13px] font-bold text-muted">
                {label} <span className="figures">{rows.length}</span>
              </h2>
              <ul className="divide-y divide-line">
                {rows.map((u) => {
                  const dim = u.is_active ? "" : "opacity-55";
                  const content = (
                    <>
                      <span className={`grid size-10 shrink-0 place-items-center rounded-full text-[13px] font-extrabold ${AVATAR[u.role]} ${dim}`}>
                        {initials(u.full_name)}
                      </span>
                      <span className="min-w-0 flex-1 min-[900px]:flex-[1.2]">
                        <span className={`block truncate font-[650] ${dim}`}>
                          {u.full_name}
                          {u.id === me.user.id && <span className="font-normal text-muted"> (tú)</span>}
                        </span>
                        <span className="block truncate font-mono text-[12.5px] text-muted">{u.username ? `@${u.username}` : u.email}</span>
                      </span>
                      <span className="hidden min-w-0 flex-1 flex-wrap gap-1.5 min-[900px]:flex">
                        {multi &&
                          where(u).map((w) => (
                            <span key={w} className={tag.mute}>
                              {w}
                            </span>
                          ))}
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        {!u.is_active && <span className={tag.mute}>Inactivo</span>}
                        {u.is_active && u.role !== "OWNER" && !u.has_pin && <span className={tag.low}>Sin PIN</span>}
                        {u.role === "OWNER" && <span className="text-sm text-muted">Mi cuenta</span>}
                        <ChevronRight size={16} aria-hidden className="text-muted" />
                      </span>
                    </>
                  );
                  const row =
                    "flex min-h-16 w-full items-center gap-4 px-3.5 py-3 text-left transition-[background-color] duration-150 hover:bg-[#f7f8f5] sm:px-[18px]";
                  return (
                    <li key={u.id}>
                      {u.role === "OWNER" ? (
                        // The owner's own data lives in Mi cuenta, not in this form.
                        <Link href="/mi-cuenta" className={row}>
                          {content}
                        </Link>
                      ) : (
                        <button type="button" onClick={() => setEditing(u)} className={row}>
                          {content}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
        {!shown.length && (
          <p className="px-6 py-12 text-center text-muted">
            <b className="mb-1 block text-base text-ink-2">Nadie con ese nombre</b>
            Revisa la búsqueda o cambia de sede.
          </p>
        )}
      </div>

      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={user ? user.full_name : "Nuevo usuario"} wide>
        <UserForm
          key={user?.id ?? "new"}
          me={me}
          user={user}
          taken={new Set(users.filter((u) => u.id !== user?.id && u.username).map((u) => u.username!))}
          onSaved={(saved) => {
            setUsers(user ? users.map((u) => (u.id === saved.id ? saved : u)) : [...users, saved]);
            setEditing(null);
          }}
        />
      </Dialog>
    </div>
  );
}

function UserForm({ me, user, taken, onSaved }: { me: Me; user?: User; taken: Set<string>; onSaved: (user: User) => void }) {
  const api = useApi();
  const multi = me.organization.plan_tier === "MULTI";
  // Users from before names were split (sign-up owner, demo users): first word = given names, rest = family names.
  const [given, setGiven] = useState(user?.given_names ?? user?.full_name.split(" ")[0] ?? "");
  const [family, setFamily] = useState(user?.family_names ?? user?.full_name.split(" ").slice(1).join(" ") ?? "");
  const [username, setUsername] = useState(user?.username ?? "");
  // The username follows the names until the person edits it (Q30).
  const [usernameTouched, setUsernameTouched] = useState(Boolean(user?.username));
  const [role, setRole] = useState<Role>(user?.role ?? "CASHIER");
  // A new person starts at the location being viewed (MULTI); "Todas las sedes" stays one click away.
  const [locations, setLocations] = useState<string[]>(
    user?.allowed_location_ids ?? (multi && me.current_location_id ? [me.current_location_id] : []),
  );
  const [pin, setPin] = useState("");
  const [active, setActive] = useState(user?.is_active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shownUsername = usernameTouched ? username : suggestUsername(given, family, taken);
  const allLocations = locations.length === 0;

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!given.trim() || !family.trim()) return setError("Escribe los nombres y los apellidos.");
    if (!/^[a-z0-9.]{3,30}$/.test(shownUsername)) return setError("El usuario lleva minúsculas, números y punto (de 3 a 30).");
    if (pin && !/^\d{4,6}$/.test(pin)) return setError("El PIN tiene de 4 a 6 dígitos.");
    if (!user && !pin) return setError("Asigna un PIN: con él entra a trabajar.");
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        given_names: given.trim(),
        family_names: family.trim(),
        username: shownUsername,
      };
      body.role = role;
      if (multi) body.location_ids = locations;
      if (user && active !== user.is_active) body.is_active = active;
      let saved: User;
      if (user) {
        saved = await api<User>(`/users/${user.id}`, "PATCH", body);
        if (pin) {
          await api(`/users/${user.id}/pin`, "PUT", { pin });
          saved = { ...saved, has_pin: true };
        }
      } else {
        saved = await api<User>("/users", "POST", {
          ...body,
          ...(pin ? { pin } : {}),
        });
      }
      onSaved(saved);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const toggleLocation = (id: string) => setLocations((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id]));

  return (
    <form onSubmit={save} noValidate className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className={labelClass}>Nombres</span>
          <input
            value={given}
            onChange={(e) => setGiven(e.target.value)}
            maxLength={80}
            autoComplete="off"
            placeholder="Nombres"
            className={field}
          />
        </label>
        <label className="block">
          <span className={labelClass}>Apellidos</span>
          <input
            value={family}
            onChange={(e) => setFamily(e.target.value)}
            maxLength={80}
            autoComplete="off"
            placeholder="Apellidos"
            className={field}
          />
        </label>
        <label className="block sm:col-span-2">
          <span className={labelClass}>Usuario</span>
          <input
            value={shownUsername}
            onChange={(e) => {
              setUsernameTouched(true);
              setUsername(e.target.value.toLowerCase().replace(/\s/g, ""));
            }}
            maxLength={30}
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            className={`${field} font-mono`}
          />
          <span className={hintClass}>Minúsculas, números y punto. Con este usuario y su PIN entra a trabajar.</span>
        </label>
      </div>

      <fieldset>
        <legend className={labelClass}>Rol</legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {STAFF.map((r) => (
            <label key={r} className={choice}>
              <input type="radio" name="role" checked={role === r} onChange={() => setRole(r)} className="sr-only" />
              {ROLE_LABEL[r]}
            </label>
          ))}
        </div>
      </fieldset>

      {multi && (
        <fieldset>
          <legend className={labelClass}>Sedes donde trabaja</legend>
          <div className="space-y-1">
            <label className="flex min-h-11 items-center gap-3 text-[15px]">
              <input
                type="checkbox"
                checked={allLocations}
                onChange={() => setLocations(allLocations ? [me.locations[0].id] : [])}
                className="size-5 accent-accent"
              />
              Todas las sedes
              <span className="text-sm text-muted">(también las que abras después)</span>
            </label>
            {!allLocations &&
              me.locations.map((l) => (
                <label key={l.id} className="flex min-h-11 items-center gap-3 text-[15px]">
                  <input
                    type="checkbox"
                    checked={locations.includes(l.id)}
                    onChange={() => toggleLocation(l.id)}
                    className="size-5 accent-accent"
                  />
                  {l.name}
                  <span className="text-sm text-muted">{l.city}</span>
                </label>
              ))}
          </div>
        </fieldset>
      )}

      <label className="block">
        <span className={labelClass}>{user?.has_pin ? "Cambiar PIN" : "PIN"}</span>
        <input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
          placeholder={user?.has_pin ? "Sin cambios" : "4 a 6 dígitos"}
          className={`${field} figures sm:max-w-56`}
        />
        <span className={hintClass}>Varias personas pueden tener el mismo PIN: lo que las distingue es el usuario.</span>
      </label>

      {user && (
        <label className="flex min-h-11 items-center gap-3 text-[15px]">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="size-5 accent-accent" />
          Usuario activo
          <span className="text-sm text-muted">(inactivo: no puede entrar; su historial se conserva)</span>
        </label>
      )}

      {error && <FormAlert>{error}</FormAlert>}

      <div className="flex justify-end border-t border-line pt-5">
        <button type="submit" disabled={busy} className={button.primary}>
          {busy && <LoaderCircle size={18} className="animate-spin motion-reduce:[animation-duration:6s]" aria-hidden />}
          {user ? "Guardar" : "Crear usuario"}
        </button>
      </div>
    </form>
  );
}
