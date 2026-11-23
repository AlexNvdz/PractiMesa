"use client";

import { LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { type ActivityEntry, ActivityLine } from "@/components/admin/activity";
import { PanelLoading, PanelShell } from "@/components/panel-shell";
import { CashKeypad } from "@/components/pos/cash-keypad";
import { button } from "@/components/ui";
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
    <div className="space-y-10">
      {closed && <CountResult register={closed} />}

      <section aria-labelledby="estado" className="rounded-panel border border-line bg-surface p-5 sm:p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="estado" className="text-lg font-semibold tracking-[-0.01em]">
            {current ? "Caja abierta" : "Caja cerrada"}
          </h2>
          {current && (
            <p className="text-sm text-muted">
              Desde las {time(current.opened_at)} · {current.users?.full_name ?? "—"} · base{" "}
              <span className="figures font-medium text-ink-2">{cop(current.opening_amount_cop)}</span>
            </p>
          )}
        </div>
        <p className="mt-1 text-[15px] text-muted">
          {current
            ? "Al cerrar, cuenta el efectivo del cajón. El sistema lo compara con la base más las ventas en efectivo y sus propinas."
            : "Ábrela con la base del día para empezar a cobrar."}
        </p>

        <form onSubmit={submit} className="mt-5 space-y-4">
          <CashKeypad key={round} label={current ? "Efectivo contado" : "Base inicial"} disabled={busy} onChange={setAmount} />
          <div className="flex justify-end">
            <button type="submit" disabled={busy} className={`${button.primary} w-full sm:w-auto`}>
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

      <section aria-labelledby="hoy">
        <h2 id="hoy" className="text-sm font-semibold text-ink-2">
          Aperturas y cierres de hoy
        </h2>
        {today.length ? (
          <ul className="mt-3 divide-y divide-line rounded-panel border border-line bg-surface">
            {today.map((entry) => (
              <ActivityLine key={entry.id} entry={entry} />
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-[15px] text-muted">Hoy todavía no se ha abierto ni cerrado la caja en esta sede.</p>
        )}
      </section>
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
