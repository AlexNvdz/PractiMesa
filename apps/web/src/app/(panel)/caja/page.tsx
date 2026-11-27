"use client";

import { LoaderCircle, Lock, Wallet } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { type ActivityEntry, ActivityLine } from "@/components/admin/activity";
import { PanelLoading, PanelShell } from "@/components/panel-shell";
import { CashKeypad } from "@/components/pos/cash-keypad";
import { button, tag } from "@/components/ui";
import { errorMessage, useApi } from "@/lib/api";
import { type Me, useRequiredMe } from "@/lib/auth";
import { cop, time } from "@/lib/format";
import type { CashRegister } from "@/lib/pos";

export default function CajaPage() {
  const me = useRequiredMe();
  if (!me) return <PanelLoading />;
  return (
    <PanelShell me={me} title="Caja">
      <CashRegisters key={me.current_location_id} me={me} />
    </PanelShell>
  );
}

/** Opening and closing of the location's register with the cash count (arqueo). */
function CashRegisters({ me }: { me: Me }) {
  const api = useApi();
  const [registers, setRegisters] = useState<CashRegister[] | null>(null);
  const [today, setToday] = useState<ActivityEntry[]>([]);
  const [amount, setAmount] = useState(0);
  // A new keypad (empty tape) after every open or close.
  const [round, setRound] = useState(0);
  const [closed, setClosed] = useState<CashRegister | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allowed = me.user.role === "OWNER" || me.user.role === "ADMIN" || me.user.role === "CASHIER";

  const load = useCallback(
    () =>
      Promise.all([api<CashRegister[]>("/cash-registers"), api<ActivityEntry[]>("/cash-registers/today")]).then(([list, log]) => {
        setRegisters(list);
        setToday(log);
      }, (err: unknown) => setError(errorMessage(err))),
    [api],
  );
  useEffect(() => {
    if (allowed) void load();
  }, [allowed, load]);

  if (!allowed) return <p className="text-[15px] text-muted">La caja la manejan el dueño, el supervisor y los cajeros.</p>;
  if (!registers) {
    return error ? (
      <p role="alert" className="text-[15px] text-danger">
        {error}
      </p>
    ) : (
      <p role="status" className="text-[15px] text-muted">
        Cargando caja…
      </p>
    );
  }

  const current = registers[0]?.status === "OPEN" ? registers[0] : undefined;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (current) {
        setClosed(await api<CashRegister>(`/cash-registers/${current.id}/close`, "POST", { actual_closing_cop: amount }));
      } else {
        await api<CashRegister>("/cash-registers", "POST", { opening_amount_cop: amount });
        setClosed(null);
      }
      setAmount(0);
      setRound((n) => n + 1);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-[1240px] space-y-5">
      {closed && <CountResult register={closed} />}

      <div className="grid items-start gap-5 min-[1100px]:grid-cols-[minmax(0,1fr)_360px]">
        <section aria-labelledby="estado" className="pm-card p-[22px]">
          <div className="mb-[18px] flex items-center gap-3">
            <span aria-hidden className={`grid size-11 shrink-0 place-items-center rounded-full ${current ? "bg-ready-soft text-ready-ink" : "bg-[#eceee9] text-ink-2"}`}>
              {current ? <Wallet size={20} /> : <Lock size={20} />}
            </span>
            <div className="min-w-0">
              <h2 id="estado" className="font-display text-2xl font-bold tracking-[-0.02em]">
                {current ? "Caja abierta" : "Caja cerrada"}
              </h2>
              <p className="text-sm text-muted">
                {current ? `Desde las ${time(current.opened_at)} · ${current.users?.full_name ?? "—"}` : "Ábrela con la base del día para empezar a cobrar."}
              </p>
            </div>
            <span className={`${current ? tag.ok : tag.mute} ml-auto`}>{current ? "En turno" : "Sin abrir"}</span>
          </div>

          {current && (
            <>
              <dl className="mb-[22px] grid grid-cols-2 gap-2.5 min-[1100px]:grid-cols-4">
                <div className="rounded-xl bg-ground px-3.5 py-3">
                  <dt className="text-[12.5px] font-semibold text-muted">Base</dt>
                  <dd className="figures mt-0.5 text-lg font-extrabold">{cop(current.opening_amount_cop)}</dd>
                </div>
              </dl>
              <p className="-mt-2.5 mb-[18px] text-[13.5px] text-muted">
                Al cerrar, cuenta el efectivo del cajón. El sistema lo compara con la base más las ventas en efectivo y sus propinas.
              </p>
            </>
          )}

          <form onSubmit={submit}>
            <CashKeypad key={round} label={current ? "Efectivo contado" : "Base para abrir"} disabled={busy} onChange={setAmount} />
            <div className="figures mt-4 flex items-center justify-between gap-3 rounded-[14px] bg-ground px-4 py-3.5 text-ink-2">
              <span>{current ? "Contado" : "Base"}</span>
              <b className="font-display text-[22px]">{cop(amount)}</b>
            </div>
            <div className="mt-4 flex justify-end">
              <button type="submit" disabled={busy} className={`${button.primary} h-[52px] w-full text-base sm:w-auto`}>
                {busy && <LoaderCircle size={18} className="animate-spin motion-reduce:[animation-duration:6s]" aria-hidden />}
                {current ? `Cerrar caja con ${cop(amount)}` : `Abrir caja con ${cop(amount)}`}
              </button>
            </div>
          </form>
          {error && (
            <p role="alert" className="mt-3 rounded-control bg-danger-soft px-3 py-2.5 text-sm text-danger">
              {error}
            </p>
          )}
        </section>

        <aside aria-labelledby="hoy" className="pm-card px-5 py-[18px]">
          <h2 id="hoy" className="mb-3 text-[15px] font-bold">
            Aperturas y cierres de hoy
          </h2>
          {today.length ? (
            <ul className="-mx-5 divide-y divide-line">
              {today.map((entry) => (
                <ActivityLine key={entry.id} entry={entry} />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">Hoy todavía no se ha abierto ni cerrado la caja en esta sede.</p>
          )}
        </aside>
      </div>
    </div>
  );
}

function CountResult({ register }: { register: CashRegister }) {
  const expected = Number(register.expected_closing_cop);
  const diff = Number(register.actual_closing_cop) - expected;
  return (
    <section
      role="status"
      aria-label="Resultado del arqueo"
      className={`enter rounded-panel px-5 py-4 sm:px-6 ${diff === 0 ? "bg-success-soft text-success" : "bg-danger-soft text-danger"}`}
    >
      <p className="text-[15px] font-semibold">
        {diff === 0 ? "La caja cuadra" : diff > 0 ? `Sobran ${cop(diff)}` : `Faltan ${cop(-diff)}`}
      </p>
      <p className="figures mt-0.5 text-sm">
        Esperado {cop(expected)} · contado {cop(register.actual_closing_cop ?? 0)}
      </p>
    </section>
  );
}
