"use client";

import { ArrowLeft, Clock, ConciergeBell, type LucideIcon, Pencil, Plus, ReceiptText, ShoppingBag, Users } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Dialog } from "@/components/dialog";
import { button } from "@/components/ui";
import { type Undo, UndoToast } from "@/components/undo-toast";
import { errorMessage, useApi } from "@/lib/api";
import type { Me } from "@/lib/auth";
import { cop, elapsed } from "@/lib/format";
import { useLive } from "@/lib/live";
import {
  type Category,
  type DiningTable,
  type Floor,
  isOpen,
  liveItems,
  type LocationProduct,
  type MenuItem,
  type Order,
  type OrderItem,
  type OrderRound,
  type Product,
  toServe,
  hasReady,
  readyCount,
} from "@/lib/pos";
import { AccountPanel } from "./account-panel";
import { ChargeForm } from "./charge-dialog";
import { type DraftLine, linePrice, MenuPicker } from "./menu-picker";
import { type VoidBody, VoidForm } from "./void-dialog";

/** A void or cancel waiting for its reason in the dialog. */
interface Voiding {
  title: string;
  body: string;
  action: string;
  run: (data: VoidBody) => Promise<void>;
}
const units = (n: number) => (n === 1 ? "1 producto" : `${n} productos`);

type Selection = { table: string } | { order: string } | { pickup: true } | null;

interface Confirm {
  title: string;
  body: string;
  action: string;
  run: () => Promise<void> | void;
}

const CHARGE_ROLES = new Set(["OWNER", "ADMIN", "CASHIER"]);
const STATUS_LABEL = { FREE: "Libre", OCCUPIED: "Ocupada", RESERVED: "Reservada" } as const;

/** Clock for elapsed times ("12 min"), refreshed every half minute. */
export function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * Service screen (Q7): table map and counter orders on one side, the selected account on the other.
 * Composing a round swaps the map for the menu. Every terminal of the location stays in sync over SSE.
 */
