"use client";

import { Clock, LoaderCircle } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useNow } from "@/components/pos/service";
import { button } from "@/components/ui";
import { errorMessage, useApi } from "@/lib/api";
import { elapsed } from "@/lib/format";
import { useLive } from "@/lib/live";
import type { KitchenRound, RoundStatus } from "@/lib/pos";

const LANES = [
  { status: "PENDING", title: "Por preparar", empty: "Nada en cola.", action: "Empezar", next: "PREPARING" },
  { status: "PREPARING", title: "En preparación", empty: "Nada en preparación.", action: "Marcar lista", next: "READY" },
  { status: "READY", title: "Listas para servir", empty: "Nada esperando.", action: "Entregada", next: "DELIVERED" },
] as const satisfies { status: KitchenRound["status"]; title: string; empty: string; action: string; next: RoundStatus }[];

type Lane = (typeof LANES)[number];

const where = (r: KitchenRound) => r.orders.dining_tables?.name ?? `Para llevar #${r.orders.order_number}`;

/**
 * Kitchen screen (KDS): one ticket per round, oldest first, in three lanes. Every terminal of the location
 * stays in sync over SSE; any order event reloads the board (one small query).
 */
export function KitchenBoard() {
  const api = useApi();
  const now = useNow();
  const [rounds, setRounds] = useState<KitchenRound[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);

  const load = useCallback(async () => {
    // Events can overlap: only the newest request may paint the board.
    const request = ++latest.current;
    try {
      const fresh = await api<KitchenRound[]>("/kitchen/rounds");
      if (request === latest.current) setRounds(fresh);
    } catch (err) {
      if (request === latest.current) setError(errorMessage(err));
    }
  }, [api]);

  useLive(
    () => void load(),
    (event) => event.type === "order" && void load(),
  );

  const advance = async (round: KitchenRound, next: RoundStatus) => {
    setBusy(round.id);
    setError(null);
    try {
      await api(`/kitchen/rounds/${round.id}`, "PUT", { status: next });
      setRounds((all) =>
        next === "DELIVERED"
          ? (all?.filter((r) => r.id !== round.id) ?? null)
          : (all?.map((r) => (r.id === round.id ? { ...r, status: next } : r)) ?? null),
      );
    } catch (err) {
      // Another terminal moved it or the order was cancelled: say why and catch up.
      setError(errorMessage(err));
      void load();
    } finally {
      setBusy(null);
    }
  };

  if (!rounds) {
    return error ? (
      <p role="alert" className="rounded-panel border border-line bg-surface px-5 py-10 text-center text-[15px] text-danger">
        {error}
      </p>
    ) : (
      <p role="status" className="py-10 text-center text-[15px] text-muted">
        Cargando comandas…
      </p>
    );
  }

  return (
    <div>
      {error && (
        <p role="alert" className="mb-5 rounded-control bg-danger-soft px-3 py-2.5 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="grid gap-8 lg:grid-cols-3 lg:gap-5">
        {LANES.map((lane) => {
          const tickets = rounds.filter((r) => r.status === lane.status);
          return (
            <section key={lane.status} aria-labelledby={`lane-${lane.status}`}>
              <h2 id={`lane-${lane.status}`} className="mb-3 flex items-baseline gap-2 text-sm font-semibold text-ink-2">
                {lane.title}
                <span className="figures font-normal text-muted">{tickets.length}</span>
              </h2>
              {tickets.length ? (
                <ul className="space-y-3">
                  {tickets.map((r) => (
                    <li key={r.id}>
                      <Ticket round={r} lane={lane} now={now} busy={busy === r.id} onAdvance={() => void advance(r, lane.next)} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="rounded-panel border border-dashed border-line-strong px-4 py-8 text-center text-[15px] text-muted">{lane.empty}</p>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function Ticket({ round, lane, now, busy, onAdvance }: { round: KitchenRound; lane: Lane; now: number; busy: boolean; onAdvance: () => void }) {
  return (
    <article aria-label={`${where(round)}, ronda ${round.round}`} className="rounded-panel border border-line bg-surface">
      {/* Title on its own line: three lanes beside the sidebar leave ~200px per ticket on a 1024px tablet. */}
      <header className="border-b border-line px-4 py-3">
        <h3 className="text-xl font-semibold tracking-[-0.01em] text-balance">{where(round)}</h3>
        <div className="figures mt-0.5 flex items-center justify-between gap-3">
          <p className="text-sm text-muted">Ronda {round.round}</p>
          <p className="flex items-center gap-1.5 text-[15px] font-medium text-ink-2">
            <Clock size={18} strokeWidth={2.25} aria-hidden />
            <span className="sr-only">Enviada hace</span>
            {elapsed(round.created_at, now)}
          </p>
        </div>
      </header>
      <ul className="space-y-3 px-4 py-4">
        {round.order_items.map((item) => (
          <li key={item.id} className="flex items-start gap-3">
            <span className="figures w-8 shrink-0 text-lg font-semibold">{item.quantity}×</span>
            <div className="min-w-0 flex-1">
              <p className="text-lg leading-snug font-medium">{item.products.name}</p>
              {item.selected_modifiers.length > 0 && (
                <p className="text-[15px] text-ink-2">{item.selected_modifiers.map((m) => m.option).join(" · ")}</p>
              )}
              {item.notes && <p className="mt-1 rounded-control bg-warning-soft px-2 py-1 text-[15px] font-medium text-warning">{item.notes}</p>}
            </div>
          </li>
        ))}
      </ul>
      <div className="px-4 pb-4">
        <button
          type="button"
          disabled={busy}
          onClick={onAdvance}
          // Bigger than the 44px default: tapped with wet hands, read from across the kitchen. Blue only for
          // "Marcar lista", the step the floor waits for (One Blue Rule).
          className={`${lane.status === "PREPARING" ? button.primary : button.secondary} h-14! w-full text-lg!`}
        >
          {busy && <LoaderCircle size={20} className="animate-spin motion-reduce:[animation-duration:6s]" aria-hidden />}
          {lane.action}
        </button>
      </div>
    </article>
  );
}
