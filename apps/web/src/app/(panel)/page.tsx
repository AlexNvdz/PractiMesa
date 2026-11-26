"use client";

import { BookOpen, LayoutGrid, Wallet, type LucideIcon } from "lucide-react";
import { PanelLoading, PanelShell } from "@/components/panel-shell";
import { useRequiredMe } from "@/lib/auth";

const TIME_ZONE = "America/Bogota";

function greeting(now: Date): string {
  const hour = Number(new Intl.DateTimeFormat("es-CO", { hour: "numeric", hourCycle: "h23", timeZone: TIME_ZONE }).format(now));
  if (hour < 12) return "Buenos días";
  if (hour < 19) return "Buenas tardes";
  return "Buenas noches";
}

const today = (now: Date) =>
  new Intl.DateTimeFormat("es-CO", { weekday: "long", day: "numeric", month: "long", timeZone: TIME_ZONE }).format(now);

const STEPS: { icon: LucideIcon; title: string; detail: string }[] = [
  { icon: BookOpen, title: "Arma tu menú", detail: "Categorías, productos, modificadores y recetas para el inventario." },
  { icon: LayoutGrid, title: "Crea tus mesas", detail: "Nombra cada mesa y su capacidad para abrir cuentas en servicio." },
  { icon: Wallet, title: "Abre la caja", detail: "Registra la base del día y empieza a cobrar en efectivo o con QR." },
];

// Honest empties until cash register and orders exist (2.5 / 2.6).
const TODAY = [
  { label: "Ventas de hoy", value: "$ 0", note: "Sin ventas registradas" },
  { label: "Pedidos", value: "0", note: "Sin pedidos todavía" },
  { label: "Caja", value: "Sin abrir", note: "Ábrela para empezar a cobrar" },
];

export default function HomePage() {
  const me = useRequiredMe();
  if (!me) return <PanelLoading />;
  const now = new Date();
  const firstName = me.user.full_name.split(/\s+/)[0];

  return (
    <PanelShell me={me} title="Inicio">
      <h2 className="font-display text-2xl font-bold tracking-[-0.02em] text-balance">
        {greeting(now)}, {firstName}
      </h2>
      <p className="mt-1 text-[15px] text-muted first-letter:uppercase">{today(now)}</p>

      <section aria-labelledby="hoy" className="mt-10">
        <h3 id="hoy" className="text-sm font-semibold text-ink-2">
          Hoy
        </h3>
        <dl className="mt-3 grid divide-y divide-line rounded-panel border border-line bg-surface sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          {TODAY.map(({ label, value, note }) => (
            <div key={label} className="px-5 py-4">
              <dt className="text-sm text-muted">{label}</dt>
              <dd className="figures mt-1 text-xl font-semibold tracking-[-0.01em]">{value}</dd>
              <dd className="mt-0.5 text-xs text-muted">{note}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="pasos" className="mt-10">
        <h3 id="pasos" className="text-sm font-semibold text-ink-2">
          Para empezar
        </h3>
        <ul className="mt-3 divide-y divide-line rounded-panel border border-line bg-surface">
          {STEPS.map(({ icon: Icon, title, detail }) => (
            <li key={title} className="flex items-center gap-4 px-5 py-4">
              <Icon size={18} className="shrink-0 text-muted" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-[15px] font-medium">{title}</p>
                <p className="text-sm text-muted">{detail}</p>
              </div>
              <span className="shrink-0 rounded-full bg-ground px-2.5 py-1 text-xs font-medium text-muted">Pronto</span>
            </li>
          ))}
        </ul>
      </section>
    </PanelShell>
  );
}
