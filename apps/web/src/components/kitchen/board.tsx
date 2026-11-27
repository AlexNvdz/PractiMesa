"use client";

import { Check, Clock, LoaderCircle, Volume2, VolumeX } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNow } from "@/components/pos/service";
import { button } from "@/components/ui";
import { type Undo, UndoToast } from "@/components/undo-toast";
import { errorMessage, useApi } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { elapsed } from "@/lib/format";
import { useLive } from "@/lib/live";
import type { KitchenRound, RoundStatus } from "@/lib/pos";

// `tab` = short name for the phone selector; `count` colours the lane count like the round state.
const LANES = [
  { status: "PENDING", title: "Por preparar", tab: "Nuevas", empty: "Sin comandas aquí.", action: "Empezar", next: "PREPARING", count: "border border-line-strong bg-surface text-ink-2", tabCount: "bg-line text-ink-2" },
  { status: "PREPARING", title: "Preparando", tab: "Preparando", empty: "Sin comandas aquí.", action: "Marcar lista", next: "READY", count: "bg-accent text-white", tabCount: "bg-accent text-white" },
  { status: "READY", title: "Listas para servir", tab: "Listas", empty: "Nada esperando mesero.", action: "Entregada", next: "DELIVERED", count: "bg-ready text-ready-ink", tabCount: "bg-ready text-ready-ink" },
] as const satisfies { status: KitchenRound["status"]; title: string; tab: string; empty: string; action: string; next: RoundStatus; count: string; tabCount: string }[];

type Lane = (typeof LANES)[number];
const DONE = { PREPARING: "en preparación", READY: "lista", DELIVERED: "entregada" } as const;

// shortcut: one threshold for every dish and business; make it a location setting when someone asks for it.
const LATE_MINUTES = 15;
const SOUND_KEY = "pm-kitchen-sound";

/** Two short rising tones made with Web Audio (no file to load). */
function chime(audio: AudioContext) {
  const start = audio.currentTime;
  for (const [i, frequency] of [880, 1320].entries()) {
    const at = start + i * 0.18;
    const tone = audio.createOscillator();
    const volume = audio.createGain();
    tone.frequency.value = frequency;
    volume.gain.setValueAtTime(0.0001, at);
    volume.gain.exponentialRampToValueAtTime(0.3, at + 0.02);
    volume.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
    tone.connect(volume).connect(audio.destination);
    tone.start(at);
    tone.stop(at + 0.17);
  }
}

const where = (r: KitchenRound) => r.orders.dining_tables?.name ?? `Pedido #${r.orders.order_number}`;

/**
 * Kitchen screen (KDS): one ticket per round, oldest first, in three lanes. Every terminal of the location
 * stays in sync over SSE; any order event reloads the board (one small query).
 */
