"use client";

import { LoaderCircle, Plus, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type ActivityEntry, ActivityLine } from "@/components/admin/activity";
import { Dialog } from "@/components/dialog";
import { button, choice, field } from "@/components/ui";
import { errorMessage, useApi } from "@/lib/api";
import type { Me } from "@/lib/auth";
import { fold, qty } from "@/lib/format";
import type { Ingredient, LocationStock } from "@/lib/pos";

/** Common units, offered as suggestions; the field stays free text. */
const UNITS = ["gr", "kg", "ml", "l", "und"];

const labelClass = "mb-1.5 block text-sm font-medium text-ink-2";

/** Same rule as the API's stock alerts (at or under the minimum). Stock can go negative: sales never block. */
function level(stock?: LocationStock): "out" | "low" | null {
  const current = Number(stock?.current_qty ?? 0);
  if (current <= 0) return "out";
  return current <= Number(stock?.min_alert_qty ?? 0) ? "low" : null;
}

const decimal = (text: string) => (text.trim() ? Number(text.replace(",", ".")) : 0);
const same = (a: string, b: string) => fold(a.trim()) === fold(b.trim());

/**
 * Inventory: ingredients (organization-wide) with their stock and alert minimum at the current location,
 * leaving out those only other locations use (Q43).
 * Sales deduct stock by recipe when an order is paid. Only the owner manages ingredients (Q53); supervisors and
 * cashiers receive goods and count stock (Q39). Owners and supervisors also see each ingredient's recent moves.
 */
