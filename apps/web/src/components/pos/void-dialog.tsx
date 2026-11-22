"use client";

import { LoaderCircle, ShieldCheck } from "lucide-react";
import { useId, useState } from "react";
import { FormAlert } from "@/components/form-alert";
import { button, choice, field } from "@/components/ui";
import { errorMessage } from "@/lib/api";
import { VOID_REASONS, type VoidReason } from "@/lib/pos";

const labelClass = "mb-1.5 block text-sm font-medium text-ink-2";

/** Body of POST …/void and …/cancel: the reason and, for cashiers and waiters, who authorizes (Q54, Q61). */
export interface VoidBody {
  reason: VoidReason;
  note?: string;
  authorization?: { username: string; pin: string };
}

/**
 * Reason for a void or a cancel and, when the role needs it, a supervisor's (or the owner's) username + PIN,
 * typed by that person on this device. One authorization covers this action only (Q60).
 */
export function VoidForm({
  body,
  action,
  needsApproval,
  onSubmit,
  onBack,
}: {
  body: string;
  action: string;
  needsApproval: boolean;
  onSubmit: (data: VoidBody) => Promise<void>;
  onBack: () => void;
}) {
  const [reason, setReason] = useState<VoidReason | null>(null);
  const [note, setNote] = useState("");
  const [username, setUsername] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!reason) return setError("Elige el motivo.");
    if (reason === "OTHER" && !note.trim()) return setError("Escribe el motivo.");
    if (needsApproval && (!username || pin.length < 4)) return setError("Quien autoriza escribe su usuario y su PIN.");
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        reason,
        ...(reason === "OTHER" ? { note: note.trim() } : {}),
        ...(needsApproval ? { authorization: { username, pin } } : {}),
      });
    } catch (err) {
      setError(errorMessage(err));
      setPin("");
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-5">
      <p className="text-[15px] text-ink-2 text-pretty">{body}</p>
      <fieldset>
        <legend className={labelClass}>Motivo</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {(Object.keys(VOID_REASONS) as VoidReason[]).map((r) => (
            <label key={r} className={`${choice} justify-start text-left`}>
              <input type="radio" name="void-reason" checked={reason === r} onChange={() => setReason(r)} className="sr-only" />
              {VOID_REASONS[r]}
            </label>
          ))}
        </div>
      </fieldset>
      {reason === "OTHER" && (
        <label className="block">
          <span className={labelClass}>¿Cuál?</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={120} className={field} />
        </label>
      )}

      {needsApproval && (
        <fieldset className="rounded-control border border-line p-4">
          <legend className="flex items-center gap-1.5 px-1 text-sm font-medium text-ink-2">
            <ShieldCheck size={16} strokeWidth={2.25} aria-hidden />
            Autoriza un supervisor o el dueño
          </legend>
          <p className="mb-4 text-sm text-muted text-pretty">Que escriba su usuario y su PIN aquí. Queda registrado quién autorizó.</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className={labelClass}>Usuario</span>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value.toLowerCase().trim())}
                maxLength={30}
                autoCapitalize="none"
                autoComplete="off"
                spellCheck={false}
                aria-describedby={error ? errorId : undefined}
                className={`${field} font-mono`}
              />
            </label>
            <label className="block">
              <span className={labelClass}>PIN</span>
              <input
                type="password"
                inputMode="numeric"
                autoComplete="off"
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                aria-describedby={error ? errorId : undefined}
                className={`${field} figures tracking-[0.3em]`}
              />
            </label>
          </div>
        </fieldset>
      )}

      {error && <FormAlert id={errorId}>{error}</FormAlert>}
      <div className="flex justify-end gap-2 border-t border-line pt-5">
        <button type="button" onClick={onBack} className={button.secondary}>
          Volver
        </button>
        <button type="submit" disabled={busy} className={button.danger}>
          {busy && <LoaderCircle size={18} className="animate-spin motion-reduce:[animation-duration:6s]" aria-hidden />}
          {action}
        </button>
      </div>
    </form>
  );
}
