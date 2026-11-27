"use client";

import { Lock, ListChecks, PackagePlus, Users, Wallet, type LucideIcon } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { FormAlert } from "@/components/form-alert";
import { Sentinel } from "@/components/sentinel";
import { field, seg, segItem } from "@/components/ui";
import { errorMessage, useApi } from "@/lib/api";
import type { Me } from "@/lib/auth";
import { cop, dateTime, qty, time } from "@/lib/format";

export interface ActivityEntry {
  id: string;
  kind: "STOCK_RECEIVE" | "STOCK_COUNT" | "REGISTER_OPEN" | "REGISTER_CLOSE";
  details: Record<string, string>;
  created_at: string;
  users: { full_name: string };
}

const PAGE = 50;
const DAY = new Intl.DateTimeFormat("es-CO", { weekday: "long", day: "numeric", month: "long", timeZone: "America/Bogota" });
const DAY_KEY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" });
// Colombia has no daylight saving time: a day picked in the filter always runs in UTC-5.
const dayStart = (day: string) => `${day}T00:00:00-05:00`;
const dayEnd = (day: string) => `${day}T23:59:59.999-05:00`;
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

const chip = {
  bad: "bg-danger-soft text-danger",
  warn: "bg-warning-soft text-warning",
  good: "bg-success-soft text-success",
  plain: "bg-ground text-ink-2",
};

/** What happened in one line, the numbers behind it and, for counts and closes, the difference. */
function describe({ kind, details: d }: ActivityEntry): { title: string; meta?: string; badge?: [string, string] } {
  switch (kind) {
    case "STOCK_RECEIVE":
      return { title: `Recibió ${qty(d.qty)} ${d.unit} de ${d.ingredient}`, meta: `${qty(d.before)} → ${qty(d.after)} ${d.unit}` };
    case "STOCK_COUNT": {
      const diff = Number(d.after) - Number(d.before);
      const badge: [string, string] = diff
        ? [`${diff > 0 ? "+" : "−"}${qty(Math.abs(diff))} ${d.unit}`, diff < 0 ? chip.bad : chip.plain]
        : ["Sin cambio", chip.plain];
      return { title: `Conteo de ${d.ingredient}: ${qty(d.after)} ${d.unit}`, meta: `Antes había ${qty(d.before)} ${d.unit}`, badge };
    }
    case "REGISTER_OPEN":
      return { title: `Abrió la caja con ${cop(d.opening_cop)}` };
    case "REGISTER_CLOSE": {
      const diff = Number(d.actual_cop) - Number(d.expected_cop);
      const badge: [string, string] = diff ? [`${diff < 0 ? "Faltan" : "Sobran"} ${cop(Math.abs(diff))}`, diff < 0 ? chip.bad : chip.warn] : ["Cuadró", chip.good];
      return { title: `Cerró la caja con ${cop(d.actual_cop)} contados`, meta: `Esperado ${cop(d.expected_cop)}`, badge };
    }
  }
}

const ICON: Record<ActivityEntry["kind"], { Icon: LucideIcon; tone: string }> = {
  STOCK_RECEIVE: { Icon: PackagePlus, tone: "bg-success-soft text-success" },
  STOCK_COUNT: { Icon: ListChecks, tone: "bg-accent-soft text-accent" },
  REGISTER_OPEN: { Icon: Wallet, tone: "bg-ready-soft text-ready-ink" },
  REGISTER_CLOSE: { Icon: Lock, tone: "bg-[#eceee9] text-ink-2" },
};
const lower = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** One entry of the log: who did what, the numbers behind it and the time; `withDate` when not grouped by day. */
export function ActivityLine({ entry, withDate = false }: { entry: ActivityEntry; withDate?: boolean }) {
  const { title, meta, badge } = describe(entry);
  const { Icon, tone } = ICON[entry.kind];
  return (
    <li className="flex min-h-16 items-center gap-4 px-3.5 py-3 sm:px-[18px]">
      <span aria-hidden className={`grid size-9 shrink-0 place-items-center rounded-full ${tone}`}>
        <Icon size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[15px] leading-snug">
          <span className="font-[650]">{entry.users.full_name}</span> {lower(title)}
        </p>
        {meta && <p className="figures text-[13px] text-ink-2">{meta}</p>}
        {badge && <span className={`figures mt-1 inline-block rounded-full px-2 py-0.5 text-xs font-bold ${badge[1]}`}>{badge[0]}</span>}
      </div>
      <time dateTime={entry.created_at} className="figures shrink-0 text-right text-[13px] text-muted">
        {withDate ? dateTime(entry.created_at) : time(entry.created_at)}
      </time>
    </li>
  );
}

/**
 * Activity log of the current location (Q41, Q57): goods received, stock counts and cash registers opened and
 * closed, newest first and grouped by day. Nobody can edit or delete an entry. Owners and supervisors only.
 */
