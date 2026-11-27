"use client";

import { ArrowLeft, Check, Layers, LoaderCircle, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Dialog } from "@/components/dialog";
import { button, field } from "@/components/ui";
import { errorMessage, useApi } from "@/lib/api";
import { ApiError, type Me } from "@/lib/auth";
import type { DiningTable, Floor } from "@/lib/pos";

const labelClass = "mb-1.5 block text-sm font-medium text-ink-2";
const byNumber = (a: DiningTable, b: DiningTable) => a.number - b.number;

/** The API's 409 said the way the owner fixes it. */
const conflict = (err: unknown, message: string) => (err instanceof ApiError && err.status === 409 ? message : errorMessage(err));

/** Zone picker shared by the table and "add tables" forms. */
function ZoneSelect({ floors, value, onChange }: { floors: Floor[]; value: string; onChange: (value: string) => void }) {
  return (
    <label className="block">
      <span className={labelClass}>Zona</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={field}>
        <option value="">Sin zona</option>
        {floors.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Tables and zones of the current location (OWNER/ADMIN): add several tables at once, edit number, name,
 * seats and zone, delete tables without history, and manage zones.
 */
export function TablesEditor({ me }: { me: Me }) {
  const api = useApi();
  const [tables, setTables] = useState<DiningTable[] | null>(null);
  const [floors, setFloors] = useState<Floor[]>([]);
  const [editing, setEditing] = useState<DiningTable | null>(null);
  const [adding, setAdding] = useState(false);
  const [managing, setManaging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locationName = me.locations.find((l) => l.id === me.current_location_id)?.name ?? "esta sede";

  // The page remounts this screen when the location changes, so it loads once per location.
  useEffect(() => {
    void (async () => {
      try {
        const [t, f] = await Promise.all([api<DiningTable[]>("/tables"), api<Floor[]>("/floors")]);
        setTables(t);
        setFloors(f);
      } catch (err) {
        setError(errorMessage(err));
      }
    })();
  }, [api]);

  if (!tables) {
    return error ? (
      <p role="alert" className="pm-card px-5 py-10 text-center text-[15px] text-danger">
        {error}
      </p>
    ) : (
      <p role="status" className="py-10 text-center text-[15px] text-muted">
        Cargando mesas…
      </p>
    );
  }

  const groups = [
    ...floors.map((f) => ({ id: f.id, name: f.name, tables: tables.filter((t) => t.floor_id === f.id) })),
    { id: "none", name: "Sin zona", tables: tables.filter((t) => !t.floor_id || !floors.some((f) => f.id === t.floor_id)) },
  ].filter((g) => g.tables.length);

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Link href="/mesas" className={`${button.ghost} -ml-3 pl-2.5`}>
          <ArrowLeft size={18} strokeWidth={2.25} aria-hidden />
          Volver a Mesas
        </Link>
        <button type="button" onClick={() => setManaging(true)} className={`${button.secondary} ml-auto pl-3.5`}>
          <Layers size={18} strokeWidth={2.25} aria-hidden />
          Zonas
        </button>
        <button type="button" onClick={() => setAdding(true)} className={`${button.primary} pl-3.5`}>
          <Plus size={18} strokeWidth={2.25} aria-hidden />
          Agregar mesas
        </button>
      </div>

      {!tables.length && (
        <p className="pm-card px-5 py-10 text-center text-[15px] text-muted">
          {locationName} todavía no tiene mesas. Crea varias de una vez con &ldquo;Agregar mesas&rdquo;.
        </p>
      )}

      {groups.map((g) => (
        <section key={g.id} aria-labelledby={`zone-${g.id}`} className="mb-8">
          <h2 id={`zone-${g.id}`} className="mb-3 flex items-baseline gap-2 text-sm font-semibold text-ink-2">
            {groups.length > 1 || floors.length ? g.name : `Mesas de ${locationName}`}
            <span className="figures font-normal text-muted">{g.tables.length}</span>
          </h2>
          <ul className="divide-y divide-line pm-card">
            {g.tables.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => setEditing(t)}
                  className="flex min-h-14 w-full items-center gap-4 px-5 py-3 text-left transition-[background-color] duration-150 first:rounded-t-panel last:rounded-b-panel hover:bg-ground"
                >
                  <span className="figures w-10 shrink-0 text-sm text-muted">#{t.number}</span>
                  <span className="min-w-0 flex-1 truncate text-[15px] font-medium">{t.name}</span>
                  <span className="figures text-sm text-muted">{t.capacity} puestos</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}

      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={editing?.name ?? ""}>
        {editing && (
          <TableForm
            key={editing.id}
            table={editing}
            floors={floors}
            onSaved={(saved) => {
              setTables((all) => all!.map((t) => (t.id === saved.id ? saved : t)).sort(byNumber));
              setEditing(null);
            }}
            onDeleted={(id) => {
              setTables((all) => all!.filter((t) => t.id !== id));
              setEditing(null);
            }}
          />
        )}
      </Dialog>

      <Dialog open={adding} onClose={() => setAdding(false)} title="Agregar mesas">
        <AddTablesForm
          floors={floors}
          next={Math.max(0, ...tables.map((t) => t.number)) + 1}
          onSaved={(created) => {
            setTables((all) => [...all!, ...created].sort(byNumber));
            setAdding(false);
          }}
        />
      </Dialog>

      <Dialog open={managing} onClose={() => setManaging(false)} title="Zonas">
        <Zones floors={floors} onChange={setFloors} />
      </Dialog>
    </div>
  );
}

/** Edit one table. Only changed fields are sent, so a default name ("Mesa #3") follows a new number. */
function TableForm({
  table,
  floors,
  onSaved,
  onDeleted,
}: {
  table: DiningTable;
  floors: Floor[];
  onSaved: (table: DiningTable) => void;
  onDeleted: (id: string) => void;
}) {
  const api = useApi();
  const [name, setName] = useState(table.name);
  const [number, setNumber] = useState(String(table.number));
  const [capacity, setCapacity] = useState(String(table.capacity));
  const [floorId, setFloorId] = useState(table.floor_id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const n = Number(number);
    const seats = Number(capacity);
    if (!name.trim()) return setError("Escribe el nombre de la mesa.");
    if (!Number.isInteger(n) || n < 1 || n > 9999) return setError("El número va de 1 a 9999.");
    if (!Number.isInteger(seats) || seats < 1 || seats > 99) return setError("Los puestos van de 1 a 99.");
    const changes = {
      ...(name.trim() !== table.name && { name: name.trim() }),
      ...(n !== table.number && { number: n }),
      ...(seats !== table.capacity && { capacity: seats }),
      ...(floorId !== (table.floor_id ?? "") && { floor_id: floorId || null }),
    };
    if (!Object.keys(changes).length) return onSaved(table);
    setBusy(true);
    setError(null);
    try {
      onSaved(await api<DiningTable>(`/tables/${table.id}`, "PATCH", changes));
    } catch (err) {
      setError(conflict(err, "Ya hay otra mesa con ese número o ese nombre en esta sede."));
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/tables/${table.id}`, "DELETE");
      onDeleted(table.id);
    } catch (err) {
      setError(conflict(err, "Esta mesa ya tiene pedidos o reservas y no se puede eliminar."));
      setConfirmDelete(false);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} noValidate className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block sm:col-span-2">
          <span className={labelClass}>Nombre</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required className={field} />
        </label>
        <label className="block">
          <span className={labelClass}>Número</span>
          <input inputMode="numeric" value={number} onChange={(e) => setNumber(e.target.value.replace(/\D/g, ""))} className={`${field} figures`} />
        </label>
        <label className="block">
          <span className={labelClass}>Puestos</span>
          <input inputMode="numeric" value={capacity} onChange={(e) => setCapacity(e.target.value.replace(/\D/g, ""))} className={`${field} figures`} />
        </label>
        <div className="sm:col-span-2">
          <ZoneSelect floors={floors} value={floorId} onChange={setFloorId} />
        </div>
      </div>
      <p className="text-sm text-muted">Si el nombre es &ldquo;Mesa #n&rdquo; y cambias el número, el nombre cambia con él.</p>

      {error && (
        <p role="alert" className="rounded-control bg-danger-soft px-3 py-2.5 text-sm text-danger">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-5">
        {confirmDelete ? (
          <>
            <button type="button" disabled={busy} onClick={() => void remove()} className={button.danger}>
              Eliminar {table.name}
            </button>
            <button type="button" onClick={() => setConfirmDelete(false)} className={button.ghost}>
              No
            </button>
          </>
        ) : (
          <button type="button" onClick={() => setConfirmDelete(true)} className={`${button.quietDanger} -ml-3`}>
            Eliminar mesa
          </button>
        )}
        <button type="submit" disabled={busy} className={`${button.primary} ml-auto`}>
          {busy && <LoaderCircle size={18} className="animate-spin motion-reduce:[animation-duration:6s]" aria-hidden />}
          Guardar
        </button>
      </div>
    </form>
  );
}

/** Several tables at once, "Mesa #n" numbered after the last one (all or none). */
function AddTablesForm({ floors, next, onSaved }: { floors: Floor[]; next: number; onSaved: (tables: DiningTable[]) => void }) {
  const api = useApi();
  const [count, setCount] = useState("1");
  const [capacity, setCapacity] = useState("4");
  const [floorId, setFloorId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = Number(count);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const seats = Number(capacity);
    if (!Number.isInteger(n) || n < 1 || n > 50) return setError("Puedes agregar de 1 a 50 mesas a la vez.");
    if (!Number.isInteger(seats) || seats < 1 || seats > 99) return setError("Los puestos van de 1 a 99.");
    setBusy(true);
    setError(null);
    try {
      onSaved(await api<DiningTable[]>("/tables/batch", "POST", { count: n, capacity: seats, floor_id: floorId || null }));
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} noValidate className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className={labelClass}>Cuántas mesas</span>
          <input inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value.replace(/\D/g, ""))} aria-describedby="count-help" className={`${field} figures`} />
        </label>
        <label className="block">
          <span className={labelClass}>Puestos por mesa</span>
          <input inputMode="numeric" value={capacity} onChange={(e) => setCapacity(e.target.value.replace(/\D/g, ""))} className={`${field} figures`} />
        </label>
        <div className="sm:col-span-2">
          <ZoneSelect floors={floors} value={floorId} onChange={setFloorId} />
        </div>
      </div>
      <p id="count-help" className="figures text-sm text-muted">
        {n > 1 ? `Se crean de “Mesa #${next}” a “Mesa #${next + n - 1}”.` : `Se crea “Mesa #${next}”.`} Luego puedes cambiarles el nombre.
      </p>

      {error && (
        <p role="alert" className="rounded-control bg-danger-soft px-3 py-2.5 text-sm text-danger">
          {error}
        </p>
      )}

      <div className="flex justify-end border-t border-line pt-5">
        <button type="submit" disabled={busy} className={button.primary}>
          {busy && <LoaderCircle size={18} className="animate-spin motion-reduce:[animation-duration:6s]" aria-hidden />}
          {n > 1 ? `Agregar ${n} mesas` : "Agregar mesa"}
        </button>
      </div>
    </form>
  );
}

/** Add, rename and delete zones of the location. A zone with tables cannot be deleted. */
function Zones({ floors, onChange }: { floors: Floor[]; onChange: (floors: Floor[]) => void }) {
  const api = useApi();
  const [names, setNames] = useState<Record<string, string>>(() => Object.fromEntries(floors.map((f) => [f.id, f.name])));
  const [fresh, setFresh] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (work: () => Promise<void>, onConflict: string) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(conflict(err, onConflict));
    } finally {
      setBusy(false);
    }
  };
  const taken = "Ya existe una zona con ese nombre en esta sede.";

  const add = (event: React.FormEvent) => {
    event.preventDefault();
    if (!fresh.trim()) return;
    void run(async () => {
      const saved = await api<Floor>("/floors", "POST", { name: fresh.trim() });
      onChange([...floors, saved]);
      setNames((all) => ({ ...all, [saved.id]: saved.name }));
      setFresh("");
    }, taken);
  };

  return (
    <div>
      <p className="text-sm text-muted">Agrupan las mesas en el mapa: Terraza, Salón, Segundo piso… Para eliminar una zona, primero mueve o elimina sus mesas.</p>
      <ul className="mt-4 space-y-2">
        {floors.map((f) => {
          const changed = names[f.id]?.trim() && names[f.id].trim() !== f.name;
          return (
            <li key={f.id} className="flex items-center gap-2">
              <input
                value={names[f.id] ?? ""}
                onChange={(e) => setNames((all) => ({ ...all, [f.id]: e.target.value }))}
                maxLength={40}
                aria-label={`Nombre de la zona ${f.name}`}
                className={`${field} flex-1`}
              />
              {changed ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const saved = await api<Floor>(`/floors/${f.id}`, "PATCH", { name: names[f.id].trim() });
                      onChange(floors.map((x) => (x.id === f.id ? saved : x)));
                    }, taken)
                  }
                  aria-label={`Guardar ${names[f.id]}`}
                  className="flex size-11 shrink-0 items-center justify-center rounded-control text-accent-strong transition-[background-color] duration-150 hover:enabled:bg-accent-soft"
                >
                  <Check size={18} strokeWidth={2.25} aria-hidden />
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api(`/floors/${f.id}`, "DELETE");
                      onChange(floors.filter((x) => x.id !== f.id));
                    }, `“${f.name}” tiene mesas: muévelas a otra zona o elimínalas primero.`)
                  }
                  aria-label={`Eliminar la zona ${f.name}`}
                  className="flex size-11 shrink-0 items-center justify-center rounded-control text-muted transition-[background-color,color] duration-150 hover:enabled:bg-danger-soft hover:enabled:text-danger"
                >
                  <Trash2 size={18} aria-hidden />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <form onSubmit={add} className="mt-4 flex gap-2">
        <input value={fresh} onChange={(e) => setFresh(e.target.value)} maxLength={40} placeholder="Nueva zona" aria-label="Nueva zona" className={`${field} flex-1`} />
        <button type="submit" disabled={busy || !fresh.trim()} className={button.secondary}>
          Agregar
        </button>
      </form>
      {error && (
        <p role="alert" className="mt-3 rounded-control bg-danger-soft px-3 py-2.5 text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
