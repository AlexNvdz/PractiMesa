"use client";

import { LoaderCircle, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { Dialog } from "@/components/dialog";
import { FormAlert } from "@/components/form-alert";
import { button, choice, field } from "@/components/ui";
import { errorMessage, useApi } from "@/lib/api";
import { type Me, ROLE_LABEL, type Role, useAuth } from "@/lib/auth";
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
  /** Whether the signed-in user may edit this one (Q42), decided by the API. */
  can_manage: boolean;
}

const WORKERS: Role[] = ["CASHIER", "WAITER", "KITCHEN"];
const labelClass = "mb-1.5 block text-sm font-medium text-ink-2";
const hintClass = "mt-1.5 block text-sm text-muted text-pretty";
const badge = "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium";

/** First given name + first family name, lowercase, no accents ("Alex Andrés" + "Navarro Díaz" → alex.navarro), Q30. */
function suggestUsername(given: string, family: string, taken: Set<string>) {
  const first = (s: string) => fold(s.trim().split(/\s+/)[0] ?? "").replace(/[^a-z0-9]/g, "");
  const base = [first(given), first(family)].filter(Boolean).join(".").slice(0, 28);
  if (base.length < 3) return base;
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}${i}`;
  return name;
}

/** Team (Q30–Q31, Q42): people of the business, their role, locations and PIN. */
export function Team({ me }: { me: Me }) {
  const api = useApi();
  const { reloadMe } = useAuth();
  const [users, setUsers] = useState<User[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<User | "new" | null>(null);
  const multi = me.organization.plan_tier === "MULTI";
  const locationName = new Map(me.locations.map((l) => [l.id, l.name]));

  useEffect(() => {
    api<User[]>("/users").then(setUsers, (err) => setError(errorMessage(err)));
  }, [api]);

  if (!users) {
    return error ? (
      <p role="alert" className="rounded-panel border border-line bg-surface px-5 py-10 text-center text-[15px] text-danger">
        {error}
      </p>
    ) : (
      <p role="status" className="py-10 text-center text-[15px] text-muted">
        Cargando equipo…
      </p>
    );
  }

  const user = editing === "new" ? undefined : (editing ?? undefined);
  const where = (u: User) =>
    u.allowed_location_ids.length ? u.allowed_location_ids.map((id) => locationName.get(id) ?? "Otra sede").join(", ") : "Todas las sedes";

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <p className="figures text-sm text-muted">
          {users.filter((u) => u.is_active).length} {users.filter((u) => u.is_active).length === 1 ? "persona activa" : "personas activas"}
        </p>
        <button type="button" onClick={() => setEditing("new")} className={`${button.primary} ml-auto pl-3.5`}>
          <Plus size={18} strokeWidth={2.25} aria-hidden />
          Nuevo usuario
        </button>
      </div>

      <ul className="divide-y divide-line rounded-panel border border-line bg-surface">
        {users.map((u) => {
          const content = (
            <>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-medium">
                  {u.full_name}
                  {u.id === me.user.id && <span className="font-normal text-muted"> (tú)</span>}
                </span>
                <span className="block truncate text-sm text-muted">
                  {ROLE_LABEL[u.role]}
                  {u.username && ` · ${u.username}`}
                  {u.email && ` · ${u.email}`}
                  {multi && ` · ${where(u)}`}
                </span>
              </span>
              {!u.is_active && <span className={`${badge} bg-ground text-muted`}>Inactivo</span>}
              {u.is_active && WORKERS.includes(u.role) && !u.has_pin && (
                <span className={`${badge} bg-warning-soft text-warning`}>Sin PIN</span>
              )}
            </>
          );
          return (
            <li key={u.id}>
              {u.can_manage ? (
                <button
                  type="button"
                  onClick={() => setEditing(u)}
                  className="flex min-h-14 w-full items-center gap-4 px-5 py-3 text-left transition-[background-color] duration-150 first:rounded-t-panel last:rounded-b-panel hover:bg-ground"
                >
                  {content}
                </button>
              ) : (
                <div className="flex min-h-14 items-center gap-4 px-5 py-3">{content}</div>
              )}
            </li>
          );
        })}
      </ul>

      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={user ? user.full_name : "Nuevo usuario"} wide>
        <UserForm
          key={user?.id ?? "new"}
          me={me}
          user={user}
          taken={new Set(users.filter((u) => u.id !== user?.id && u.username).map((u) => u.username!))}
          onSaved={(changed) => {
            // Whoever just saved a user may keep managing it.
            const saved = { ...changed, can_manage: true };
            setUsers(user ? users.map((u) => (u.id === saved.id ? saved : u)) : [...users, saved]);
            setEditing(null);
            // The header shows the signed-in user's name.
            if (saved.id === me.user.id) void reloadMe();
          }}
        />
      </Dialog>
    </div>
  );
}

function UserForm({ me, user, taken, onSaved }: { me: Me; user?: User; taken: Set<string>; onSaved: (user: User) => void }) {
  const api = useApi();
  const self = user?.id === me.user.id;
  const owner = me.user.role === "OWNER";
  const multi = me.organization.plan_tier === "MULTI";
  // Users from before names were split (sign-up owner, demo users): first word = given names, rest = family names.
  const [given, setGiven] = useState(user?.given_names ?? user?.full_name.split(" ")[0] ?? "");
  const [family, setFamily] = useState(user?.family_names ?? user?.full_name.split(" ").slice(1).join(" ") ?? "");
  const [username, setUsername] = useState(user?.username ?? "");
  // The username follows the names until the person edits it (Q30).
  const [usernameTouched, setUsernameTouched] = useState(Boolean(user?.username));
  const [role, setRole] = useState<Role>(user?.role ?? "CASHIER");
  const [locations, setLocations] = useState<string[]>(user?.allowed_location_ids ?? (owner ? [] : [me.current_location_id ?? ""]));
  const [email, setEmail] = useState(user?.email ?? "");
  const [password, setPassword] = useState("");
  const [pin, setPin] = useState("");
  const [active, setActive] = useState(user?.is_active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shownUsername = usernameTouched ? username : suggestUsername(given, family, taken);
  const isAdmin = role === "ADMIN";
  const roles: Role[] = owner ? ["ADMIN", ...WORKERS] : WORKERS;
  const fixedRole = self || user?.role === "OWNER";
  const allLocations = locations.length === 0;

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!given.trim() || !family.trim()) return setError("Escribe los nombres y los apellidos.");
    if (!/^[a-z0-9.]{3,30}$/.test(shownUsername)) return setError("El usuario lleva minúsculas, números y punto (de 3 a 30).");
    if (pin && !/^\d{4,6}$/.test(pin)) return setError("El PIN tiene de 4 a 6 dígitos.");
    if (!user && !isAdmin && !pin) return setError("Asigna un PIN: con él entra a trabajar.");
    if (multi && !self && !owner && allLocations) return setError("Elige al menos una sede.");
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { given_names: given.trim(), family_names: family.trim(), username: shownUsername };
      if (!fixedRole) body.role = role;
      if (multi && !self && user?.role !== "OWNER") body.location_ids = locations;
      if (isAdmin && owner && email.trim() !== (user?.email ?? "")) body.email = email.trim();
      if (isAdmin && owner && password) body.password = password;
      if (user && !self && active !== user.is_active) body.is_active = active;
      let saved: User;
      if (user) {
        saved = await api<User>(`/users/${user.id}`, "PATCH", body);
        if (pin) {
          await api(`/users/${user.id}/pin`, "PUT", { pin });
          saved = { ...saved, has_pin: true };
        }
      } else {
        saved = await api<User>("/users", "POST", { ...body, ...(pin ? { pin } : {}) });
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
            placeholder="Alex Andrés"
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
            placeholder="Navarro Díaz"
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

      {fixedRole ? (
        <p className="text-sm text-muted">Rol: {ROLE_LABEL[role]}</p>
      ) : (
        <fieldset>
          <legend className={labelClass}>Rol</legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {roles.map((r) => (
              <label key={r} className={choice}>
                <input type="radio" name="role" checked={role === r} onChange={() => setRole(r)} className="sr-only" />
                {ROLE_LABEL[r]}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {multi && !self && user?.role !== "OWNER" && (
        <fieldset>
          <legend className={labelClass}>Sedes donde trabaja</legend>
          <div className="space-y-1">
            {owner && (
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
            )}
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

      {isAdmin && owner && (
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className={labelClass}>Correo</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              maxLength={150}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              className={field}
            />
          </label>
          <label className="block">
            <span className={labelClass}>{user?.email ? "Nueva contraseña" : "Contraseña"}</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              maxLength={200}
              autoComplete="new-password"
              placeholder={user?.email ? "Déjala vacía para no cambiarla" : "Mínimo 8 caracteres"}
              className={field}
            />
          </label>
          <span className={`${hintClass} -mt-2 sm:col-span-2`}>
            Los administradores entran con correo y contraseña; el PIN es opcional.
          </span>
        </div>
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

      {user && !self && (
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
