"use client";

import { ArrowLeft, Check, LoaderCircle, X } from "lucide-react";
import { button } from "@/components/ui";
import { cop } from "@/lib/format";
import { liveItems, type Order, type OrderItem, type OrderRound, VOID_REASONS } from "@/lib/pos";
import { type DraftLine, linePrice, Stepper } from "./menu-picker";

const modifiersOf = (picks: { option: string }[]) => picks.map((p) => p.option).join(" · ");

/** Kitchen state of a round as the floor reads it; ready is the one that asks for action. */
const ROUND_STATE = {
  PENDING: { label: "En cola", className: "bg-ground text-muted" },
  PREPARING: { label: "En preparación", className: "bg-ground text-ink-2" },
  READY: { label: "Lista para servir", className: "bg-success-soft text-success" },
  DELIVERED: { label: "Entregada", className: "text-muted" },
} as const;

/** Open account of a table or a counter order: sent rounds, the round being composed and the actions. */
export function AccountPanel({
  title,
  subtitle,
  order,
  draft,
  onDraft,
  canOrder,
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
}: {
  title: string;
  subtitle: string;
  order?: Order;
  draft: DraftLine[];
  onDraft: (lines: DraftLine[]) => void;
  canOrder: boolean;
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
  onDeliver: (round: OrderRound) => void;
  extra?: React.ReactNode;
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
      className="flex flex-col rounded-panel border border-line bg-surface lg:sticky lg:top-[88px] lg:max-h-[calc(100dvh-112px)]"
    >
      <header className="flex items-start gap-2 border-b border-line px-5 py-4">
        <button
          type="button"
          onClick={onBack}
          aria-label="Volver a las mesas"
          className="-ml-2 flex size-10 shrink-0 items-center justify-center rounded-control text-ink-2 transition-[background-color] duration-150 hover:bg-ground lg:hidden"
        >
          <ArrowLeft size={20} aria-hidden />
        </button>
        <div className="min-w-0 flex-1 pt-0.5">
          <h2 className="truncate text-lg font-semibold tracking-[-0.01em]">{title}</h2>
          <p className="text-sm text-muted">{subtitle}</p>
        </div>
        {pendingQr && (
          <span className="mt-1 shrink-0 rounded-full bg-warning-soft px-2.5 py-1 text-xs font-medium text-warning">QR pendiente</span>
        )}
      </header>

      <div className="min-h-32 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
        {[...rounds].map(([round, items]) => (
          <div key={round} className="mb-5 last:mb-0">
            <RoundHeading round={round} kitchen={kitchenState(round)} canDeliver={canOrder} busy={busy} onDeliver={onDeliver} />
            <ul className="space-y-3">
              {items.map((item) => (
                <li key={item.id} className={`flex items-start gap-3 ${item.voided_at ? "text-muted" : ""}`}>
                  <span className={`figures w-7 shrink-0 pt-px text-[15px] font-medium ${item.voided_at ? "line-through" : "text-ink-2"}`}>
                    {item.quantity}×
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className={`text-[15px] leading-snug ${item.voided_at ? "line-through" : ""}`}>{item.products.name}</p>
                    {item.voided_at ? (
                      <p className="text-sm">
                        Anulada · {item.void_reason === "OTHER" ? item.void_note : item.void_reason && VOID_REASONS[item.void_reason]}
                        {item.void_authorizer && ` · autorizó ${item.void_authorizer.full_name}`}
                      </p>
                    ) : (
                      <>
                        {item.selected_modifiers.length > 0 && <p className="text-sm text-muted">{modifiersOf(item.selected_modifiers)}</p>}
                        {item.notes && <p className="text-sm text-muted">Nota: {item.notes}</p>}
                      </>
                    )}
                  </div>
                  <span className={`figures pt-px text-[15px] ${item.voided_at ? "line-through" : ""}`}>
                    {cop(Number(item.unit_price_cop) * item.quantity)}
                  </span>
                  {canVoid && !pendingQr && !item.voided_at && (
                    <button
                      type="button"
                      onClick={() => onVoid(item)}
                      aria-label={`Anular ${item.quantity} × ${item.products.name}`}
                      className="-my-2 -mr-2 flex size-10 shrink-0 items-center justify-center rounded-control text-muted transition-[background-color,color] duration-150 hover:bg-danger-soft hover:text-danger"
                    >
                      <X size={18} aria-hidden />
                    </button>
                  )}
                </li>
              ))}
            </ul>
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

        {!order && !draft.length && (
          <p className="py-6 text-center text-[15px] text-muted">
            {canOrder ? "Agrega productos para abrir la cuenta." : "Sin cuenta abierta."}
          </p>
        )}
      </div>

      <footer className="space-y-3 border-t border-line px-5 py-4">
        {order && (
          <div className="flex items-end justify-between gap-3">
            <span>
              <span className="block text-[15px] font-medium">Total</span>
              <span className="figures block text-xs text-muted">Incluye {cop(order.tax_cop)} de impuestos</span>
            </span>
            <span className="figures text-xl font-semibold tracking-[-0.01em]">{cop(order.total_cop)}</span>
          </div>
        )}

        {error && (
          <p role="alert" className="rounded-control bg-danger-soft px-3 py-2.5 text-sm text-danger">
            {error}
          </p>
        )}

        {draft.length > 0 ? (
          <div className="flex gap-2">
            <button type="button" onClick={() => onDraft([])} disabled={busy} className={button.ghost}>
              Descartar
            </button>
            <button type="button" onClick={onSend} disabled={busy} className={`${button.primary} flex-1`}>
              {busy && <LoaderCircle size={18} className="animate-spin motion-reduce:[animation-duration:6s]" aria-hidden />}
              Enviar a cocina · {cop(draftTotal)}
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {canOrder && !pendingQr && !composing && (
              <button type="button" onClick={onCompose} className={`${button.secondary} flex-1`}>
                Agregar productos
              </button>
            )}
            {canCharge && order && liveItems(order.order_items).length > 0 && (
              <button type="button" onClick={onCharge} className={`${button.primary} flex-1`}>
                {pendingQr ? "Ver QR de pago" : `Cobrar ${cop(order.total_cop)}`}
              </button>
            )}
          </div>
        )}

        {(extra || (canVoid && order && !draft.length)) && (
          <div className="flex flex-wrap items-center justify-between gap-2">
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

function RoundHeading({
  round,
  kitchen,
  canDeliver,
  busy,
  onDeliver,
}: {
  round: number;
  kitchen?: OrderRound;
  canDeliver: boolean;
  busy: boolean;
  onDeliver: (round: OrderRound) => void;
}) {
  const state = kitchen && ROUND_STATE[kitchen.status];
  return (
    <div className="mb-2 flex min-h-8 items-center gap-2">
      <h3 className="text-sm font-semibold text-ink-2">Ronda {round}</h3>
      {state && (
        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${state.className}`}>
          {kitchen.status === "DELIVERED" && <Check size={14} strokeWidth={2.25} aria-hidden />}
          {state.label}
        </span>
      )}
      {canDeliver && kitchen?.status === "READY" && (
        <button type="button" disabled={busy} onClick={() => onDeliver(kitchen)} className={`${button.ghost} -my-1 -mr-2 ml-auto h-10! px-3 text-sm!`}>
          Marcar entregada
        </button>
      )}
    </div>
  );
}
