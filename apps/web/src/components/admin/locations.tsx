"use client";

import { LoaderCircle, Plus } from "lucide-react";
import { useEffect, useState } from "react";
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

/**
 * Locations of the organization (OWNER): create within the plan limit, edit, deactivate, delete one without
 * history. Inactive locations still count toward the limit (the API counts them too).
 */
export function Locations({ me }: { me: Me }) {
  const api = useApi();
  const { reloadMe, setLocation } = useAuth();
  const [locations, setLocations] = useState<Location[] | null>(null);
  const [editing, setEditing] = useState<Location | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const limit = me.organization.plan_tier === "SINGLE" ? 1 : me.organization.max_locations;

  useEffect(() => {
    void (async () => {
      try {
        setLocations(await api<Location[]>("/locations"));
      } catch (err) {
        setError(errorMessage(err));
      }
    })();
  }, [api]);

  if (!locations) {
    return error ? (
      <p role="alert" className="rounded-panel border border-line bg-surface px-5 py-10 text-center text-[15px] text-danger">
        {error}
      </p>
    ) : (
      <p role="status" className="py-10 text-center text-[15px] text-muted">
        Cargando sedes…
      </p>
    );
  }

  const full = locations.length >= limit;
  const location = editing === "new" ? undefined : (editing ?? undefined);
  // The header picker and the request location come from the session: refresh it after any change.
  const changed = (next: Location[]) => {
    setLocations(next);
    setEditing(null);
    // Working on a location that is now inactive or gone would be refused: move to an active one first.
    const active = next.filter((l) => l.is_active);
    if (active[0] && !active.some((l) => l.id === me.current_location_id)) setLocation(active[0].id);
    void reloadMe();
  };

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <p className="figures text-sm text-muted">
          {locations.length} de {limit} {limit === 1 ? "sede" : "sedes"} de tu plan
          {full && (me.organization.plan_tier === "SINGLE" ? " · Para abrir otra sede, cambia al plan Multilocal." : " · Llegaste al tope de tu plan.")}
        </p>
        <button type="button" disabled={full} onClick={() => setEditing("new")} className={`${button.primary} ml-auto pl-3.5`}>
          <Plus size={18} strokeWidth={2.25} aria-hidden />
          Nueva sede
        </button>
      </div>

      <ul className="divide-y divide-line rounded-panel border border-line bg-surface">
        {locations.map((l) => (
          <li key={l.id}>
            <button
              type="button"
              onClick={() => setEditing(l)}
              className="flex min-h-14 w-full items-center gap-4 px-5 py-3 text-left transition-[background-color] duration-150 first:rounded-t-panel last:rounded-b-panel hover:bg-ground"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-medium">{l.name}</span>
                <span className="block truncate text-sm text-muted">
                  {l.address} · {l.city}
                  {l.phone_whatsapp && ` · ${l.phone_whatsapp}`}
                </span>
              </span>
              {!l.is_active && <span className="rounded-full bg-ground px-2 py-0.5 text-xs font-medium text-muted">Inactiva</span>}
            </button>
          </li>
        ))}
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