/** `onReady` reports how many tables and counter orders have food ready, for the badge on the menu. */
export function Service({ me, onReady }: { me: Me; onReady?: (count: number) => void }) {
  const api = useApi();
  const now = useNow();
  const canOrder = me.user.role !== "KITCHEN";
  const canEdit = me.user.role === "OWNER" || me.user.role === "ADMIN";
  const canCharge = CHARGE_ROLES.has(me.user.role);

  const [tables, setTables] = useState<DiningTable[] | null>(null);
  const [floors, setFloors] = useState<Floor[]>([]);
  const [orders, setOrders] = useState<Record<string, Order>>({});
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selected, setSelected] = useState<Selection>(null);
  const [draft, setDraft] = useState<DraftLine[]>([]);
  const [composing, setComposing] = useState(false);
  const [mobilePanel, setMobilePanel] = useState(false);
  const [charging, setCharging] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [voiding, setVoiding] = useState<Voiding | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [undo, setUndo] = useState<Undo | null>(null);

  const put = useCallback((order: Order) => setOrders((all) => ({ ...all, [order.id]: order })), []);

  const loadService = useCallback(async () => {
    try {
      const [t, f, o] = await Promise.all([api<DiningTable[]>("/tables"), api<Floor[]>("/floors"), api<Order[]>("/orders")]);
      setTables(t);
      setFloors(f);
      // Keep closed orders already on screen (a "Pago recibido" being shown); the list has the ones in service.
      setOrders((all) => ({
        ...Object.fromEntries(Object.entries(all).filter(([, order]) => !isOpen(order) && !toServe(order))),
        ...Object.fromEntries(o.map((order) => [order.id, order])),
      }));
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, [api]);

  // The page remounts this screen when the location changes, so the menu loads once per location.
  useEffect(() => {
    void (async () => {
      try {
        const [products, cats, local] = await Promise.all([
          api<Product[]>("/products"),
          api<Category[]>("/categories"),
          api<LocationProduct[]>("/location-products"),
        ]);
        const byProduct = new Map(local.map((l) => [l.product_id, l]));
        setCategories(cats);
        setMenu(
          products
            // Chain products this location lists, plus its own ones (Q43).
            .filter((p) => p.is_active && (!p.location_id || p.location_id === me.current_location_id) && byProduct.get(p.id)?.is_listed !== false)
            .map((p) => {
              const here = byProduct.get(p.id);
              return {
                id: p.id,
                name: p.name,
                category_id: p.category_id,
                price: Number(here?.custom_price_cop ?? p.base_price_cop),
                available: here?.is_available ?? true,
                modifiers: p.modifiers_schema,
              };
            }),
        );
      } catch (err) {
        setLoadError(errorMessage(err));
      }
    })();
  }, [api, me.current_location_id]);

  useLive(
    () => void loadService(),
    (event) => {
      if (event.type === "order") api<Order>(`/orders/${event.id}`).then(put, () => undefined);
      else api<DiningTable[]>("/tables").then(setTables, () => undefined);
    },
  );

  // In service = open accounts plus paid ones whose food has not reached the table yet.
  const inService = Object.values(orders).filter((o) => isOpen(o) || toServe(o));
  // The open account first: a paid table can order again while its first rounds are still cooking.
  const tableOrders = (tableId: string) => inService.filter((o) => o.table_id === tableId).sort((a, b) => Number(isOpen(b)) - Number(isOpen(a)));
  const table = selected && "table" in selected ? tables?.find((t) => t.id === selected.table) : undefined;
  const picked = selected && "order" in selected ? orders[selected.order] : undefined;
  const here = picked ? [picked].filter((o) => isOpen(o) || toServe(o)) : table ? tableOrders(table.id) : [];
  const account = here.find(isOpen);
  const served = here.filter((o) => !isOpen(o));
  const pickups = inService.filter((o) => o.order_type === "PICKUP").sort((a, b) => a.order_number - b.order_number);
  const hasSelection = selected !== null && (!picked || here.length > 0);
  // A table with two orders ready still counts once.
  const ready = readyCount(inService);
  useEffect(() => onReady?.(ready), [onReady, ready]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const select = (next: Selection, compose = false) => {
    const go = () => {
      setSelected(next);
      setDraft([]);
      setError(null);
      setComposing(compose);
      setMobilePanel(!compose && next !== null);
    };
    if (draft.length) {
      setConfirm({
        title: "¿Descartar los productos sin enviar?",
        body: `Hay ${draft.length === 1 ? "1 producto" : `${draft.length} productos`} que todavía no se enviaron a cocina.`,
        action: "Descartar",
        run: go,
      });
    } else go();
  };

  const send = () =>
    run(async () => {
      const items = draft.map((l) => ({
        product_id: l.item.id,
        quantity: l.quantity,
        modifiers: l.picks.map(({ group, option }) => ({ group, option })),
        ...(l.notes ? { notes: l.notes } : {}),
      }));
      const saved = account
        ? await api<Order>(`/orders/${account.id}/items`, "POST", { items })
        : await api<Order>("/orders", "POST", table ? { order_type: "DINE_IN", table_id: table.id, items } : { order_type: "PICKUP", items });
      put(saved);
      setDraft([]);
      setComposing(false);
      setMobilePanel(true);
      if (!table) setSelected({ order: saved.id });
    });

  // The dialog shows the API's error (wrong PIN…) and stays open; it closes only when the void is done.
  const voidItem = (item: OrderItem) => {
    const orderId = account!.id;
    setVoiding({
      title: `Anular ${item.quantity} × ${item.products.name}`,
      body: "Queda tachada en la cuenta, el total baja en lo que sumaba y cocina la ve anulada.",
      action: "Anular",
      run: async (data) => {
        put(await api<Order>(`/orders/${orderId}/items/${item.id}/void`, "POST", data));
        setVoiding(null);
      },
    });
  };

  const cancel = () => {
    const orderId = account!.id;
    setVoiding({
      title: `Anular la cuenta de ${table?.name ?? `pedido #${account!.order_number}`}`,
      body: "Se cancela sin cobrar y no se descuenta inventario.",
      action: "Anular cuenta",
      run: async (data) => {
        put(await api<Order>(`/orders/${orderId}/cancel`, "POST", data));
        setVoiding(null);
        setSelected(null);
        setMobilePanel(false);
      },
    });
  };

  const setRound = (orderId: string, roundId: string, status: OrderRound["status"]) =>
    setOrders((all) => ({
      ...all,
      [orderId]: { ...all[orderId], order_rounds: all[orderId].order_rounds.map((r) => (r.id === roundId ? { ...r, status } : r)) },
    }));

  const deliver = (order: Order, round: OrderRound) =>
    run(async () => {
      const orderId = order.id;
      await api(`/kitchen/rounds/${round.id}`, "PUT", { status: "DELIVERED" });
      setRound(orderId, round.id, "DELIVERED");
      setUndo({
        message: `${order.dining_tables?.name ?? `Para llevar #${order.order_number}`} · ronda ${round.round}: entregada`,
        run: () =>
          run(async () => {
            await api(`/kitchen/rounds/${round.id}`, "PUT", { status: "READY", from: "DELIVERED" });
            setRound(orderId, round.id, "READY");
          }),
      });
    });

  const setTableStatus = (status: "FREE" | "RESERVED") =>
    run(async () => {
      const saved = await api<DiningTable>(`/tables/${table!.id}/status`, "PUT", { status });
      setTables((all) => all?.map((t) => (t.id === saved.id ? saved : t)) ?? null);
    });

  if (loadError && !tables) {
    return (
      <p role="alert" className="rounded-panel border border-line bg-surface px-5 py-10 text-center text-[15px] text-danger">
        {loadError}
      </p>
    );
  }

  const title = table?.name ?? (here[0] ? `Para llevar #${here[0].order_number}` : "Para llevar");
  const subtitle = account
    ? `Pedido #${account.order_number} · abierta hace ${elapsed(account.created_at, now)}`
    : served.length && !table
      ? "Pagado · falta entregar"
      : table
      ? `${STATUS_LABEL[table.status]} · ${table.capacity} puestos`
      : "Pedido nuevo";
  const charged = charging ? orders[charging] : undefined;

  return (
    <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start lg:gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
      <div className={mobilePanel ? "hidden lg:block" : ""}>
        {composing ? (
          <>
            <div className="mb-4 flex items-center gap-3">
              <button type="button" onClick={() => setComposing(false)} className={`${button.ghost} -ml-3 pl-2.5`}>
                <ArrowLeft size={18} strokeWidth={2.25} aria-hidden />
                Mesas
              </button>
              <p className="truncate text-sm text-muted">
                Agregando a <span className="font-medium text-ink-2">{title}</span>
              </p>
            </div>
            <MenuPicker
              menu={menu}
              categories={categories}
              onAdd={(line) => {
                const same = draft.find((l) => l.item.id === line.item.id && !l.picks.length && !l.notes && !line.picks.length && !line.notes);
                setDraft(
                  same
                    ? draft.map((l) => (l === same ? { ...l, quantity: Math.min(99, l.quantity + line.quantity) } : l))
                    : [...draft, { ...line, key: crypto.randomUUID() }],
                );
              }}
            />
            {draft.length > 0 && (
              <div className="sticky bottom-[calc(76px+env(safe-area-inset-bottom))] mt-6 sm:bottom-4 lg:hidden">
                <button type="button" onClick={() => setMobilePanel(true)} className={`${button.primary} w-full border border-transparent shadow-panel`}>
                  Ver cuenta · {draft.reduce((n, l) => n + l.quantity, 0)} por enviar ·{" "}
                  {cop(draft.reduce((sum, l) => sum + linePrice(l), 0))}
                </button>
              </div>
            )}
          </>
        ) : (
          <FloorMap
            tables={tables}
            floors={floors}
            tableOrders={tableOrders}
            pickups={pickups}
            selected={selected}
            now={now}
            canOrder={canOrder}
            canEdit={canEdit}
            onSelect={(next) => select(next)}
            onPickup={() => select({ pickup: true }, true)}
          />
        )}
      </div>

      <div className={mobilePanel ? "" : "hidden lg:block"}>
        {hasSelection ? (
          <AccountPanel
            title={title}
            subtitle={subtitle}
            order={account}
            served={served}
            draft={draft}
            onDraft={setDraft}
            canOrder={canOrder}
            // A paid counter order only waits to be handed over; new products would start another order.
            canAdd={canOrder && !(picked && !account)}
            canCharge={canCharge}
            canVoid={canOrder}
            composing={composing}
            busy={busy}
            error={error}
            onBack={() => (composing ? setMobilePanel(false) : select(null))}
            onCompose={() => {
              setComposing(true);
              setMobilePanel(false);
            }}
            onSend={send}
            onCharge={() => setCharging(account!.id)}
            onVoid={voidItem}
            onCancel={cancel}
            onDeliver={deliver}
            extra={
              table && !here.length && canOrder ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setTableStatus(table.status === "RESERVED" ? "FREE" : "RESERVED")}
                  className={button.ghost}
                >
                  {table.status === "RESERVED" ? "Quitar reserva" : "Marcar reservada"}
                </button>
              ) : undefined
            }
          />
        ) : (
          <p className="hidden rounded-panel border border-dashed border-line-strong px-5 py-10 text-center text-[15px] text-muted lg:block">
            Elige una mesa para ver su cuenta.
          </p>
        )}
      </div>

      <Dialog open={charged !== undefined} onClose={() => setCharging(null)} title={charged ? `Cobrar · ${charged.dining_tables?.name ?? `Pedido #${charged.order_number}`}` : ""}>
        {charged && (
          <ChargeForm
            order={charged}
            onChange={put}
            onDone={() => {
              setCharging(null);
              setSelected(null);
              setMobilePanel(false);
            }}
          />
        )}
      </Dialog>

      <Dialog open={confirm !== null} onClose={() => setConfirm(null)} title={confirm?.title ?? ""}>
        {confirm && (
          <div>
            <p className="text-[15px] text-ink-2">{confirm.body}</p>
            <div className="mt-6 flex justify-end gap-2">
              <button type="button" onClick={() => setConfirm(null)} className={button.secondary}>
                Volver
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirm(null);
                  void confirm.run();
                }}
                className={button.danger}
              >
                {confirm.action}
              </button>
            </div>
          </div>
        )}
      </Dialog>

      <Dialog open={voiding !== null} onClose={() => setVoiding(null)} title={voiding?.title ?? ""}>
        {voiding && (
          <VoidForm
            key={voiding.title}
            body={voiding.body}
            action={voiding.action}
            onSubmit={voiding.run}
            onBack={() => setVoiding(null)}
          />
        )}
      </Dialog>

      <UndoToast undo={undo} onClose={() => setUndo(null)} />
    </div>
  );
}