export function Activity({ me }: { me: Me }) {
  const api = useApi();
  const locationName = me.locations.find((l) => l.id === me.current_location_id)?.name ?? "esta sede";
  const [type, setType] = useState<"" | "inventory" | "cash">("");
  const [user, setUser] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [users, setUsers] = useState<{ id: string; full_name: string }[]>([]);
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const page = (before?: string) => {
    const params = new URLSearchParams({ limit: String(PAGE) });
    if (type) params.set("type", type);
    if (user) params.set("user", user);
    if (from) params.set("from", dayStart(from));
    if (to) params.set("to", dayEnd(to));
    if (before) params.set("before", before);
    return api<ActivityEntry[]>(`/activity?${params}`);
  };

  useEffect(() => {
    api<{ id: string; full_name: string }[]>("/activity/users").then(setUsers, () => undefined);
  }, [api]);

  // Filters changed: the newest page again. A slower earlier answer must not overwrite a newer one.
  useEffect(() => {
    let stale = false;
    void (async () => {
      try {
        const first = await page();
        if (stale) return;
        setEntries(first);
        setMore(first.length === PAGE);
        setError(null);
      } catch (err) {
        if (!stale) setError(errorMessage(err));
      }
    })();
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- page() reads exactly these filters
  }, [api, type, user, from, to]);

  const loadMore = async () => {
    setBusy(true);
    try {
      const next = await page(entries!.at(-1)!.created_at);
      setEntries((all) => [...(all ?? []), ...next]);
      setMore(next.length === PAGE);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const days = new Map<string, ActivityEntry[]>();
  for (const entry of entries ?? []) {
    const key = DAY_KEY.format(new Date(entry.created_at));
    days.set(key, [...(days.get(key) ?? []), entry]);
  }
  const filtered = Boolean(type || user || from || to);

  return (
    <div>
      <p className="-mt-1 mb-5 text-[15px] text-ink-2 text-pretty">
        Entradas y conteos de inventario, aperturas y cierres de caja en {locationName}. Nadie puede editar ni borrar estos registros.
      </p>

      <div className="mb-4 flex flex-wrap items-center gap-2.5">
        <fieldset className={`${seg} max-sm:order-3 max-sm:w-full`}>
          <legend className="sr-only">Tipo de movimiento</legend>
          {(
            [
              ["", "Todo"],
              ["inventory", "Inventario"],
              ["cash", "Caja"],
            ] as const
          ).map(([value, label]) => (
            <label key={label} className={`${segItem} max-sm:flex-1`}>
              <input type="radio" name="type" checked={type === value} onChange={() => setType(value)} className="sr-only" />
              {label}
            </label>
          ))}
        </fieldset>
        <label className="flex items-center gap-1.5 text-muted">
          <Users size={16} aria-hidden />
          <span className="sr-only">Quién</span>
          <select value={user} onChange={(e) => setUser(e.target.value)} className="h-10 rounded-control border border-line-strong bg-surface px-2.5 font-semibold text-ink-2 hover:border-muted">
            <option value="">Todo el equipo</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.full_name}
              </option>
            ))}
          </select>
        </label>
        <div className="flex w-full gap-2 sm:w-auto">
          <label className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-muted">
            Desde
            <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className={`${field} figures h-10 min-w-0 flex-1 px-2.5 sm:w-auto`} />
          </label>
          <label className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-muted">
            Hasta
            <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className={`${field} figures h-10 min-w-0 flex-1 px-2.5 sm:w-auto`} />
          </label>
        </div>
      </div>

      {error && <FormAlert>{error}</FormAlert>}

      {!entries ? (
        !error && (
          <p role="status" className="py-10 text-center text-[15px] text-muted">
            Cargando registro…
          </p>
        )
      ) : !entries.length ? (
        <p className="pm-card px-6 py-12 text-center text-muted">
          {filtered ? "Nada coincide con estos filtros." : `Todavía no hay movimientos en ${locationName}.`}
        </p>
      ) : (
        <>
          <ul className="pm-card [&>li+li]:border-t [&>li+li]:border-line [&>li[data-day]+li]:border-t-0">
            {[...days].map(([key, list]) => (
              <Fragment key={key}>
                <li
                  data-day
                  className="sticky top-[60px] z-[2] border-b border-line bg-rail/90 px-3.5 py-2.5 text-[13px] font-bold text-ink-2 backdrop-blur-md first:rounded-t-[15px] sm:top-[68px] sm:px-[18px]"
                >
                  {capital(DAY.format(new Date(list[0].created_at)))}
                </li>
                {list.map((entry) => (
                  <ActivityLine key={entry.id} entry={entry} />
                ))}
              </Fragment>
            ))}
          </ul>
          <Sentinel onNear={more && !error ? () => void loadMore() : undefined} busy={busy}>
            {more ? (busy ? "Cargando más…" : `Mostrando ${entries.length}`) : `${entries.length} en total`}
          </Sentinel>
        </>
      )}
    </div>
  );
}
