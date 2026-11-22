"use client";

import { Check, Copy, LoaderCircle, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { Dialog } from "@/components/dialog";
import { useNow } from "@/components/pos/service";
import { button, choice, field } from "@/components/ui";
import { errorMessage } from "@/lib/api";
import { ApiError } from "@/lib/auth";
import { dateTime } from "@/lib/format";
import { PLAN_LABEL, platformApi } from "./api";

interface Invitation {
  id: string;
  plan_tier: "SINGLE" | "MULTI";
  max_locations: number;
  note: string | null;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
  created_at: string;
  organizations: { name: string; handle: string } | null;
}

/** Returned only when the link is created: the DB keeps just its hash. */
type Created = Invitation & { token: string };

const labelClass = "mb-1.5 block text-sm font-medium text-ink-2";
const badge = "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium";

/** One-time sign-up links (Q28): plan + limit + internal note, 24 h, can be revoked or regenerated. */
export function Invitations({ onSessionEnd }: { onSessionEnd: () => void }) {
  const [invitations, setInvitations] = useState<Invitation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"new" | Created | null>(null);
  const now = useNow();

  useEffect(() => {
    platformApi<Invitation[]>("/invitations").then(setInvitations, (err) =>
      err instanceof ApiError && err.status === 401 ? onSessionEnd() : setError(errorMessage(err)),
    );
  }, [onSessionEnd]);

  if (!invitations) {
    return error ? (
      <p role="alert" className="rounded-panel border border-line bg-surface px-5 py-10 text-center text-[15px] text-danger">
        {error}
      </p>
    ) : (
      <p role="status" className="py-10 text-center text-[15px] text-muted">
        Cargando invitaciones…
      </p>
    );
  }

  const act = async (invitation: Invitation, action: "revoke" | "regenerate") => {
    setBusy(invitation.id);
    setRowError(null);
    try {
      const result = await platformApi<Invitation | Created>(`/invitations/${invitation.id}/${action}`, "POST");
      const refreshed = await platformApi<Invitation[]>("/invitations");
      setInvitations(refreshed);
      if ("token" in result) setDialog(result);
    } catch (err) {
      setRowError({ id: invitation.id, message: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-[-0.02em]">Invitaciones</h1>
        <button type="button" onClick={() => setDialog("new")} className={`${button.primary} ml-auto pl-3.5`}>
          <Plus size={18} strokeWidth={2.25} aria-hidden />
          Nueva invitación
        </button>
      </div>
      <p className="mt-1.5 text-[15px] text-muted text-pretty">
        Cada enlace sirve una sola vez y vence a las 24 horas. Con él, el dueño crea su negocio, su primera sede y su cuenta.
      </p>

      {invitations.length ? (
        <ul className="mt-6 divide-y divide-line rounded-panel border border-line bg-surface">
          {invitations.map((i) => {
            const expired = !i.used_at && !i.revoked_at && new Date(i.expires_at).getTime() <= now;
            const open = !i.used_at && !i.revoked_at && !expired;
            return (
              <li key={i.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p className={`truncate text-[15px] ${i.note ? "font-medium" : "text-muted"}`}>{i.note ?? "Sin nota"}</p>
                  <p className="figures truncate text-sm text-muted">
                    {PLAN_LABEL[i.plan_tier]}
                    {i.plan_tier === "MULTI" && ` · hasta ${i.max_locations} sedes`} · creada {dateTime(i.created_at)}
                    {open && ` · vence ${dateTime(i.expires_at)}`}
                    {i.organizations && ` · ${i.organizations.name} @${i.organizations.handle}`}
                  </p>
                  {rowError?.id === i.id && (
                    <p role="alert" className="mt-1 text-sm text-danger">
                      {rowError.message}
                    </p>
                  )}
                </div>
                {i.used_at && <span className={`${badge} bg-success-soft text-success`}>Usada</span>}
                {i.revoked_at && <span className={`${badge} bg-ground text-muted`}>Anulada</span>}
                {expired && <span className={`${badge} bg-ground text-muted`}>Vencida</span>}
                {open && <span className={`${badge} bg-warning-soft text-warning`}>Pendiente</span>}
                {!i.used_at && (
                  <div className="-mr-3 flex gap-1">
                    {open && (
                      <button type="button" disabled={busy === i.id} onClick={() => void act(i, "revoke")} className={button.quietDanger}>
                        Anular
                      </button>
                    )}
                    <button type="button" disabled={busy === i.id} onClick={() => void act(i, "regenerate")} className={button.ghost}>
                      Regenerar
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-6 rounded-panel border border-line bg-surface px-5 py-10 text-center text-[15px] text-muted">
          Todavía no has creado invitaciones.
        </p>
      )}

      <Dialog open={dialog !== null} onClose={() => setDialog(null)} title={dialog === "new" ? "Nueva invitación" : "Enlace de invitación"}>
        {dialog === "new" && (
          <InvitationForm
            onCreated={(created) => {
              setInvitations([created, ...invitations]);
              setDialog(created);
            }}
          />
        )}
        {dialog && dialog !== "new" && <InvitationLink invitation={dialog} onDone={() => setDialog(null)} />}
      </Dialog>
    </div>
  );
}

function InvitationForm({ onCreated }: { onCreated: (invitation: Created) => void }) {
  const [plan, setPlan] = useState<"SINGLE" | "MULTI">("SINGLE");
  const [max, setMax] = useState(3);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { plan_tier: plan, note: note.trim() || null, ...(plan === "MULTI" ? { max_locations: max } : {}) };
      onCreated(await platformApi<Created>("/invitations", "POST", body));
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-5">
      <fieldset>
        <legend className={labelClass}>Plan</legend>
        <div className="grid grid-cols-2 gap-2">
          {(["SINGLE", "MULTI"] as const).map((value) => (
            <label key={value} className={choice}>
              <input type="radio" name="plan" checked={plan === value} onChange={() => setPlan(value)} className="sr-only" />
              {PLAN_LABEL[value]}
            </label>
          ))}
        </div>
      </fieldset>
      {plan === "MULTI" ? (
        <label className="block">
          <span className={labelClass}>Tope de sedes</span>
          <select value={max} onChange={(e) => setMax(Number(e.target.value))} className={`${field} figures`}>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n} {n === 1 ? "sede" : "sedes"}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="text-sm text-muted">El plan {PLAN_LABEL.SINGLE} siempre tiene 1 sede.</p>
      )}
      <label className="block">
        <span className={labelClass}>Nota interna</span>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={300}
          placeholder="Opcional: para quién es"
          className={field}
        />
        <span className="mt-1.5 block text-sm text-muted">Solo la ves tú; el invitado no la ve.</span>
      </label>
      {error && (
        <p role="alert" className="rounded-control bg-danger-soft px-3 py-2.5 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end border-t border-line pt-5">
        <button type="submit" disabled={busy} className={button.primary}>
          {busy && <LoaderCircle size={18} className="animate-spin motion-reduce:[animation-duration:6s]" aria-hidden />}
          Crear enlace
        </button>
      </div>
    </form>
  );
}

function InvitationLink({ invitation, onDone }: { invitation: Created; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const link = `${window.location.origin}/registro/${invitation.token}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      // Clipboard blocked (permissions, insecure origin): the field stays selectable by hand.
    }
  };

  return (
    <div className="space-y-5">
      <p className="text-[15px] text-ink-2 text-pretty">
        Envíaselo al dueño del negocio. <strong className="font-semibold">Cópialo ahora:</strong> por seguridad no se vuelve a mostrar.
        Vence el {dateTime(invitation.expires_at)} y sirve una sola vez.
      </p>
      <div className="flex gap-2">
        <label className="min-w-0 flex-1">
          <span className="sr-only">Enlace</span>
          <input readOnly value={link} onFocus={(e) => e.target.select()} className={`${field} font-mono text-sm`} />
        </label>
        <button type="button" onClick={() => void copy()} className={button.secondary}>
          {copied ? <Check size={18} strokeWidth={2.25} aria-hidden /> : <Copy size={18} aria-hidden />}
          {copied ? "Copiado" : "Copiar"}
        </button>
      </div>
      <p aria-live="polite" className="sr-only">
        {copied ? "Enlace copiado" : ""}
      </p>
      <div className="flex justify-end border-t border-line pt-5">
        <button type="button" onClick={onDone} className={button.primary}>
          Listo
        </button>
      </div>
    </div>
  );
}
