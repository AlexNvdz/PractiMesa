"use client";

import { ListChecks, LoaderCircle, PackagePlus, Plus, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { RowSkeleton } from "@/components/skeleton";
import type { ActivityEntry } from "@/components/admin/activity";
import { Dialog } from "@/components/dialog";
import { FormAlert } from "@/components/form-alert";
import { Sentinel } from "@/components/sentinel";
import { button, field, seg, segItem } from "@/components/ui";
import { errorMessage, useApi } from "@/lib/api";
import { useDebounced, usePagedList } from "@/lib/paged";
import type { Me } from "@/lib/auth";
import { fold, qty, time } from "@/lib/format";
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

/**
 * Stock bar: how much there is, with a dark mark at the alert minimum. The scale leaves room above the
 * minimum so a healthy stock reads as a long bar.
 */
export function StockMeter({ stock, unit, big = false }: { stock?: LocationStock; unit: string; big?: boolean }) {
  const current = Number(stock?.current_qty ?? 0);
  const min = Number(stock?.min_alert_qty ?? 0);
  const state = level(stock);
  const scale = Math.max(min * 2.5, current, 1);
  return (
    <span
      role="img"
      aria-label={`${qty(current)} ${unit}${min > 0 ? `, mínimo ${qty(min)} ${unit}` : ""}`}
      className={`relative block rounded-full bg-line ${big ? "h-3" : "h-2"}`}
    >
      <span
        className={`absolute inset-y-0 left-0 rounded-full ${state === "out" ? "w-1.5 bg-danger" : state === "low" ? "bg-warning" : "bg-success"}`}
        style={state === "out" ? undefined : { width: `${(current / scale) * 100}%` }}
      />
      {min > 0 && <span className="absolute -inset-y-1 w-0.5 rounded-full bg-ink" style={{ left: `${(min / scale) * 100}%` }} />}
    </span>
  );
}

const decimal = (text: string) => (text.trim() ? Number(text.replace(",", ".")) : 0);
const same = (a: string, b: string) => fold(a.trim()) === fold(b.trim());

/** One row of the paged inventory: the ingredient and its stock at this location. */
interface StockItem extends Ingredient {
  current_qty: string;
  min_alert_qty: string;
}
const stockOf = (item: StockItem): LocationStock => ({ ingredient_id: item.id, current_qty: item.current_qty, min_alert_qty: item.min_alert_qty });
interface Counts {
  all: number;
  alert: number;
  out: number;
}

/** The stock list. Rows arrive page by page; the end of the list asks for the next one before it is reached. */
function StockRows({
  rows,
  total,
  loadMore,
  busy,
  onOpen,
}: {
  rows: StockItem[];
  total: number;
  loadMore?: () => void;
  busy: boolean;
  onOpen: (item: StockItem) => void;
}) {
  return (
    <>
      <ul className="divide-y divide-line pm-card">
        {rows.map((g) => {
          const here = stockOf(g);
          const state = level(here);
          const min = Number(g.min_alert_qty);
          return (
            // Rows far off screen skip layout and paint until scrolled near: long lists stay fast.
            <li key={g.id} className="[contain-intrinsic-size:auto_64px] [content-visibility:auto]">
              <button
                type="button"
                onClick={() => onOpen(g)}
                className="grid min-h-16 w-full grid-cols-[minmax(0,1.5fr)_minmax(140px,1fr)_128px_132px] items-center gap-4 px-3.5 py-3 text-left transition-[background-color] duration-150 hover:bg-ground sm:px-[18px] max-[899px]:grid-cols-[minmax(0,1fr)_112px]"
              >
                <span className="min-w-0">
                  <span className="block truncate text-[15px] font-[650]">{g.name}</span>
                  {g.category && <span className="block truncate text-[13px] font-medium text-muted">{g.category}</span>}
                </span>
                <span className="max-[899px]:order-last max-[899px]:col-span-full">
                  <StockMeter stock={here} unit={g.unit} />
                </span>
                <span className="figures text-right font-bold">
                  <span className={`block ${state === "out" ? "text-danger" : ""}`}>
                    {qty(g.current_qty)} {g.unit}
                  </span>
                  <small className="block text-[12.5px] font-medium text-muted">{min > 0 ? `mín ${qty(min)} ${g.unit}` : "Sin mínimo"}</small>
                </span>
                {/* Under 900px the tag leaves the row but stays for screen readers (the bar and the figures say the rest). */}
                <span
                  className={`inline-flex h-6 items-center justify-self-end rounded-full px-[9px] text-[12.5px] font-bold whitespace-nowrap max-[899px]:sr-only ${
                    state === "out" ? "bg-danger-soft text-danger" : state === "low" ? "bg-warning-soft text-warning" : "bg-success-soft text-success"
                  }`}
                >
                  {state === "out" ? "Sin stock" : state === "low" ? "Bajo el mínimo" : "Bien"}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <Sentinel onNear={loadMore} busy={busy}>
        {loadMore || busy ? `Mostrando ${rows.length} de ${total}` : `${total} en total`}
      </Sentinel>
    </>
  );
}

/**
 * Inventory: ingredients (organization-wide) with their stock and alert minimum at the current location,
 * leaving out those only other locations use (Q43). The server searches, filters and pages (30 at a time).
 * Sales deduct stock by recipe when an order is paid. Only the owner manages ingredients (Q53); supervisors and
 * cashiers receive goods and count stock (Q39). Owners and supervisors also see each ingredient's recent moves.
 */
export function Inventory({ me }: { me: Me }) {
  const [query, setQuery] = useState("");
  const search = useDebounced(query.trim());
  const [filter, setFilter] = useState<"all" | "alert" | "out">("all");
  const [editing, setEditing] = useState<StockItem | "new" | null>(null);
  const list = usePagedList<StockItem, Counts>("/inventory", { limit: "30", filter, ...(search ? { q: search } : {}) });
  const locationName = me.locations.find((l) => l.id === me.current_location_id)?.name ?? "esta sede";
  const canManage = me.user.role === "OWNER";
  const canSeeLog = canManage || me.user.role === "ADMIN";

  if (!list.items || !list.counts) {
    return list.error ? (
      <p role="alert" className="pm-card px-5 py-10 text-center text-[15px] text-danger">
        {list.error}
      </p>
    ) : (
      <RowSkeleton label="Cargando inventario…" />
    );
  }

  const { items, counts } = list;
  const item = editing === "new" ? undefined : (editing ?? undefined);

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <label className="relative min-w-56 flex-1 sm:max-w-sm">
          <span className="sr-only">Buscar ingrediente o grupo</span>
          <Search size={18} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" aria-hidden />
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar ingrediente o grupo" className={`${field} pl-10`} />
        </label>
        <fieldset className={`${seg} max-sm:order-3 max-sm:w-full`}>
          <legend className="sr-only">Mostrar</legend>
          {(
            [
              { value: "all", label: "Todos", count: counts.all },
              { value: "alert", label: "Con alerta", count: counts.alert },
              { value: "out", label: "Sin stock", count: counts.out },
            ] as const
          ).map((f) => (
            <label key={f.value} className={`${segItem} max-sm:flex-1`}>
              <input type="radio" name="filter" checked={filter === f.value} onChange={() => setFilter(f.value)} className="sr-only" />
              {f.label}
              <span
                className={`figures grid h-5 min-w-5 place-items-center rounded-full px-1.5 text-xs font-bold ${
                  f.value !== "all" && f.count ? (f.value === "out" ? "bg-danger-soft text-danger" : "bg-warning-soft text-warning") : "bg-ink/[0.07]"
                }`}
              >
                {f.count}
              </span>
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

      {list.error && <FormAlert>{list.error}</FormAlert>}

      {!counts.all ? (
        <p className="pm-card px-5 py-10 text-center text-[15px] text-muted">
          {canManage ? (
            <>Todavía no hay ingredientes. Crea el primero con &ldquo;Nuevo ingrediente&rdquo; y luego úsalo en las recetas del catálogo.</>
          ) : (
            "Todavía no hay ingredientes. El dueño los crea."
          )}
        </p>
      ) : !items.length ? (
        <p className="py-10 text-center text-[15px] text-muted">
          {search ? (
            <>Ningún ingrediente coincide con &ldquo;{search}&rdquo;.</>
          ) : filter === "out" ? (
            "Ningún ingrediente está sin stock."
          ) : (
            "Ningún ingrediente está en o bajo su mínimo."
          )}
        </p>
      ) : (
        <section aria-labelledby="stock-title" aria-busy={list.stale} className={list.stale ? "opacity-60 transition-opacity" : "transition-opacity"}>
          <h2 id="stock-title" className="mb-1 font-display text-[17px] font-semibold tracking-[-0.01em]">
            Stock en {locationName}
          </h2>
          <p className="mb-3 text-sm text-muted">Cada barra muestra cuánto hay; la marca oscura es el mínimo que dispara la alerta.</p>
          <StockRows rows={items} total={list.total} loadMore={list.loadMore} busy={list.loadingMore} onOpen={setEditing} />
        </section>
      )}

      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={item ? item.name : "Nuevo ingrediente"}
        subtitle={item ? `${item.category ? `${item.category} · ` : ""}${locationName}` : undefined}
        side
      >
        <IngredientForm
          key={item?.id ?? "new"}
          ingredient={item}
          canManage={canManage}
          canSeeLog={canSeeLog}
          stock={item ? stockOf(item) : undefined}
          // Names on screen only: the server has the last word on a repeated name (409).
          taken={items.filter((g) => g.id !== item?.id).map((g) => g.name)}
          groups={[...new Set(items.flatMap((g) => (g.category ? [g.category] : [])))].sort((a, b) => a.localeCompare(b, "es"))}
          locationName={locationName}
          onSaved={() => {
            setEditing(null);
            list.reload();
          }}
          onDeleted={() => {
            setEditing(null);
            list.reload();
          }}
          onCancel={() => setEditing(null)}
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
  groups,
  locationName,
  onSaved,
  onDeleted,
  onCancel,
}: {
  ingredient?: Ingredient;
  canManage: boolean;
  canSeeLog: boolean;
  stock?: LocationStock;
  taken: string[];
  groups: string[];
  locationName: string;
  onSaved: (ingredient: Ingredient, stock?: LocationStock) => void;
  onDeleted: (id: string) => void;
  onCancel: () => void;
}) {
  const api = useApi();
  const now = Number(stock?.current_qty ?? 0);
  const initialCurrent = String(now);
  const initialMin = Number(stock?.min_alert_qty ?? 0) ? String(Number(stock!.min_alert_qty)) : "";
  const [name, setName] = useState(ingredient?.name ?? "");
  const [unit, setUnit] = useState(ingredient?.unit ?? "");
  const [group, setGroup] = useState(ingredient?.category ?? "");
  const [mode, setMode] = useState<"receive" | "count">("receive");
  const [received, setReceived] = useState("");
  const [current, setCurrent] = useState(initialCurrent);
  const [min, setMin] = useState(initialMin);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [dataOpen, setDataOpen] = useState(false);
  // A step that already saved is not repeated on retry: no duplicate ingredient, no goods added twice.
  const created = useRef<string | null>(null);
  const receivedDone = useRef<LocationStock | null>(null);
  const shownUnit = unit.trim();
  const [moves, setMoves] = useState<ActivityEntry[] | null>(null);

  useEffect(() => {
    if (!canSeeLog || !ingredient) return;
    api<ActivityEntry[]>(`/activity?ingredient=${ingredient.id}&limit=5`).then(setMoves, () => undefined);
  }, [api, canSeeLog, ingredient]);

  const openData = (message: string) => {
    setDataOpen(true);
    return message;
  };

  const problem = () => {
    if (canManage) {
      if (!name.trim()) return openData("Escribe el nombre del ingrediente.");
      if (taken.some((t) => same(t, name))) return openData(`Ya existe un ingrediente llamado "${name.trim()}".`);
      if (!shownUnit) return openData("Escribe la unidad en que lo mides (gr, ml, und…).");
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
      const body = { name: name.trim(), unit: shownUnit, category: group.trim() || null };
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
      setDataOpen(true);
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

  const quantity = (value: string, onChange: (value: string) => void, id: string, describedBy: string) => (
    <span className="relative block">
      <input
        id={id}
        inputMode="decimal"
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="0"
        aria-describedby={describedBy}
        className={`${field} figures text-lg font-[650] ${shownUnit ? "pr-14" : ""}`}
      />
      {shownUnit && <span className="pointer-events-none absolute inset-y-0 right-3.5 flex items-center font-semibold text-muted">{shownUnit}</span>}
    </span>
  );

  const minNow = Number(stock?.min_alert_qty ?? 0);
  const typed = mode === "receive" ? decimal(received) : decimal(current);
  const edited = mode === "receive" ? received.trim() !== "" && typed > 0 : current !== initialCurrent && Number.isFinite(typed);
  const hint =
    edited && ingredient ? (
      <>
        Queda en{" "}
        <b className="text-ink">
          {qty(mode === "receive" ? now + typed : typed)} {shownUnit}
        </b>{" "}
        (antes {qty(now)} {shownUnit}).
      </>
    ) : mode === "receive" ? (
      "Se suma a lo que hay. Si guardas dos veces, se suma dos veces."
    ) : (
      "Escribe lo que contaste: reemplaza el número actual."
    );

  // Name, unit and group belong to the whole business, so only the owner edits them. A new ingredient asks for them first.
  const data = canManage && (
    <>
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
        <label className="block sm:col-span-2">
          <span className={labelClass}>
            Grupo <span className="font-normal text-muted">(opcional)</span>
          </span>
          <input value={group} onChange={(e) => setGroup(e.target.value)} maxLength={40} list="groups" placeholder="Lácteos" className={field} />
          <datalist id="groups">
            {groups.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
        </label>
        <p className="-mt-1 text-sm text-muted sm:col-span-2">Las recetas y el stock usan esta unidad. El grupo se muestra bajo el nombre y se puede buscar.</p>
      </div>
      {ingredient &&
        (confirmDelete ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-full text-sm text-ink-2">Se quita de todas las recetas y del stock de todas las sedes.</span>
            <button type="button" disabled={busy} onClick={() => void remove()} className={button.danger}>
              Eliminar {ingredient.name}
            </button>
            <button type="button" onClick={() => setConfirmDelete(false)} className={button.ghost}>
              No
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => setConfirmDelete(true)} className={`${button.quietDanger} -ml-3 justify-self-start`}>
            Eliminar ingrediente
          </button>
        ))}
    </>
  );

  return (
    <form id="ingredient-form" onSubmit={save} noValidate className="flex min-h-0 flex-1 flex-col">
      <div className="grid flex-1 content-start gap-5 overflow-y-auto overscroll-contain px-6 py-5">
        {!ingredient && data}

        {ingredient && (
          <div>
            <StockMeter stock={stock} unit={shownUnit} big />
            <div className="figures mt-2 flex items-baseline justify-between gap-3 text-[13.5px] text-muted">
              <span>
                <b className="font-display text-[22px] font-bold text-ink">{qty(now)}</b> {shownUnit} en stock
              </span>
              <span>{minNow > 0 ? `Mínimo ${qty(minNow)} ${shownUnit}` : "Sin mínimo"}</span>
            </div>
          </div>
        )}

        <fieldset className={`${seg} w-full`}>
          <legend className="sr-only">Tipo de ajuste</legend>
          {(
            [
              ["receive", "Recibir mercancía", PackagePlus],
              ["count", "Conteo", ListChecks],
            ] as const
          ).map(([value, label, Icon]) => (
            <label key={value} className={`${segItem} flex-1`}>
              <input type="radio" name="mode" checked={mode === value} onChange={() => setMode(value)} className="sr-only" />
              <Icon size={16} aria-hidden />
              {label}
            </label>
          ))}
        </fieldset>

        <div>
          {mode === "receive" ? (
            <>
              <label htmlFor="amount" className={labelClass}>
                Cantidad que llegó
              </label>
              {quantity(received, (v) => setReceived(v.replace(/[^\d.,]/g, "")), "amount", "amount-hint")}
            </>
          ) : (
            <>
              <label htmlFor="amount" className={labelClass}>
                Cantidad contada
              </label>
              {quantity(current, (v) => setCurrent(v.replace(/[^\d.,-]/g, "")), "amount", "amount-hint")}
            </>
          )}
          <p id="amount-hint" className="figures mt-1.5 text-[13.5px] text-muted">
            {hint}
          </p>
        </div>

        <div>
          <label htmlFor="min" className={labelClass}>
            Avisar cuando baje de
          </label>
          {quantity(min, (v) => setMin(v.replace(/[^\d.,]/g, "")), "min", "min-hint")}
          <p id="min-hint" className="sr-only">
            Vacío: solo avisa al agotarse. Cada venta pagada descuenta la receta y el stock puede quedar en negativo.
          </p>
        </div>

        {moves && ingredient && (
          <section aria-labelledby="moves-title">
            <h3 id="moves-title" className="mb-2 text-[13px] font-bold text-muted">
              Últimos movimientos
            </h3>
            {moves.length ? (
              <ul className="grid gap-0.5">
                {moves.map((entry) => (
                  <MoveLine key={entry.id} entry={entry} />
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">Sin entradas ni conteos en {locationName} todavía.</p>
            )}
          </section>
        )}

        {ingredient && data && (
          <details open={dataOpen} onToggle={(e) => setDataOpen(e.currentTarget.open)} className="rounded-panel border border-line px-4 py-3 [&[open]>summary]:mb-4">
            <summary className="cursor-pointer text-sm font-[650] text-ink-2">Datos del ingrediente</summary>
            <div className="grid gap-5">{data}</div>
          </details>
        )}

        {error && (
          <p role="alert" className="rounded-control bg-danger-soft px-3 py-2.5 text-sm text-danger">
            {error}
          </p>
        )}
      </div>

      <footer className="flex shrink-0 gap-2.5 border-t border-line px-6 pt-4 pb-5 [&>*]:flex-1">
        <button type="button" onClick={onCancel} className={button.secondary}>
          Cancelar
        </button>
        <button type="submit" disabled={busy} className={button.primary}>
          {busy && <LoaderCircle size={18} className="animate-spin motion-reduce:[animation-duration:6s]" aria-hidden />}
          {!ingredient ? "Crear ingrediente" : mode === "receive" ? "Sumar al stock" : "Guardar conteo"}
        </button>
      </footer>
    </form>
  );
}

const BOGOTA_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" });
const SHORT_DATE = new Intl.DateTimeFormat("es-CO", { day: "numeric", month: "short", timeZone: "America/Bogota" });

/** "Hoy, 7:40 a. m." / "Ayer" / "Hace 3 días" / "12 de nov" (days counted on the Bogotá calendar). */
function when(iso: string) {
  const then = new Date(iso);
  const days = Math.round((Date.parse(BOGOTA_DAY.format(new Date())) - Date.parse(BOGOTA_DAY.format(then))) / 86_400_000);
  if (days <= 0) return `Hoy, ${time(iso)}`;
  if (days === 1) return "Ayer";
  return days < 7 ? `Hace ${days} días` : SHORT_DATE.format(then);
}

/** One movement in the ingredient sheet: type and who, when, and how much it moved the stock. */
function MoveLine({ entry }: { entry: ActivityEntry }) {
  const receive = entry.kind === "STOCK_RECEIVE";
  const d = entry.details;
  const delta = receive ? Number(d.qty) : Number(d.after) - Number(d.before);
  return (
    <li className="grid grid-cols-[32px_1fr_auto] items-center gap-2.5 py-2 text-sm">
      <span aria-hidden className={`grid size-8 place-items-center rounded-full ${receive ? "bg-success-soft text-success" : "bg-accent-soft text-accent"}`}>
        {receive ? <PackagePlus size={16} /> : <ListChecks size={16} />}
      </span>
      <span>
        {receive ? "Entrada" : "Conteo"} · {entry.users.full_name}
        <small className="figures block text-[12.5px] text-muted">{when(entry.created_at)}</small>
      </span>
      <b className="figures">
        {delta > 0 ? "+" : delta < 0 ? "−" : ""}
        {qty(Math.abs(delta))} {d.unit}
      </b>
    </li>
  );
}