type Filter = "all" | "free" | "busy" | "ready" | "pickup";
type TableState = "free" | "occupied" | "paid" | "reserved" | "ready";

/** Base band ("zócalo") of each table card: says the state in words, colour backs it up (DESIGN.md). */
const BAND: Record<TableState, { label: string; icon: LucideIcon; card: string; band: string }> = {
  free: { label: "Libre", icon: Plus, card: "border-dashed border-line-strong bg-transparent", band: "bg-success-soft text-success" },
  occupied: { label: "Ocupada", icon: ReceiptText, card: "border-line bg-surface", band: "bg-accent text-white" },
  paid: { label: "Pagada", icon: ReceiptText, card: "border-line bg-surface", band: "bg-accent text-white" },
  reserved: { label: "Reservada", icon: Clock, card: "border-reserved bg-surface", band: "bg-reserved-soft text-reserved" },
  ready: { label: "Lista para servir", icon: ConciergeBell, card: "border-2 border-ready bg-surface", band: "band-sheen bg-ready text-ready-ink" },
};

function Bell() {
  return (
    <span aria-hidden className="bell-ring relative grid size-11 shrink-0 place-items-center rounded-full bg-ready-soft text-ready-ink">
      <ConciergeBell size={24} strokeWidth={2.25} />
    </span>
  );
}

