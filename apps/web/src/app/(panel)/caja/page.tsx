"use client";

import { LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { PanelLoading, PanelShell } from "@/components/panel-shell";
import { button, field } from "@/components/ui";
import { errorMessage, useApi } from "@/lib/api";
import { type Me, useRequiredMe } from "@/lib/auth";
import { cop, dateTime, time } from "@/lib/format";
import type { CashRegister } from "@/lib/pos";

const pesos = (text: string) => Number(text.replace(/\D/g, "")) || 0;

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
  const [amount, setAmount] = useState("");
  const [closed, setClosed] = useState<CashRegister | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allowed = me.user.role === "OWNER" || me.user.role === "ADMIN" || me.user.role === "CASHIER";

  const load = useCallback(
    () => api<CashRegister[]>("/cash-registers").then(setRegisters, (err: unknown) => setError(errorMessage(err))),
    [api],
  );
  useEffect(() => {
    if (allowed) void load();
  }, [allowed, load]);

  if (!allowed) return <p className="text-[15px] text-muted">La caja la manejan el dueño, el administrador y los cajeros.</p>;
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
  const history = registers.filter((r) => r.status === "CLOSED");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (current) {
        setClosed(await api<CashRegister>(`/cash-registers/${current.id}/close`, "POST", { actual_closing_cop: pesos(amount) }));
      } else {
        await api<CashRegister>("/cash-registers", "POST", { opening_amount_cop: pesos(amount) });
        setClosed(null);
      }
      setAmount("");
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

        <form onSubmit={submit} className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="block flex-1 sm:max-w-xs">
            <span className="mb-1.5 block text-sm font-medium text-ink-2">{current ? "Efectivo contado" : "Base inicial"}</span>
            <input
              required
              inputMode="numeric"
              placeholder="$ 0"
              value={amount ? cop(pesos(amount)) : ""}
              onChange={(e) => setAmount(e.target.value)}
              className={`${field} figures`}
            />
          </label>
          <button type="submit" disabled={busy} className={button.primary}>
            {busy && <LoaderCircle size={18} className="animate-spin motion-reduce:[animation-duration:6s]" aria-hidden />}
            {current ? "Cerrar caja" : "Abrir caja"}
          </button>
        </form>
        {error && (
          <p role="alert" className="mt-3 rounded-control bg-danger-soft px-3 py-2.5 text-sm text-danger">
            {error}
          </p>
        )}
      </section>

      <section aria-labelledby="historial">
        <h2 id="historial" className="text-sm font-semibold text-ink-2">
          Cierres anteriores
        </h2>
        {history.length ? (
          <div className="mt-3 overflow-x-auto rounded-panel border border-line bg-surface">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead className="border-b border-line text-muted">
                <tr>
                  <th className="px-5 py-3 font-medium">Cierre</th>
                  <th className="px-5 py-3 font-medium">Abrió</th>
                  <th className="px-5 py-3 text-right font-medium">Esperado</th>
                  <th className="px-5 py-3 text-right font-medium">Contado</th>
                  <th className="px-5 py-3 text-right font-medium">Diferencia</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {history.map((r) => {
                  const diff = Number(r.actual_closing_cop) - Number(r.expected_closing_cop);
                  return (
                    <tr key={r.id}>
                      <td className="px-5 py-3 first-letter:uppercase">{r.closed_at ? dateTime(r.closed_at) : "—"}</td>
                      <td className="px-5 py-3 text-ink-2">{r.users?.full_name ?? "—"}</td>
                      <td className="figures px-5 py-3 text-right">{cop(r.expected_closing_cop ?? 0)}</td>
                      <td className="figures px-5 py-3 text-right">{cop(r.actual_closing_cop ?? 0)}</td>
                      <td className={`figures px-5 py-3 text-right font-medium ${diff === 0 ? "text-success" : "text-danger"}`}>
                        {diff === 0 ? "Cuadra" : `${diff > 0 ? "Sobran" : "Faltan"} ${cop(Math.abs(diff))}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-3 text-[15px] text-muted">Todavía no hay cierres en esta sede.</p>
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
