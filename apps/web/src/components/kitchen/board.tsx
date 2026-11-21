"use client";

import { Clock, LoaderCircle, Volume2, VolumeX } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNow } from "@/components/pos/service";
import { button } from "@/components/ui";
import { type Undo, UndoToast } from "@/components/undo-toast";
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
  // The board only renders in the browser (after login), so localStorage is there.
  const [sound, setSound] = useState(() => localStorage.getItem(SOUND_KEY) !== "off");
  const [audible, setAudible] = useState(false);
  const audio = useRef<AudioContext | null>(null);
  const seen = useRef<Set<string> | null>(null);
  const [undo, setUndo] = useState<Undo | null>(null);

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
      <div className="mb-5 flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
        {sound && !audible && <p className="text-sm text-muted">Toca la pantalla una vez para oír las comandas nuevas.</p>}
        <button
          type="button"
          aria-pressed={sound}
          onClick={toggleSound}
          className={`${button.secondary} pl-3.5 aria-pressed:border-accent aria-pressed:bg-accent-soft aria-pressed:text-accent-strong`}
        >
          {sound ? <Volume2 size={18} strokeWidth={2.25} aria-hidden /> : <VolumeX size={18} strokeWidth={2.25} aria-hidden />}
          Sonido de comandas
        </button>
      </div>
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
      <UndoToast undo={undo} onClose={() => setUndo(null)} />
    </div>
  );
}

function Ticket({ round, lane, now, busy, onAdvance }: { round: KitchenRound; lane: Lane; now: number; busy: boolean; onAdvance: () => void }) {
  // Late = still not ready this long after it was sent; ready tickets wait on the floor, not the kitchen.
  const late = round.status !== "READY" && now - Date.parse(round.created_at) >= LATE_MINUTES * 60_000;
  return (
    <article
      aria-label={`${where(round)}, ronda ${round.round}${late ? ", atrasada" : ""}`}
      className={`rounded-panel border bg-surface ${late ? "border-danger" : "border-line"}`}
    >
      {/* Title on its own line: three lanes beside the sidebar leave ~200px per ticket on a 1024px tablet. */}
      <header className={`rounded-t-[7px] border-b px-4 py-3 ${late ? "border-danger/30 bg-danger-soft" : "border-line"}`}>
        <h3 className="text-xl font-semibold tracking-[-0.01em] text-balance">{where(round)}</h3>
        <div className="figures mt-0.5 flex items-center justify-between gap-3">
          <p className="text-sm text-muted">Ronda {round.round}</p>
          <p className={`flex items-center gap-1.5 text-[15px] ${late ? "font-semibold text-danger" : "font-medium text-ink-2"}`}>
            <Clock size={18} strokeWidth={late ? 2.5 : 2.25} aria-hidden />
            {late ? "Atrasada · " : <span className="sr-only">Enviada hace </span>}
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