const chip =
  "inline-flex h-[38px] items-center justify-center gap-2 rounded-full border px-3.5 text-sm font-semibold whitespace-nowrap transition-[background-color,border-color,color] duration-150 max-[853px]:h-10 max-[853px]:flex-auto";

function FloorMap({
  tables,
  floors,
  tableOrders,
  pickups,
  selected,
  now,
  canOrder,
  canEdit,
  onSelect,
  onPickup,
}: {
  tables: DiningTable[] | null;
  floors: Floor[];
  tableOrders: (tableId: string) => Order[];
  pickups: Order[];
  selected: Selection;
  now: number;
  canOrder: boolean;
  canEdit: boolean;
  onSelect: (next: Selection) => void;
  onPickup: () => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  if (!tables) {
    return (
      <p role="status" className="py-10 text-center text-[15px] text-muted">
        Cargando mesas…
      </p>
    );
  }
  const stateOf = (t: DiningTable): TableState => {
    const onTable = tableOrders(t.id);
    if (onTable.some(hasReady)) return "ready";
    if (onTable.length) return onTable.some(isOpen) ? "occupied" : "paid";
    return t.status === "RESERVED" ? "reserved" : "free";
  };
  const states = new Map(tables.map((t) => [t.id, stateOf(t)]));
  const isFree = (t: DiningTable) => ["free", "reserved"].includes(states.get(t.id)!);
  const readyPickups = pickups.filter(hasReady);
  const filters: { id: Filter; label: string; n: number }[] = [
    { id: "all", label: "Todas", n: tables.length },
    { id: "free", label: "Libres", n: tables.filter(isFree).length },
    { id: "busy", label: "Ocupadas", n: tables.filter((t) => !isFree(t)).length },
    { id: "ready", label: "Para servir", n: tables.filter((t) => states.get(t.id) === "ready").length + readyPickups.length },
    { id: "pickup", label: "Para llevar", n: pickups.length },
  ];
  const shows = (t: DiningTable) =>
    filter === "all" || (filter === "free" && isFree(t)) || (filter === "busy" && !isFree(t)) || (filter === "ready" && states.get(t.id) === "ready");
  const shownPickups = filter === "pickup" || filter === "all" ? pickups : filter === "ready" ? readyPickups : [];
  const groups = [
    ...floors.map((f) => ({ id: f.id, name: f.name, tables: tables.filter((t) => t.floor_id === f.id) })),
    { id: "none", name: floors.length ? "Sin zona" : "", tables: tables.filter((t) => !t.floor_id || !floors.some((f) => f.id === t.floor_id)) },
  ].filter((g) => g.tables.length);
  const isSelected = (sel: Selection) => JSON.stringify(sel) === JSON.stringify(selected);
  const shownTables = filter === "pickup" ? [] : tables.filter(shows);

  return (
    <div className="max-[853px]:pb-20">
      <div className="mb-6 flex items-start gap-3">
        {/* Up to 852px the filters take the whole row and "Para llevar" floats (see the button below). */}
        <div role="group" aria-label="Filtrar" className="flex min-w-0 flex-1 flex-wrap gap-2 max-[853px]:gap-1.5">
          {filters.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
              className={`${chip} ${filter === f.id ? "border-ink bg-ink text-white" : "border-line-strong bg-surface text-ink-2 hover:border-muted"}`}
            >
              {f.id === "ready" && <span aria-hidden className="size-2 rounded-full bg-ready" />}
              {f.label}
              <span className="figures font-bold opacity-70">{f.n}</span>
            </button>
          ))}
        </div>
        {canEdit && (
          <Link href="/mesas/editar" aria-label="Editar mesas" title="Editar mesas" className={`${button.ghost} h-10 px-3 max-sm:hidden`}>
            <Pencil size={18} strokeWidth={2.25} aria-hidden />
          </Link>
        )}
        {canOrder && (
          <button
            type="button"
            onClick={onPickup}
            className={`${button.secondary} h-10 pl-3 max-[853px]:fixed max-[853px]:right-5 max-[853px]:bottom-6 max-[853px]:z-30 max-[853px]:h-[52px] max-[853px]:rounded-full max-[853px]:border-transparent max-[853px]:bg-accent max-[853px]:pr-5 max-[853px]:pl-4 max-[853px]:text-white max-[853px]:shadow-panel max-[853px]:hover:enabled:bg-accent-strong max-[853px]:hover:enabled:text-white max-sm:right-4 max-sm:bottom-[calc(84px+env(safe-area-inset-bottom))]`}
          >
            <ShoppingBag size={18} strokeWidth={2.25} aria-hidden />
            Para llevar
          </button>
        )}
      </div>

      {!tables.length && (
        <p className="rounded-panel border border-line bg-surface px-5 py-10 text-center text-[15px] text-muted">
          Esta sede todavía no tiene mesas.{canEdit && " Agrégalas con el lápiz de “Editar mesas”."}
        </p>
      )}
      {tables.length > 0 && !shownTables.length && !shownPickups.length && (
        <p className="rounded-panel border border-dashed border-line-strong px-5 py-10 text-center text-[15px] text-muted">
          {filter === "pickup" ? "Sin pedidos para llevar en curso." : "Ninguna mesa con este filtro."}
        </p>
      )}

      {groups.map((group) => {
        const shown = group.tables.filter((t) => shownTables.includes(t));
        if (!shown.length) return null;
        return (
          <section key={group.id} aria-label={group.name || "Mesas"} className="mb-8">
            {group.name && (
              <h3 className="mb-3 flex items-baseline gap-2.5 font-display text-[17px] font-semibold tracking-[-0.01em]">
                {group.name}
                <small className="figures font-sans text-[13.5px] font-medium text-muted">
                  {group.tables.filter((t) => !isFree(t)).length} de {group.tables.length} ocupadas
                </small>
              </h3>
            )}
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(156px,1fr))] gap-3.5 max-sm:grid-cols-2 max-sm:gap-2.5">
              {shown.map((t) => {
                const order = tableOrders(t.id)[0];
                const state = states.get(t.id)!;
                const { label, icon: Icon, card, band } = BAND[state];
                const pressed = isSelected({ table: t.id });
                return (
                  <li key={t.id}>
                    <button
                      type="button"
                      aria-pressed={pressed}
                      onClick={() => onSelect({ table: t.id })}
                      className={`flex h-full min-h-[150px] w-full flex-col overflow-hidden rounded-panel border-[1.5px] text-left transition-[border-color,translate,box-shadow] duration-200 ease-(--ease-out) hover:border-line-strong motion-safe:hover:-translate-y-0.5 ${card} ${
                        pressed ? `ring-[3px] ${state === "ready" ? "ring-ready-soft" : "border-accent! ring-accent-soft"}` : ""
                      }`}
                    >
                      <span className="flex flex-1 flex-col px-3.5 pt-3 pb-2.5">
                        <span className="flex items-start justify-between gap-2">
                          <span className="min-w-0">
                            <span
                              className={`figures block font-display text-[40px] leading-none font-[750] tracking-[-0.03em] [font-variation-settings:'opsz'_72] ${
                                state === "free" ? "text-muted" : "text-ink"
                              }`}
                            >
                              {t.number}
                            </span>
                            {t.name !== `Mesa #${t.number}` && <span className="mt-1 block truncate text-[12.5px] font-semibold text-muted">{t.name}</span>}
                          </span>
                          {state === "ready" ? (
                            <Bell />
                          ) : (
                            <span className="figures flex items-center gap-1 text-[13px] font-semibold text-muted">
                              <Users size={14} aria-hidden />
                              <span className="sr-only">Puestos:</span>
                              {t.capacity}
                            </span>
                          )}
                        </span>
                        {order && (
                          <span className="figures mt-auto flex justify-between gap-2 pt-2.5 text-[13.5px] whitespace-nowrap text-ink-2">
                            <span className="flex items-center gap-1">
                              <Clock size={14} aria-hidden />
                              {order.payment_status === "PENDING_QR" ? "QR pendiente" : elapsed(order.created_at, now)}
                            </span>
                            <b className="font-bold text-ink">{cop(order.total_cop)}</b>
                          </span>
                        )}
                      </span>
                      <span className={`flex h-9 shrink-0 items-center gap-2 px-3.5 text-[13.5px] font-bold ${band}`}>
                        <Icon size={16} strokeWidth={2.5} aria-hidden />
                        <span className="truncate">{label}</span>
                        {order && state !== "ready" && <span className="figures ml-auto">#{order.order_number}</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}

      {shownPickups.length > 0 && (
        <section aria-label="Para llevar">
          <h3 className="mb-3 font-display text-[17px] font-semibold tracking-[-0.01em]">Para llevar</h3>
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-2.5 max-sm:grid-cols-1">
            {shownPickups.map((o) => {
              const ready = hasReady(o);
              const pressed = isSelected({ order: o.id });
              return (
                <li key={o.id}>
                  <button
                    type="button"
                    aria-pressed={pressed}
                    onClick={() => onSelect({ order: o.id })}
                    className={`grid min-h-[72px] w-full grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-3 rounded-panel bg-surface px-3.5 py-3 text-left transition-[border-color] duration-150 hover:border-line-strong ${
                      ready ? "border-2 border-ready" : "border-[1.5px] border-line"
                    } ${pressed ? `ring-[3px] ${ready ? "ring-ready-soft" : "border-accent! ring-accent-soft"}` : ""}`}
                  >
                    {ready ? (
                      <Bell />
                    ) : (
                      <span aria-hidden className="grid size-11 place-items-center rounded-full bg-ground text-ink-2">
                        <ShoppingBag size={20} />
                      </span>
                    )}
                    <span className="grid min-w-0 gap-0.5">
                      <b className="figures truncate font-display text-[17px] font-bold">Pedido #{o.order_number}</b>
                      <span className="figures text-[13.5px] text-muted">
                        {o.payment_status === "PENDING_QR"
                          ? "QR pendiente"
                          : isOpen(o)
                            ? units(liveItems(o.order_items).reduce((n, i) => n + i.quantity, 0))
                            : "Pagado"}{" "}
                        · hace {elapsed(o.created_at, now)}
                      </span>
                    </span>
                    <span className="grid justify-items-end gap-1">
                      <b className="figures text-base font-bold">{cop(o.total_cop)}</b>
                      <span className={`rounded-full px-2.5 py-0.5 text-[12.5px] font-bold whitespace-nowrap ${ready ? "bg-ready text-ready-ink" : "bg-accent-soft text-accent"}`}>
                        {ready ? "Listo para entregar" : "En cocina"}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {/* Phone: the filters need the whole row, so the edit link moves to the end of the map. */}
      {canEdit && (
        <Link href="/mesas/editar" className={`${button.ghost} mt-6 w-full sm:hidden`}>
          <Pencil size={18} strokeWidth={2.25} aria-hidden />
          Editar mesas
        </Link>
      )}
    </div>
  );
}
