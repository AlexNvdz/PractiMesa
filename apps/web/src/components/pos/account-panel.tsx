"use client";

import { Check, LoaderCircle, Plus, X } from "lucide-react";
import { button } from "@/components/ui";
import { cop, elapsed } from "@/lib/format";
import { liveItems, type Order, type OrderItem, type OrderRound, roundsToServe, VOID_REASONS } from "@/lib/pos";
import { type DraftLine, linePrice, Stepper } from "./menu-picker";

const modifiersOf = (picks: { option: string }[]) => picks.map((p) => p.option).join(" · ");

/** Kitchen state of a round as the floor reads it; ready is the one that asks for action. */
const ROUND_STATE = {
  PENDING: { label: "En cola", className: "border border-line-strong bg-ground text-ink-2" },
  PREPARING: { label: "En preparación", className: "bg-accent-soft text-accent" },
  READY: { label: "Lista para servir", className: "bg-ready text-ready-ink" },
  DELIVERED: { label: "Entregada", className: "bg-success-soft text-success" },
} as const;

/** Open account of a table or a counter order: sent rounds, the round being composed and the actions. */
export function AccountPanel({
  title,
  subtitle,
  order,
  served,
  draft,
  onDraft,
  canOrder,
  canAdd,
  canCharge,
  canVoid,
  composing,
  busy,
  error,
  onBack,
  onCompose,
  onSend,
  onCharge,
  onVoid,
  onCancel,
  onDeliver,
  extra,
  now,
}: {
  title: string;
  subtitle: string;
  order?: Order;
  /** Paid orders of this table (or counter) with food still to serve: only "Marcar entregada" applies. */
  served: Order[];
  draft: DraftLine[];
  onDraft: (lines: DraftLine[]) => void;
  canOrder: boolean;
  /** Start or extend an account from here (not on a paid counter order). */
  canAdd: boolean;
  canCharge: boolean;
  /** Void lines and cancel the account (cashiers and waiters with a supervisor's PIN). */
  canVoid: boolean;
  composing: boolean;
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onCompose: () => void;
  onSend: () => void;
  onCharge: () => void;
  onVoid: (item: OrderItem) => void;
  onCancel: () => void;
  onDeliver: (order: Order, round: OrderRound) => void;
  extra?: React.ReactNode;
  /** Clock of the screen, for how long ago each round was sent. */
  now: number;
}) {
  const pendingQr = order?.payment_status === "PENDING_QR";
  const rounds = new Map<number, OrderItem[]>();
  for (const item of order?.order_items ?? []) rounds.set(item.round, [...(rounds.get(item.round) ?? []), item]);
  const kitchenState = (round: number) => order?.order_rounds.find((r) => r.round === round);
  const draftTotal = draft.reduce((sum, l) => sum + linePrice(l), 0);
  const update = (key: string, quantity: number) => onDraft(draft.map((l) => (l.key === key ? { ...l, quantity } : l)));

  return (
    <section
      aria-label={`Cuenta: ${title}`}
      className="flex flex-col rounded-[18px] border border-line bg-surface max-[1179px]:min-h-0 max-[1179px]:flex-1 max-[1179px]:rounded-[inherit] max-[1179px]:border-0 min-[1180px]:sticky min-[1180px]:top-[92px] min-[1180px]:max-h-[calc(100dvh-116px)]"
    >
      <header className="flex items-start gap-3 border-b border-line px-5 pt-[18px] pb-3.5">
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-display text-[22px] font-[750] tracking-[-0.02em]">{title}</h2>
          <p className="figures mt-0.5 text-sm text-muted">{subtitle}</p>
        </div>
        {pendingQr && (
          <span className="mt-1 shrink-0 rounded-full bg-warning-soft px-2.5 py-1 text-xs font-bold text-warning">QR pendiente</span>
        )}
        <button
          type="button"
          onClick={onBack}
          aria-label="Cerrar cuenta"
          className="-mt-1 -mr-2 grid size-10 shrink-0 place-items-center rounded-control text-ink-2 transition-[background-color] duration-150 hover:bg-ground min-[1180px]:hidden"
        >
          <X size={20} aria-hidden />
        </button>
      </header>

      <div className="min-h-32 flex-1 overflow-y-auto overscroll-contain px-5 pt-2 pb-3">
        {served.map((paid) => (
          <div key={paid.id}>
            <p className="pt-3.5 text-sm text-muted">
              Pedido #{paid.order_number} · <span className="font-semibold text-success">Pagado</span> · falta servir
            </p>
            {roundsToServe(paid).map((r) => (
              <div key={r.id} className="border-b border-dashed border-line-strong py-3.5 last:border-b-0">
                <RoundHeading round={r.round} kitchen={r} now={now} />
                <ul>
                  {liveItems(paid.order_items)
                    .filter((i) => i.round === r.round)
                    .map((item) => (
                      <li key={item.id} className="figures grid grid-cols-[28px_1fr_auto] gap-2 py-[5px]">
                        <span className="font-bold text-ink-2">{item.quantity}</span>
                        <div className="min-w-0">
                          <p>{item.products.name}</p>
                          {item.selected_modifiers.length > 0 && <p className="text-[13px] text-muted">{modifiersOf(item.selected_modifiers)}</p>}
                        </div>
                        <span>{cop(Number(item.unit_price_cop) * item.quantity)}</span>
                      </li>
                    ))}
                </ul>
                <Deliver round={r} canDeliver={canOrder} busy={busy} onDeliver={(k) => onDeliver(paid, k)} />
              </div>
            ))}
          </div>
        ))}
        {[...rounds].map(([round, items]) => (
          <div key={round} className="border-b border-dashed border-line-strong py-3.5 last:border-b-0">
            <RoundHeading round={round} kitchen={kitchenState(round)} now={now} />
            <ul>
              {items.map((item) => (
                <li key={item.id} className={`figures grid grid-cols-[28px_1fr_auto] gap-2 py-[5px] ${item.voided_at ? "text-muted" : ""}`}>
                  <span className={`font-bold ${item.voided_at ? "" : "text-ink-2"}`}>{item.quantity}</span>
                  <div className="min-w-0">
                    <p>
                      <span className={item.voided_at ? "line-through" : ""}>{item.products.name}</span>
                      {item.voided_at && (
                        <span className="ml-1.5 inline-block -rotate-4 rounded-[4px] border-[1.5px] border-danger px-[5px] text-[11px] font-extrabold tracking-[0.04em] text-danger">ANULADA</span>
                      )}
                    </p>
                    {item.voided_at ? (
                      <p className="text-[13px]">
                        {item.void_reason === "OTHER" ? item.void_note : item.void_reason && VOID_REASONS[item.void_reason]}
                        {item.voider && ` · ${item.voider.full_name}`}
                      </p>
                    ) : (
                      <>
                        {item.selected_modifiers.length > 0 && <p className="text-[13px] text-muted">{modifiersOf(item.selected_modifiers)}</p>}
                        {item.notes && <p className="text-[13px] text-muted">Nota: {item.notes}</p>}
                      </>
                    )}
                  </div>
                  <span className={`flex items-start gap-1 ${item.voided_at ? "line-through" : ""}`}>
                    {cop(Number(item.unit_price_cop) * item.quantity)}
                    {canVoid && !pendingQr && !item.voided_at && (
                      <button
                        type="button"
                        onClick={() => onVoid(item)}
                        aria-label={`Anular ${item.quantity} × ${item.products.name}`}
                        className="-my-2.5 -mr-2 grid size-10 shrink-0 place-items-center rounded-control text-muted transition-[background-color,color] duration-150 hover:bg-danger-soft hover:text-danger"
                      >
                        <X size={16} aria-hidden />
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            <Deliver round={kitchenState(round)} canDeliver={canOrder} busy={busy} onDeliver={(k) => onDeliver(order!, k)} />
          </div>
        ))}

        {draft.length > 0 && (
          <div className={order?.order_items.length ? "mt-5 border-t border-line pt-5" : ""}>
            <h3 className="mb-2 text-sm font-semibold text-ink-2">Por enviar a cocina</h3>
            <ul className="space-y-3">
              {draft.map((line) => (
                <li key={line.key} className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-[15px] leading-snug">{line.item.name}</p>
                    {line.picks.length > 0 && <p className="text-sm text-muted">{modifiersOf(line.picks)}</p>}
                    {line.notes && <p className="text-sm text-muted">Nota: {line.notes}</p>}
                    <p className="figures text-sm text-ink-2">{cop(linePrice(line))}</p>
                  </div>
                  <Stepper
                    value={line.quantity}
                    label={line.item.name}
                    onChange={(n) => update(line.key, n)}
                    onRemove={() => onDraft(draft.filter((l) => l.key !== line.key))}
                  />
                </li>
              ))}
            </ul>
          </div>
        )}

        {!order && !draft.length && !served.length && (
          <div className="px-7 py-12 text-center text-muted">
            <Plus size={56} strokeWidth={1.4} aria-hidden className="mx-auto mb-2.5 text-line-strong" />
            <b className="mb-1 block text-base text-ink-2">{canOrder ? "Mesa libre" : "Sin cuenta abierta"}</b>
            {canOrder ? "Abre una cuenta para enviar la primera ronda a cocina." : "Todavía no hay pedidos aquí."}
          </div>
        )}
      </div>

      <footer className="border-t border-line bg-surface px-5 pt-3.5 pb-[18px]">
        {order && (
          <>
            <p className="figures flex justify-between text-sm text-muted">
              <span>Impuestos incluidos</span>
              <span>{cop(order.tax_cop)}</span>
            </p>
            <p className="figures mt-1.5 mb-3.5 flex items-baseline justify-between">
              <span className="font-[650]">Total</span>
              <span className="font-display text-[28px] font-[750] tracking-[-0.02em]">{cop(order.total_cop)}</span>
            </p>
          </>
        )}

        {error && (
          <p role="alert" className="mb-3 rounded-control bg-danger-soft px-3 py-2.5 text-sm text-danger">
            {error}
          </p>
        )}

        {draft.length > 0 ? (
          <div className="grid grid-cols-[1fr_1.3fr] gap-2.5">
            <button type="button" onClick={() => onDraft([])} disabled={busy} className={button.ghost}>
              Descartar
            </button>
            <button type="button" onClick={onSend} disabled={busy} className={`${button.primary} flex-1`}>
              {busy && <LoaderCircle size={18} className="animate-spin motion-reduce:[animation-duration:6s]" aria-hidden />}
              Enviar a cocina · {cop(draftTotal)}
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-[1fr_1.3fr] gap-2.5 [&>:only-child]:col-span-full">
            {canAdd && !pendingQr && !composing && (
              <button type="button" onClick={onCompose} className={button.secondary}>
                <Plus size={16} aria-hidden />
                {order ? "Agregar" : "Abrir cuenta"}
              </button>
            )}
            {canCharge && order && liveItems(order.order_items).length > 0 && (
              <button type="button" onClick={onCharge} className={button.primary}>
                {pendingQr ? "Ver QR de pago" : `Cobrar ${cop(order.total_cop)}`}
              </button>
            )}
          </div>
        )}

        {(extra || (canVoid && order && !draft.length)) && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            {extra}
            {canVoid && order && !draft.length && (
              <button type="button" onClick={onCancel} className={`${button.quietDanger} ml-auto`}>
                Anular cuenta
              </button>
            )}
          </div>
        )}
      </footer>
    </section>
  );
}

function RoundHeading({ round, kitchen, now }: { round: number; kitchen?: OrderRound; now: number }) {
  const state = kitchen && ROUND_STATE[kitchen.status];
  return (
    <div className="mb-2 flex items-center gap-2">
      <h3 className="text-sm font-bold">Ronda {round}</h3>
      {state && <span className={`rounded-full px-[9px] py-0.5 text-[12.5px] font-bold ${state.className}`}>{state.label}</span>}
      {kitchen && kitchen.status !== "DELIVERED" && (
        <span className="figures ml-auto text-[13px] text-muted">hace {elapsed(kitchen.created_at, now)}</span>
      )}
    </div>
  );
}

/** Handing the round over: full width under its lines, the one yellow button of the account. */
function Deliver({ round, canDeliver, busy, onDeliver }: { round?: OrderRound; canDeliver: boolean; busy: boolean; onDeliver: (round: OrderRound) => void }) {
  if (!canDeliver || round?.status !== "READY") return null;
  return (
    <button type="button" disabled={busy} onClick={() => onDeliver(round)} className={`${button.ready} mt-2.5 w-full`}>
      <Check size={20} aria-hidden />
      Marcar entregada
    </button>
  );
}
