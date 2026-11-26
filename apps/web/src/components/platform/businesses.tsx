"use client";

import { LoaderCircle, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { Dialog } from "@/components/dialog";
import { button, choice, field } from "@/components/ui";
import { errorMessage } from "@/lib/api";
import { ApiError } from "@/lib/auth";
import { fold } from "@/lib/format";
import { type Organization, PLAN_LABEL, platformApi } from "./api";
import { PlanFields } from "./plan-fields";

type Filter = "ALL" | "SINGLE" | "MULTI" | "SUSPENDED";

const DATE = new Intl.DateTimeFormat("es-CO", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "America/Bogota",
});

/** Businesses by plan and state (Q27): change plan and location limit, suspend and reactivate. */
export function Businesses({ onSessionEnd }: { onSessionEnd: () => void }) {
  const [orgs, setOrgs] = useState<Organization[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("ALL");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Organization | null>(null);

  useEffect(() => {
    platformApi<Organization[]>("/organizations").then(setOrgs, (err) =>
      err instanceof ApiError && err.status === 401 ? onSessionEnd() : setError(errorMessage(err)),
    );
  }, [onSessionEnd]);

  if (!orgs) {
    return error ? (
      <p role="alert" className="rounded-panel border border-line bg-surface px-5 py-10 text-center text-[15px] text-danger">
        {error}
      </p>
    ) : (
      <p role="status" className="py-10 text-center text-[15px] text-muted">
        Cargando negocios…
      </p>
    );
  }

  const counts: Record<Filter, number> = {
    ALL: orgs.length,
    SINGLE: orgs.filter((o) => o.plan_tier === "SINGLE").length,
    MULTI: orgs.filter((o) => o.plan_tier === "MULTI").length,
    SUSPENDED: orgs.filter((o) => o.suspended_at).length,
  };
  const filters: [Filter, string][] = [
    ["ALL", "Todos"],
    ["SINGLE", PLAN_LABEL.SINGLE],
    ["MULTI", PLAN_LABEL.MULTI],
    ["SUSPENDED", "Suspendidos"],
  ];
  const q = fold(query.trim().replace(/^@/, ""));
  const shown = orgs.filter(
    (o) =>
      (filter === "ALL" || (filter === "SUSPENDED" ? o.suspended_at : o.plan_tier === filter)) &&
      (!q || fold(o.name).includes(q) || fold(o.handle).includes(q)),
  );

  return (
    <div>
      <h1 className="font-display text-2xl font-bold tracking-[-0.02em]">Negocios</h1>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <fieldset className="flex flex-wrap gap-2">
          <legend className="sr-only">Filtrar negocios</legend>
          {filters.map(([value, label]) => (
            <label key={value} className={`${choice} gap-2 px-3.5`}>
              <input type="radio" name="filter" checked={filter === value} onChange={() => setFilter(value)} className="sr-only" />
              {label}
              <span className="figures text-muted">{counts[value]}</span>
            </label>
          ))}
        </fieldset>
        <label className="relative ml-auto w-full sm:w-64">
          <span className="sr-only">Buscar negocio</span>
          <Search size={18} aria-hidden className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Nombre o @identificador"
            className={`${field} pl-10`}
          />
        </label>
      </div>

      {shown.length ? (
        <ul className="mt-5 divide-y divide-line rounded-panel border border-line bg-surface">
          {shown.map((o) => (
            <li key={o.id}>
              <button
                type="button"
                onClick={() => setEditing(o)}
                className="flex min-h-16 w-full items-center gap-4 px-5 py-3 text-left transition-[background-color] duration-150 first:rounded-t-panel last:rounded-b-panel hover:bg-ground"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-medium">
                    {o.name} <span className="font-normal text-muted">@{o.handle}</span>
                  </span>
                  <span className="figures block truncate text-sm text-muted">
                    {PLAN_LABEL[o.plan_tier]} · {o.max_locations === 1 ? "1 sede" : `${o._count.locations} de ${o.max_locations} sedes`} ·
                    desde {DATE.format(new Date(o.created_at))}
                  </span>
                </span>
                {o.suspended_at && (
                  <span className="rounded-full bg-danger-soft px-2 py-0.5 text-xs font-medium text-danger">Suspendido</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-5 rounded-panel border border-line bg-surface px-5 py-10 text-center text-[15px] text-muted">
          {orgs.length ? "Ningún negocio coincide con la búsqueda." : "Todavía no hay negocios."}
        </p>
      )}

      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={editing?.name ?? ""}>
        {editing && (
          <BusinessForm
            key={editing.id}
            org={editing}
            onSaved={(saved) => {
              setOrgs(orgs.map((o) => (o.id === saved.id ? saved : o)));
              setEditing(null);
            }}
          />
        )}
      </Dialog>
    </div>
  );
}

function BusinessForm({ org, onSaved }: { org: Organization; onSaved: (org: Organization) => void }) {
  const [plan, setPlan] = useState(org.plan_tier);
  const [max, setMax] = useState(org.plan_tier === "MULTI" ? org.max_locations : 3);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmSuspend, setConfirmSuspend] = useState(false);
  const locations = org._count.locations;

  const send = async (body: object) => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await platformApi<Organization>(`/organizations/${org.id}`, "PATCH", body));
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void send(plan === "SINGLE" ? { plan_tier: plan } : { plan_tier: plan, max_locations: max });
      }}
      className="space-y-5"
    >
      <p className="figures -mt-3 text-sm text-muted">
        @{org.handle}
        {org.nit && ` · NIT ${org.nit}`} · {locations === 1 ? "1 sede creada" : `${locations} sedes creadas`}
      </p>

      <PlanFields plan={plan} onPlan={setPlan} max={max} onMax={setMax} locations={locations} />

      {error && (
        <p role="alert" className="rounded-control bg-danger-soft px-3 py-2.5 text-sm text-danger">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-5">
        {org.suspended_at && (
          <button type="button" disabled={busy} onClick={() => void send({ suspended: false })} className={button.secondary}>
            Reactivar negocio
          </button>
        )}
        {!org.suspended_at &&
          (confirmSuspend ? (
            <>
              <span className="w-full text-sm text-ink-2">Nadie del negocio podrá entrar ni usar el panel hasta que lo reactives.</span>
              <button type="button" disabled={busy} onClick={() => void send({ suspended: true })} className={button.danger}>
                Suspender {org.name}
              </button>
              <button type="button" onClick={() => setConfirmSuspend(false)} className={button.ghost}>
                No
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setConfirmSuspend(true)} className={`${button.quietDanger} -ml-3`}>
              Suspender negocio
            </button>
          ))}
        <button type="submit" disabled={busy} className={`${button.primary} ml-auto`}>
          {busy && <LoaderCircle size={18} className="animate-spin motion-reduce:[animation-duration:6s]" aria-hidden />}
          Guardar plan
        </button>
      </div>
    </form>
  );
}