export function KitchenBoard({ readOnly = false }: { readOnly?: boolean }) {
  const api = useApi();
  const now = useNow();
  const { me } = useAuth();
  const locationName = me?.locations.find((l) => l.id === me.current_location_id)?.name ?? "la sede";
  const [rounds, setRounds] = useState<KitchenRound[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  // The board only renders in the browser (after login), so localStorage is there.
  const [sound, setSound] = useState(() => localStorage.getItem(SOUND_KEY) !== "off");
  const [audible, setAudible] = useState(false);
  const audio = useRef<AudioContext | null>(null);
  const seen = useRef<Set<string> | null>(null);
  const [undo, setUndo] = useState<Undo | null>(null);
  // Phone: one lane at a time.
  const [shown, setShown] = useState<Lane["status"]>("PENDING");

  // Browsers keep audio muted until the person interacts with the page; any tap unlocks it.
  useEffect(() => {
    const unlock = () => {
      audio.current ??= new AudioContext();
      void audio.current.resume().then(() => setAudible(audio.current?.state === "running"));
    };
    window.addEventListener("click", unlock);
    return () => window.removeEventListener("click", unlock);
  }, []);

  // A round id the board had not shown before = a new ticket. The first load only takes note.
  useEffect(() => {
    if (!rounds) return;
    const arrived = seen.current !== null && rounds.some((r) => !seen.current!.has(r.id));
    // Union, not replace: a delivered round that an undo brings back is not a new ticket.
    seen.current = new Set([...(seen.current ?? []), ...rounds.map((r) => r.id)]);
    if (arrived && sound && audio.current?.state === "running") chime(audio.current);
  }, [rounds, sound]);

  const toggleSound = () => {
    localStorage.setItem(SOUND_KEY, sound ? "off" : "on");
    setSound(!sound);
  };

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

  const revert = async (round: KitchenRound, from: RoundStatus) => {
    try {
      await api(`/kitchen/rounds/${round.id}`, "PUT", { status: round.status, from });
    } catch (err) {
      setError(errorMessage(err));
    }
    void load();
  };

  const advance = async (round: KitchenRound, next: Lane["next"]) => {
    setBusy(round.id);
    setError(null);
    try {
      await api(`/kitchen/rounds/${round.id}`, "PUT", { status: next });
      setRounds((all) =>
        next === "DELIVERED"
          ? (all?.filter((r) => r.id !== round.id) ?? null)
          : (all?.map((r) => (r.id === round.id ? { ...r, status: next } : r)) ?? null),
      );
      setUndo({ message: `${where(round)} · ronda ${round.round}: ${DONE[next]}`, run: () => revert(round, next) });
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
      <p role="alert" className="pm-card px-5 py-10 text-center text-[15px] text-danger">
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
      <div className="mb-5 flex flex-wrap items-center gap-2.5">
        <p className="mr-auto text-sm text-muted max-sm:basis-full">
          {readOnly ? "Solo vista: la cocina mueve las comandas." : `Comandas de ${locationName}, la más antigua primero.`}
        </p>
        {sound && !audible && <p className="text-sm text-muted">Toca la pantalla una vez para oír las comandas nuevas.</p>}
        <button type="button" aria-pressed={sound} onClick={toggleSound} className={`${button.secondary} pl-3.5`}>
          {sound ? <Volume2 size={16} aria-hidden /> : <VolumeX size={16} aria-hidden />}
          Sonido de comandas
        </button>
      </div>
      {error && (
        <p role="alert" className="mb-5 rounded-control bg-danger-soft px-3 py-2.5 text-sm text-danger">
          {error}
        </p>
      )}
      {/* Phone: pick the lane; the three lanes side by side from 640px (scrolling sideways on narrow tablets). */}
      <div role="group" aria-label="Carril" className="mb-3.5 grid grid-cols-3 gap-1 rounded-[14px] bg-[#e8eae5] p-1 sm:hidden">
        {LANES.map((lane) => (
          <button
            key={lane.status}
            type="button"
            aria-pressed={shown === lane.status}
            onClick={() => setShown(lane.status)}
            className="flex h-11 items-center justify-center gap-1.5 rounded-control text-[13.5px] font-[650] text-ink-2 transition-[background-color,color] duration-150 aria-pressed:bg-surface aria-pressed:text-ink aria-pressed:shadow-[0_1px_2px_rgb(23_30_46/0.1)]"
          >
            {lane.tab}
            <span className={`figures grid h-5 min-w-[22px] place-items-center rounded-full px-1.5 text-xs ${lane.tabCount}`}>
              {rounds.filter((r) => r.status === lane.status).length}
            </span>
          </button>
        ))}
      </div>
      <div className="sm:grid sm:snap-x sm:snap-mandatory sm:grid-cols-[repeat(3,minmax(280px,1fr))] sm:gap-[18px] sm:overflow-x-auto sm:pb-2">
        {LANES.map((lane) => {
          const tickets = rounds.filter((r) => r.status === lane.status);
          return (
            <section key={lane.status} aria-labelledby={`lane-${lane.status}`} className={`min-w-0 snap-start ${shown === lane.status ? "" : "max-sm:hidden"}`}>
              <h2 id={`lane-${lane.status}`} className="mb-3 flex items-center gap-2.5 font-display text-[17px] font-bold tracking-[-0.01em]">
                {lane.title}
                <span className={`figures grid h-6 min-w-[26px] place-items-center rounded-full px-2 font-sans text-[13px] font-bold ${lane.count}`}>{tickets.length}</span>
              </h2>
              {tickets.length ? (
                <ul className="grid gap-3">
                  {tickets.map((r) => (
                    <li key={r.id}>
                      <Ticket round={r} lane={lane} now={now} busy={busy === r.id} onAdvance={readOnly ? undefined : () => void advance(r, lane.next)} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="rounded-panel border-[1.5px] border-dashed border-line-strong px-4 py-7 text-center text-sm text-muted">{lane.empty}</p>
              )}
            </section>
          );
        })}
      </div>
      <UndoToast undo={undo} onClose={() => setUndo(null)} />
    </div>
  );
}

function Ticket({ round, lane, now, busy, onAdvance }: { round: KitchenRound; lane: Lane; now: number; busy: boolean; onAdvance?: () => void }) {
  // Late = still not ready this long after it was sent; ready tickets wait on the floor, not the kitchen.
  const late = round.status !== "READY" && now - Date.parse(round.created_at) >= LATE_MINUTES * 60_000;
  return (
    <article
      aria-label={`${where(round)}, ronda ${round.round}${late ? ", atrasada" : ""}`}
      className={`enter overflow-hidden rounded-panel border-[1.5px] bg-surface ${late ? "border-danger" : "border-line"}`}
    >
      <header className={`flex items-start gap-2.5 border-b px-4 pt-3 pb-2.5 ${late ? "border-danger/20 bg-danger-soft" : "border-line"}`}>
        <div className="min-w-0">
          <h3 className="font-display text-[21px] font-[750] tracking-[-0.02em] text-balance">{where(round)}</h3>
          <p className="mt-px text-[13.5px] text-muted">Ronda {round.round}{round.orders.order_type === "PICKUP" && " · para llevar"}</p>
        </div>
        <p className={`figures ml-auto inline-flex items-center gap-[5px] text-[15px] whitespace-nowrap ${late ? "font-extrabold text-danger" : "font-semibold text-ink-2"}`}>
          <Clock size={16} aria-hidden />
          {late ? "Atrasada · " : <span className="sr-only">Enviada hace </span>}
          {elapsed(round.created_at, now)}
        </p>
      </header>
      <ul className="grid gap-2 px-4 py-3">
        {round.order_items.map((item) =>
          item.voided_at ? (
            // Voided after it was sent (Q62): crossed out so nobody cooks it; the API lists these last.
            <li key={item.id} className="grid grid-cols-[34px_1fr] text-[17px] leading-[1.3] text-muted">
              <span className="figures font-extrabold">{item.quantity}</span>
              <p className="min-w-0">
                <span className="line-through">{item.products.name}</span>
                <span className="ml-1.5 inline-block -rotate-4 rounded-[4px] border-[1.5px] border-danger px-[5px] text-[11px] font-extrabold tracking-[0.04em] text-danger">ANULADA</span>
              </p>
            </li>
          ) : (
            <li key={item.id} className="grid grid-cols-[34px_1fr] text-[17px] leading-[1.3]">
              <span className="figures font-extrabold">{item.quantity}</span>
              <div className="min-w-0">
                <p>{item.products.name}</p>
                {item.selected_modifiers.length > 0 && (
                  <p className="text-sm text-muted">{item.selected_modifiers.map((m) => m.option).join(" · ")}</p>
                )}
                {item.notes && <p className="mt-1 rounded-control bg-warning-soft px-2 py-1 text-[15px] font-medium text-warning">{item.notes}</p>}
              </div>
            </li>
          ),
        )}
      </ul>
      {onAdvance && (
        <div className="px-4 pb-3.5">
          <button
            type="button"
            disabled={busy}
            onClick={onAdvance}
            // As in the prototype: "Empezar" and "Entregada" are plain, "Marcar lista" is the yellow step.
            className={`${lane.status === "PREPARING" ? button.ready : button.secondary} w-full`}
          >
            {busy ? (
              <LoaderCircle size={18} className="animate-spin motion-reduce:[animation-duration:6s]" aria-hidden />
            ) : (
              lane.status === "READY" && <Check size={16} aria-hidden />
            )}
            {lane.action}
          </button>
        </div>
      )}
    </article>
  );
}
