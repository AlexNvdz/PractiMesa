"use client";

import { Check, LoaderCircle, Lock, Pencil, Plus, Power } from "lucide-react";
import { useEffect, useState } from "react";
import { CardSkeleton, useFirstPaint } from "@/components/skeleton";
import { Dialog } from "@/components/dialog";
import { button, field } from "@/components/ui";
import { errorMessage, useApi } from "@/lib/api";
import { type Me, useAuth } from "@/lib/auth";

interface Location {
  id: string;
  name: string;
  city: string;
  address: string;
  phone_whatsapp: string | null;
  is_active: boolean;
}

const labelClass = "mb-1.5 block text-sm font-medium text-ink-2";
const band =
  "inline-flex h-9 items-center rounded-control bg-white/70 px-3 text-[13.5px] font-semibold text-ink-2 transition-[background-color] duration-150 hover:bg-white";

/**
 * Locations of the organization (OWNER): create within the plan limit, edit, deactivate, delete one without
 * history. Inactive locations still count toward the limit (the API counts them too).
 */
export function Locations({ me }: { me: Me }) {
  const api = useApi();
  const { reloadMe, setLocation } = useAuth();
  const [locations, setLocations] = useState<Location[] | null>(null);
  const fresh = useFirstPaint(locations !== null);
  const [editing, setEditing] = useState<Location | "new" | null>(null);
  const [stats, setStats] = useState<Record<string, { tables: number; people: number; devices: number }>>({});
  const [error, setError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const limit = me.organization.plan_tier === "SINGLE" ? 1 : me.organization.max_locations;

  useEffect(() => {
    void (async () => {
      try {
        const [list, counts] = await Promise.all([api<Location[]>("/locations"), api<typeof stats>("/locations/stats")]);
        setLocations(list);
        setStats(counts);
      } catch (err) {
        setError(errorMessage(err));
      }
    })();
  }, [api]);

  if (!locations) {
    return error ? (
      <p role="alert" className="pm-card px-5 py-10 text-center text-[15px] text-danger">
        {error}
      </p>
    ) : (
      <CardSkeleton min={300} cards={2} label="Cargando sedes…" />
    );
  }

  // Activate or deactivate from the card; the API refuses to leave no active location (409).
  const toggle = async (l: Location) => {
    setRowError(null);
    try {
      const saved = await api<Location>(`/locations/${l.id}`, "PATCH", { is_active: !l.is_active });
      changed(locations.map((x) => (x.id === saved.id ? saved : x)));
    } catch (err) {
      setRowError({ id: l.id, message: errorMessage(err) });
    }
  };

  const full = locations.length >= limit;
  const location = editing === "new" ? undefined : (editing ?? undefined);
  // The header picker and the request location come from the session: refresh it after any change.
  const changed = (next: Location[]) => {
    setLocations(next);
    setEditing(null);
    void api<typeof stats>("/locations/stats").then(setStats, () => undefined);
    // Working on a location that is now inactive or gone would be refused: move to an active one first.
    const active = next.filter((l) => l.is_active);
    if (active[0] && !active.some((l) => l.id === me.current_location_id)) setLocation(active[0].id);
    void reloadMe();
  };

  return (
    <div>
      {/* Plan: one slot per location the plan allows, filled by the ones that exist. */}
      <section aria-label="Plan" className="mb-6 flex flex-wrap items-center gap-x-6 gap-y-3 pm-card px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 className="figures font-display text-[17px] font-bold tracking-[-0.01em]">
            {locations.length} de {limit} {limit === 1 ? "sede" : "sedes"} de tu plan
          </h2>
          <p className="text-sm text-muted text-pretty">
            {me.organization.plan_tier === "SINGLE" ? "Plan Pequeño. Para abrir otra sede, cambia al plan Multilocal." : "Plan Multilocal. Para más sedes, escríbenos y ampliamos tu tope."}
          </p>
        </div>
        <span className={`rounded-full px-2.5 py-0.5 text-[12.5px] font-bold ${full ? "bg-warning-soft text-warning" : "bg-success-soft text-success"}`}>
          {full ? "Tope alcanzado" : `${limit - locations.length} ${limit - locations.length === 1 ? "disponible" : "disponibles"}`}
        </span>
        <div aria-hidden className="flex w-full gap-1.5">
          {Array.from({ length: limit }, (_, i) => (
            <i
              key={i}
              className={`h-2 flex-1 rounded-full ${locations[i] ? (locations[i].is_active ? "bg-accent" : "bg-line-strong") : "border-[1.5px] border-dashed border-line-strong"}`}
            />
          ))}
        </div>
      </section>

      <ul className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3.5">
        {locations.map((l, k) => (
          <li key={l.id} style={{ "--i": k } as React.CSSProperties} className={fresh ? "enter" : undefined}>
            <article className="pm-card flex h-full min-h-[230px] flex-col overflow-hidden">
              <div className="flex-1 px-5 pt-5 pb-3.5">
                <h3 className={`font-display text-2xl font-[750] tracking-[-0.02em] ${l.is_active ? "" : "text-muted"}`}>{l.name}</h3>
                <address className="mt-1 text-sm text-muted not-italic">
                  {l.address} · {l.city}
                </address>
                {l.phone_whatsapp && <p className="figures mt-0.5 text-sm text-muted">WhatsApp {l.phone_whatsapp}</p>}
                <dl className="mt-4 grid grid-cols-3 gap-2">
                  {[
                    ["mesas", stats[l.id]?.tables],
                    ["personas", stats[l.id]?.people],
                    ["dispositivos", stats[l.id]?.devices],
                  ].map(([label, n]) => (
                    <div key={label} className="rounded-xl bg-ground px-3 py-2.5">
                      <dd className={`figures font-display text-[22px] font-bold ${l.is_active ? "" : "text-muted"}`}>{n ?? "–"}</dd>
                      <dt className="text-[12.5px] text-muted">{label}</dt>
                    </div>
                  ))}
                </dl>
                {rowError?.id === l.id && (
                  <p role="alert" className="mt-3 text-sm text-danger">
                    {rowError.message}
                  </p>
                )}
              </div>
              {/* Base band, like the tables: the state in words, with the actions at its end. */}
              <div className={`flex h-[52px] shrink-0 items-center gap-2 pr-3 pl-5 text-sm font-bold ${l.is_active ? "bg-success-soft text-success" : "bg-[#eceee9] text-ink-2"}`}>
                {l.is_active ? <Check size={16} strokeWidth={2.5} aria-hidden /> : <Power size={16} strokeWidth={2.5} aria-hidden />}
                {l.is_active ? "Activa" : "Inactiva"}
                <span className="ml-auto flex gap-1">
                  <button type="button" onClick={() => setEditing(l)} className={`${band} gap-1.5`}>
                    <Pencil size={14} aria-hidden />
                    Editar
                  </button>
                  <button type="button" onClick={() => void toggle(l)} className={band}>
                    {l.is_active ? "Desactivar" : "Activar"}
                  </button>
                </span>
              </div>
            </article>
          </li>
        ))}
        <li style={{ "--i": locations.length } as React.CSSProperties} className={fresh ? "enter" : undefined}>
          <button
            type="button"
            disabled={full}
            onClick={() => setEditing("new")}
            className="flex h-full min-h-[230px] w-full flex-col items-center justify-center gap-1.5 rounded-panel border-[1.5px] border-dashed border-line-strong px-6 text-center font-semibold text-ink-2 transition-[border-color,background-color] duration-150 hover:enabled:border-muted hover:enabled:bg-surface disabled:cursor-not-allowed disabled:text-muted"
          >
            {full ? <Lock size={22} aria-hidden /> : <Plus size={22} aria-hidden />}
            {full ? "Llegaste al tope de tu plan" : "Agregar sede"}
            <small className="text-[13px] font-normal text-muted text-pretty">
              {full ? "Desactivar una sede no libera cupo." : "Nombre, ciudad y dirección. Las mesas se crean después."}
            </small>
          </button>
        </li>
      </ul>

      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={location ? location.name : "Nueva sede"}>
        <LocationForm
          key={location?.id ?? "new"}
          location={location}
          onSaved={(saved) => changed(location ? locations.map((l) => (l.id === saved.id ? saved : l)) : [...locations, saved])}
          onDeleted={(id) => changed(locations.filter((l) => l.id !== id))}
        />
      </Dialog>
    </div>
  );
}

function LocationForm({
  location,
  onSaved,
  onDeleted,
}: {
  location?: Location;
  onSaved: (location: Location) => void;
  onDeleted: (id: string) => void;
}) {
  const api = useApi();
  const [name, setName] = useState(location?.name ?? "");
  const [city, setCity] = useState(location?.city ?? "");
  const [address, setAddress] = useState(location?.address ?? "");
  const [phone, setPhone] = useState(location?.phone_whatsapp ?? "");
  const [active, setActive] = useState(location?.is_active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !city.trim() || !address.trim()) return setError("Escribe el nombre, la ciudad y la dirección de la sede.");
    setBusy(true);
    setError(null);
    try {
      const body = { name: name.trim(), city: city.trim(), address: address.trim(), phone_whatsapp: phone.trim() || null, is_active: active };
      onSaved(await (location ? api<Location>(`/locations/${location.id}`, "PATCH", body) : api<Location>("/locations", "POST", body)));
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/locations/${location!.id}`, "DELETE");
      onDeleted(location!.id);
    } catch (err) {
      // The API explains why (sales or cash registers, or the last location) in Spanish.
      setError(errorMessage(err));
      setConfirmDelete(false);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} noValidate className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block sm:col-span-2">
          <span className={labelClass}>Nombre</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required placeholder="Sede Norte" className={field} />
        </label>
        <label className="block">
          <span className={labelClass}>Ciudad</span>
          <input value={city} onChange={(e) => setCity(e.target.value)} maxLength={80} required placeholder="Bogotá" className={field} />
        </label>
        <label className="block">
          <span className={labelClass}>WhatsApp</span>
          <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={30} placeholder="Opcional" className={`${field} figures`} />
        </label>
        <label className="block sm:col-span-2">
          <span className={labelClass}>Dirección</span>
          <input value={address} onChange={(e) => setAddress(e.target.value)} maxLength={300} required placeholder="Cra. 15 #93-60" className={field} />
        </label>
        {location && (
          <label className="flex min-h-11 items-center gap-3 text-[15px] sm:col-span-2">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="size-5 accent-accent" />
            Sede activa
            <span className="text-sm text-muted">(inactiva: nadie trabaja en ella, pero cuenta para tu plan)</span>
          </label>
        )}
      </div>

      {error && (
        <p role="alert" className="rounded-control bg-danger-soft px-3 py-2.5 text-sm text-danger">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-5">
        {location &&
          (confirmDelete ? (
            <>
              <span className="w-full text-sm text-ink-2">Solo se puede eliminar una sede sin ventas ni cajas. Si ya vendió, desactívala.</span>
              <button type="button" disabled={busy} onClick={() => void remove()} className={button.danger}>
                Eliminar {location.name}
              </button>
              <button type="button" onClick={() => setConfirmDelete(false)} className={button.ghost}>
                No
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setConfirmDelete(true)} className={`${button.quietDanger} -ml-3`}>
              Eliminar sede
            </button>
          ))}
        <button type="submit" disabled={busy} className={`${button.primary} ml-auto`}>
          {busy && <LoaderCircle size={18} className="animate-spin motion-reduce:[animation-duration:6s]" aria-hidden />}
          {location ? "Guardar" : "Crear sede"}
        </button>
      </div>
    </form>
  );
}
