"use client";

import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { FormAlert } from "@/components/form-alert";
import { button, choice, field } from "@/components/ui";
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
const labelClass = "mb-1.5 block text-sm font-medium text-ink-2";
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

/** One entry of the log; `withDate` when the list is not grouped by day. */
export function ActivityLine({ entry, withDate = false }: { entry: ActivityEntry; withDate?: boolean }) {
  const { title, meta, badge } = describe(entry);
  return (
    <li className="flex items-start gap-3 px-4 py-3 sm:gap-4 sm:px-5">
      {/* On a phone the badge goes under the text so the title keeps its width. */}
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1 sm:flex-row sm:gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-[15px] leading-snug">{title}</p>
          {meta && <p className="figures text-sm text-muted">{meta}</p>}
        </div>
        {badge && <span className={`figures shrink-0 rounded-full px-2 py-0.5 text-xs font-medium sm:mt-0.5 ${badge[1]}`}>{badge[0]}</span>}
      </div>
      <p className="w-28 shrink-0 text-right text-sm sm:w-36">
        <span className="block truncate text-ink-2">{entry.users.full_name}</span>
        <span className="figures block text-muted">{withDate ? dateTime(entry.created_at) : time(entry.created_at)}</span>
      </p>
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

      <div className="mb-6 flex flex-wrap items-end gap-3">
        <fieldset>
          <legend className={labelClass}>Tipo</legend>
          <div className="flex gap-2">
            {(
              [
                ["", "Todo"],
                ["inventory", "Inventario"],
                ["cash", "Caja"],
              ] as const
            ).map(([value, label]) => (
              <label key={label} className={choice}>
                <input type="radio" name="type" checked={type === value} onChange={() => setType(value)} className="sr-only" />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="block min-w-44">
          <span className={labelClass}>Quién</span>
          <select value={user} onChange={(e) => setUser(e.target.value)} className={field}>
            <option value="">Todos</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.full_name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={labelClass}>Desde</span>
          <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className={`${field} figures`} />
        </label>
        <label className="block">
          <span className={labelClass}>Hasta</span>
          <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className={`${field} figures`} />
        </label>
      </div>

      {error && <FormAlert>{error}</FormAlert>}

      {!entries ? (
        !error && (
          <p role="status" className="py-10 text-center text-[15px] text-muted">
            Cargando registro…
          </p>
        )
      ) : !entries.length ? (
        <p className="rounded-panel border border-line bg-surface px-5 py-10 text-center text-[15px] text-muted">
          {filtered ? "Nada coincide con estos filtros." : `Todavía no hay movimientos en ${locationName}.`}
        </p>
      ) : (
        <>
          {[...days].map(([key, list]) => (
            <section key={key} aria-labelledby={`day-${key}`} className="mb-6">
              <h2 id={`day-${key}`} className="mb-3 text-sm font-semibold text-ink-2">
                {capital(DAY.format(new Date(list[0].created_at)))}
              </h2>
              <ul className="divide-y divide-line rounded-panel border border-line bg-surface">
                {list.map((entry) => (
                  <ActivityLine key={entry.id} entry={entry} />
                ))}
              </ul>
            </section>
          ))}
          {more && (
            <div className="flex justify-center">
              <button type="button" disabled={busy} onClick={() => void loadMore()} className={button.secondary}>
                {busy && <LoaderCircle size={18} className="animate-spin motion-reduce:[animation-duration:6s]" aria-hidden />}
                Ver más
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
