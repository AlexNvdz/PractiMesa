"use client";

import { ArrowLeft, Pencil, ShoppingBag, Users } from "lucide-react";
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

/** A round the kitchen finished and nobody has taken to the table yet. */
const hasReady = (o: Order) => o.order_rounds.some((r) => r.status === "READY");
const readyChip = <span className="inline-block rounded-full bg-success-soft px-2 py-0.5 text-xs font-medium text-success">Lista para servir</span>;

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
export function Service({ me }: { me: Me }) {
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
      // Keep closed orders already on screen (a "Pago recibido" being shown); the list only has open ones.
      setOrders((all) => ({
        ...Object.fromEntries(Object.entries(all).filter(([, order]) => !isOpen(order))),
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

  const open = Object.values(orders).filter(isOpen);
  const tableOrder = (tableId: string) => open.find((o) => o.table_id === tableId);
  const table = selected && "table" in selected ? tables?.find((t) => t.id === selected.table) : undefined;
  const order = selected && "order" in selected ? orders[selected.order] : table ? tableOrder(table.id) : undefined;
  const account = order && isOpen(order) ? order : undefined;
  const pickups = open.filter((o) => o.order_type === "PICKUP").sort((a, b) => a.order_number - b.order_number);
  const hasSelection = selected !== null && (!("order" in selected) || account !== undefined);

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

  const deliver = (round: OrderRound) =>
    run(async () => {
      const orderId = account!.id;
      await api(`/kitchen/rounds/${round.id}`, "PUT", { status: "DELIVERED" });
      setRound(orderId, round.id, "DELIVERED");
      setUndo({
        message: `${account!.dining_tables?.name ?? `Para llevar #${account!.order_number}`} · ronda ${round.round}: entregada`,
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

  const title = table?.name ?? (account ? `Para llevar #${account.order_number}` : "Para llevar");
  const subtitle = account
    ? `Pedido #${account.order_number} · abierta hace ${elapsed(account.created_at, now)}`
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
              <div className="sticky bottom-4 mt-6 lg:hidden">
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
            tableOrder={tableOrder}
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
            draft={draft}
            onDraft={setDraft}
            canOrder={canOrder}
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
              table && !account && canOrder ? (
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

function FloorMap({
  tables,
  floors,
  tableOrder,
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
  tableOrder: (tableId: string) => Order | undefined;
  pickups: Order[];
  selected: Selection;
  now: number;
  canOrder: boolean;
  canEdit: boolean;
  onSelect: (next: Selection) => void;
  onPickup: () => void;
}) {
  if (!tables) {
    return (
      <p role="status" className="py-10 text-center text-[15px] text-muted">
        Cargando mesas…
      </p>
    );
  }
  const count = (status: DiningTable["status"]) => tables.filter((t) => t.status === status).length;
  const groups = [
    ...floors.map((f) => ({ id: f.id, name: f.name, tables: tables.filter((t) => t.floor_id === f.id) })),
    { id: "none", name: floors.length ? "Sin zona" : "", tables: tables.filter((t) => !t.floor_id || !floors.some((f) => f.id === t.floor_id)) },
  ].filter((g) => g.tables.length);
  const isSelected = (sel: Selection) => JSON.stringify(sel) === JSON.stringify(selected);

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <p className="figures text-sm text-muted">
          {count("FREE")} libres · {count("OCCUPIED")} ocupadas
          {count("RESERVED") > 0 && ` · ${count("RESERVED")} reservadas`}
        </p>
        <div className="flex gap-2">
          {canEdit && (
            <Link href="/mesas/editar" className={`${button.ghost} pl-3.5`}>
              <Pencil size={18} strokeWidth={2.25} aria-hidden />
              Editar mesas
            </Link>
          )}
          {canOrder && (
            <button type="button" onClick={onPickup} className={`${button.secondary} pl-3.5`}>
              <ShoppingBag size={18} strokeWidth={2.25} aria-hidden />
              Para llevar
            </button>
          )}
        </div>
      </div>

      {!tables.length && (
        <p className="rounded-panel border border-line bg-surface px-5 py-10 text-center text-[15px] text-muted">
          Esta sede todavía no tiene mesas.{canEdit && " Agrégalas en “Editar mesas”."}
        </p>
      )}

      {groups.map((group) => (
        <section key={group.id} aria-label={group.name || "Mesas"} className="mb-8">
          {group.name && <h3 className="mb-3 text-sm font-semibold text-ink-2">{group.name}</h3>}
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
            {group.tables.map((t) => {
              const order = tableOrder(t.id);
              const items = order ? liveItems(order.order_items).reduce((n, i) => n + i.quantity, 0) : 0;
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    aria-pressed={isSelected({ table: t.id })}
                    onClick={() => onSelect({ table: t.id })}
                    className={`flex h-full min-h-28 w-full flex-col rounded-panel border p-4 text-left transition-[background-color,border-color,scale] duration-150 ease-out motion-safe:active:scale-[0.96] aria-pressed:border-accent aria-pressed:bg-accent-soft ${
                      order ? "border-line-strong bg-surface" : "border-line bg-surface hover:not-aria-pressed:bg-ground"
                    }`}
                  >
                    <span className="flex items-start justify-between gap-2">
                      <span className="text-[15px] font-semibold">{t.name}</span>
                      <span className="figures flex items-center gap-1 text-xs text-muted">
                        <Users size={14} aria-hidden />
                        <span className="sr-only">Puestos:</span>
                        {t.capacity}
                      </span>
                    </span>
                    <span className="mt-auto pt-3">
                      {order ? (
                        <>
                          <span className="figures block text-lg font-semibold tracking-[-0.01em]">{cop(order.total_cop)}</span>
                          <span className="figures block text-xs text-muted">
                            {order.payment_status === "PENDING_QR" ? "QR pendiente" : units(items)} · {elapsed(order.created_at, now)}
                          </span>
                          {hasReady(order) && <span className="mt-1.5 block">{readyChip}</span>}
                        </>
                      ) : (
                        <span
                          className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                            t.status === "RESERVED" ? "bg-warning-soft text-warning" : "bg-ground text-muted"
                          }`}
                        >
                          {STATUS_LABEL[t.status]}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      {pickups.length > 0 && (
        <section aria-label="Para llevar">
          <h3 className="mb-3 text-sm font-semibold text-ink-2">Para llevar</h3>
          <ul className="divide-y divide-line rounded-panel border border-line bg-surface">
            {pickups.map((o) => (
              <li key={o.id}>
                <button
                  type="button"
                  aria-pressed={isSelected({ order: o.id })}
                  onClick={() => onSelect({ order: o.id })}
                  className="flex min-h-14 w-full items-center gap-4 px-5 py-3 text-left transition-[background-color] duration-150 first:rounded-t-panel last:rounded-b-panel hover:not-aria-pressed:bg-ground aria-pressed:bg-accent-soft"
                >
                  <span className="figures text-[15px] font-semibold">#{o.order_number}</span>
                  <span className="figures flex-1 text-sm text-muted">
                    {o.payment_status === "PENDING_QR" ? "QR pendiente" : units(liveItems(o.order_items).reduce((n, i) => n + i.quantity, 0))} ·{" "}
                    {elapsed(o.created_at, now)}
                  </span>
                  {hasReady(o) && readyChip}
                  <span className="figures text-[15px] font-medium">{cop(o.total_cop)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