export function Inventory({ me }: { me: Me }) {
  const api = useApi();
  const [ingredients, setIngredients] = useState<Ingredient[] | null>(null);
  const [stock, setStock] = useState<Record<string, LocationStock>>({});
  const [query, setQuery] = useState("");
  const [onlyAlerts, setOnlyAlerts] = useState(false);
  const [editing, setEditing] = useState<Ingredient | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const locationName = me.locations.find((l) => l.id === me.current_location_id)?.name ?? "esta sede";
  const canManage = me.user.role === "OWNER";
  const canSeeLog = canManage || me.user.role === "ADMIN";

  // The page remounts this screen when the location changes, so it loads once per location.
  useEffect(() => {
    void (async () => {
      try {
        const [all, here] = await Promise.all([api<Ingredient[]>("/ingredients?here=1"), api<LocationStock[]>("/location-stock")]);
        setIngredients(all);
        setStock(Object.fromEntries(here.map((s) => [s.ingredient_id, s])));
      } catch (err) {
        setError(errorMessage(err));
      }
    })();
  }, [api]);

  if (!ingredients) {
    return error ? (
      <p role="alert" className="rounded-panel border border-line bg-surface px-5 py-10 text-center text-[15px] text-danger">
        {error}
      </p>
    ) : (
      <p role="status" className="py-10 text-center text-[15px] text-muted">
        Cargando inventario…
      </p>
    );
  }

  const alerts = ingredients.filter((g) => level(stock[g.id]));
  const shown = (onlyAlerts ? alerts : ingredients).filter((g) => !query || fold(g.name).includes(fold(query)));
  const ingredient = editing === "new" ? undefined : (editing ?? undefined);

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <label className="relative min-w-56 flex-1 sm:max-w-sm">
          <span className="sr-only">Buscar ingrediente</span>
          <Search size={18} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" aria-hidden />
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar ingrediente" className={`${field} pl-10`} />
        </label>
        <fieldset className="flex gap-2">
          <legend className="sr-only">Mostrar</legend>
          {[
            { value: false, label: "Todos", count: ingredients.length },
            { value: true, label: "Con alerta", count: alerts.length },
          ].map((f) => (
            <label key={f.label} className={`${choice} gap-1.5`}>
              <input type="radio" name="filter" checked={onlyAlerts === f.value} onChange={() => setOnlyAlerts(f.value)} className="sr-only" />
              {f.label}
              <span className="figures font-normal">{f.count}</span>
            </label>
          ))}
        </fieldset>
        {canManage && (
          <button type="button" onClick={() => setEditing("new")} className={`${button.primary} ml-auto pl-3.5`}>
            <Plus size={18} strokeWidth={2.25} aria-hidden />
            Nuevo ingrediente
          </button>
        )}
      </div>

      {!ingredients.length ? (
        <p className="rounded-panel border border-line bg-surface px-5 py-10 text-center text-[15px] text-muted">
          {canManage ? (
            <>Todavía no hay ingredientes. Crea el primero con &ldquo;Nuevo ingrediente&rdquo; y luego úsalo en las recetas del catálogo.</>
          ) : (
            "Todavía no hay ingredientes. El dueño los crea."
          )}
        </p>
      ) : !shown.length ? (
        <p className="py-10 text-center text-[15px] text-muted">
          {query ? <>Ningún ingrediente coincide con &ldquo;{query}&rdquo;.</> : "Ningún ingrediente está en o bajo su mínimo."}
        </p>
      ) : (
        <section aria-labelledby="stock-title">
          <h2 id="stock-title" className="mb-3 text-sm font-semibold text-ink-2">
            Stock en {locationName}
          </h2>
          <ul className="divide-y divide-line rounded-panel border border-line bg-surface">
            {shown.map((g) => {
              const here = stock[g.id];
              const state = level(here);
              const min = Number(here?.min_alert_qty ?? 0);
              return (
                <li key={g.id}>
                  <button
                    type="button"
                    onClick={() => setEditing(g)}
                    className="flex min-h-14 w-full items-center gap-4 px-5 py-3 text-left transition-[background-color] duration-150 first:rounded-t-panel last:rounded-b-panel hover:bg-ground"
                  >
                    <span className="min-w-0 flex-1 text-[15px] font-medium">{g.name}</span>
                    {state === "out" && <span className="rounded-full bg-danger-soft px-2 py-0.5 text-xs font-medium text-danger">Sin stock</span>}
                    {state === "low" && <span className="rounded-full bg-warning-soft px-2 py-0.5 text-xs font-medium text-warning">Bajo el mínimo</span>}
                    <span className="text-right">
                      <span className={`figures block text-[15px] font-medium ${state === "out" ? "text-danger" : ""}`}>
                        {qty(here?.current_qty ?? 0)} {g.unit}
                      </span>
                      <span className="figures block text-xs text-muted">{min > 0 ? `Mínimo ${qty(min)} ${g.unit}` : "Sin mínimo"}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={ingredient ? ingredient.name : "Nuevo ingrediente"}>
        <IngredientForm
          key={ingredient?.id ?? "new"}
          ingredient={ingredient}
          canManage={canManage}
          canSeeLog={canSeeLog}
          stock={ingredient ? stock[ingredient.id] : undefined}
          taken={ingredients.filter((g) => g.id !== ingredient?.id).map((g) => g.name)}
          locationName={locationName}
          onSaved={(saved, here) => {
            setIngredients((all) => [...(all ?? []).filter((g) => g.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name, "es")));
            if (here) setStock((all) => ({ ...all, [saved.id]: here }));
            setEditing(null);
          }}
          onDeleted={(id) => {
            setIngredients((all) => all?.filter((g) => g.id !== id) ?? null);
            setEditing(null);
          }}
        />
      </Dialog>
    </div>
  );
}

/**
 * Create or edit an ingredient (name and unit, organization-wide; owner only) and update its stock at the
 * current location: receive goods (adds) or count (sets), plus the alert minimum.
 */
function IngredientForm({
  ingredient,
  canManage,
  canSeeLog,
  stock,
  taken,
  locationName,
  onSaved,
  onDeleted,
}: {
  ingredient?: Ingredient;
  canManage: boolean;
  canSeeLog: boolean;
  stock?: LocationStock;
  taken: string[];
  locationName: string;
  onSaved: (ingredient: Ingredient, stock?: LocationStock) => void;
  onDeleted: (id: string) => void;
}) {
  const api = useApi();
  const now = Number(stock?.current_qty ?? 0);
  const initialCurrent = String(now);
  const initialMin = Number(stock?.min_alert_qty ?? 0) ? String(Number(stock!.min_alert_qty)) : "";
  const [name, setName] = useState(ingredient?.name ?? "");
  const [unit, setUnit] = useState(ingredient?.unit ?? "");
  const [mode, setMode] = useState<"receive" | "count">("receive");
  const [received, setReceived] = useState("");
  const [current, setCurrent] = useState(initialCurrent);
  const [min, setMin] = useState(initialMin);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // A step that already saved is not repeated on retry: no duplicate ingredient, no goods added twice.
  const created = useRef<string | null>(null);
  const receivedDone = useRef<LocationStock | null>(null);
  const shownUnit = unit.trim();
  const [moves, setMoves] = useState<ActivityEntry[] | null>(null);

  useEffect(() => {
    if (!canSeeLog || !ingredient) return;
    api<ActivityEntry[]>(`/activity?ingredient=${ingredient.id}&limit=5`).then(setMoves, () => undefined);
  }, [api, canSeeLog, ingredient]);

  const problem = () => {
    if (canManage) {
      if (!name.trim()) return "Escribe el nombre del ingrediente.";
      if (taken.some((t) => same(t, name))) return `Ya existe un ingrediente llamado "${name.trim()}".`;
      if (!shownUnit) return "Escribe la unidad en que lo mides (gr, ml, und…).";
    }
    if (mode === "receive" && received.trim() && !(decimal(received) > 0)) return "Escribe cuánto llegó, por ejemplo 5000 o 2,5.";
    if (mode === "count" && !Number.isFinite(decimal(current))) return "Escribe el stock contado como un número, por ejemplo 1500 o 2,5.";
    if (!Number.isFinite(decimal(min))) return "Escribe el mínimo como un número, por ejemplo 500.";
    return null;
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const issue = problem();
    if (issue) return setError(issue);
    setBusy(true);
    setError(null);
    try {
      const body = { name: name.trim(), unit: shownUnit };
      const id = ingredient?.id ?? created.current;
      let saved = ingredient!;
      if (canManage) saved = id ? await api<Ingredient>(`/ingredients/${id}`, "PATCH", body) : await api<Ingredient>("/ingredients", "POST", body);
      created.current = saved.id;
      let here = stock;
      if (mode === "receive" && received.trim()) {
        receivedDone.current ??= await api<LocationStock>(`/location-stock/${saved.id}/receive`, "POST", { qty: decimal(received) });
        here = receivedDone.current;
      }
      // A count sends only what changed: an untouched number must not overwrite what sales deducted meanwhile.
      const changes = {
        ...(mode === "count" && current !== initialCurrent && { current_qty: decimal(current) }),
        ...(min !== initialMin && { min_alert_qty: decimal(min) }),
      };
      if (Object.keys(changes).length) here = await api<LocationStock>(`/location-stock/${saved.id}`, "PUT", changes);
      onSaved(saved, here);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/ingredients/${ingredient!.id}`, "DELETE");
      onDeleted(ingredient!.id);
    } catch (err) {
      setError(errorMessage(err));
      setConfirmDelete(false);
      setBusy(false);
    }
  };

  const quantity = (value: string, onChange: (value: string) => void, describedBy: string) => (
    <span className="relative block">
      <input
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="0"
        aria-describedby={describedBy}
        className={`${field} figures ${shownUnit ? "pr-14" : ""}`}
      />
      {shownUnit && <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted">{shownUnit}</span>}
    </span>
  );

  return (
    <form onSubmit={save} noValidate className="space-y-5">
      {canManage ? (
        <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
          <label className="block">
            <span className={labelClass}>Nombre</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required placeholder="Leche entera" className={field} />
          </label>
          <label className="block">
            <span className={labelClass}>Unidad</span>
            <input value={unit} onChange={(e) => setUnit(e.target.value)} maxLength={20} required list="units" placeholder="ml" className={field} />
            <datalist id="units">
              {UNITS.map((u) => (
                <option key={u} value={u} />
              ))}
            </datalist>
          </label>
          <p className="-mt-2 text-sm text-muted sm:col-span-2">Las recetas y el stock usan esta unidad.</p>
        </div>
      ) : (
        <p className="-mt-3 text-[15px] text-ink-2">
          Hay{" "}
          <span className="figures font-semibold text-ink">
            {qty(now)} {shownUnit}
          </span>{" "}
          en {locationName}.
        </p>
      )}

      <section aria-label={`Stock en ${locationName}`} className={canManage ? "border-t border-line pt-5" : ""}>
        {canManage && (
          <>
            <h3 className="text-[15px] font-semibold">En {locationName}</h3>
            <p className="mt-0.5 mb-3 text-sm text-muted">Cada venta pagada descuenta la receta. Si se vende más de lo contado, el stock queda en negativo y la venta sigue.</p>
          </>
        )}
        <fieldset className="grid grid-cols-2 gap-2">
          <legend className="sr-only">Qué vas a hacer</legend>
          {(
            [
              ["receive", "Recibir mercancía"],
              ["count", "Conteo"],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className={choice}>
              <input type="radio" name="mode" checked={mode === value} onChange={() => setMode(value)} className="sr-only" />
              {label}
            </label>
          ))}
        </fieldset>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {mode === "receive" ? (
            <label className="block">
              <span className={labelClass}>Cantidad que llegó</span>
              {quantity(received, (v) => setReceived(v.replace(/[^\d.,]/g, "")), "receive-help")}
              <span id="receive-help" className="figures mt-1.5 block text-sm text-muted">
                {decimal(received) > 0 ? `Quedará en ${qty(now + decimal(received))} ${shownUnit}` : `Se suma a ${qty(now)} ${shownUnit}`}
              </span>
            </label>
          ) : (
            <label className="block">
              <span className={labelClass}>Stock contado</span>
              {quantity(current, (v) => setCurrent(v.replace(/[^\d.,-]/g, "")), "count-help")}
              <span id="count-help" className="mt-1.5 block text-sm text-muted">
                Reemplaza el número actual.
              </span>
            </label>
          )}
          <label className="block">
            <span className={labelClass}>Avisar desde</span>
            {quantity(min, (v) => setMin(v.replace(/[^\d.,]/g, "")), "min-help")}
            <span id="min-help" className="mt-1.5 block text-sm text-muted">
              Vacío: solo avisa al agotarse.
            </span>
          </label>
        </div>
      </section>

      {moves && (
        <section aria-labelledby="moves-title" className="border-t border-line pt-5">
          <h3 id="moves-title" className="mb-3 text-[15px] font-semibold">
            Últimos movimientos
          </h3>
          {moves.length ? (
            <ul className="divide-y divide-line rounded-panel border border-line">
              {moves.map((entry) => (
                <ActivityLine key={entry.id} entry={entry} withDate />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">Sin entradas ni conteos en {locationName} todavía.</p>
          )}
        </section>
      )}

      {error && (
        <p role="alert" className="rounded-control bg-danger-soft px-3 py-2.5 text-sm text-danger">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-5">
        {ingredient &&
          canManage &&
          (confirmDelete ? (
            <>
              <span className="w-full text-sm text-ink-2">Se quita de todas las recetas y del stock de todas las sedes.</span>
              <button type="button" disabled={busy} onClick={() => void remove()} className={button.danger}>
                Eliminar {ingredient.name}
              </button>
              <button type="button" onClick={() => setConfirmDelete(false)} className={button.ghost}>
                No
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setConfirmDelete(true)} className={`${button.quietDanger} -ml-3`}>
              Eliminar ingrediente
            </button>
          ))}
        <button type="submit" disabled={busy} className={`${button.primary} ml-auto`}>
          {busy && <LoaderCircle size={18} className="animate-spin motion-reduce:[animation-duration:6s]" aria-hidden />}
          {ingredient ? "Guardar" : "Crear ingrediente"}
        </button>
      </div>
    </form>
  );
}
