"use client";

import { LoaderCircle } from "lucide-react";
import { useId, useState } from "react";
import { FormAlert } from "@/components/form-alert";
import { button, choice, field } from "@/components/ui";
import { errorMessage } from "@/lib/api";
import { VOID_REASONS, type VoidReason } from "@/lib/pos";

const labelClass = "mb-1.5 block text-sm font-medium text-ink-2";

/** Body of POST …/void and …/cancel: the reason (Q61); who did it comes from the session. */
export interface VoidBody {
  reason: VoidReason;
  note?: string;
}

/** Reason for a void or a cancel (Q54, Q61). */
export function VoidForm({
  body,
  action,
  onSubmit,
  onBack,
}: {
  body: string;
  action: string;
  onSubmit: (data: VoidBody) => Promise<void>;
  onBack: () => void;
}) {
  const [reason, setReason] = useState<VoidReason | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!reason) return setError("Elige el motivo.");
    if (reason === "OTHER" && !note.trim()) return setError("Escribe el motivo.");
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        reason,
        ...(reason === "OTHER" ? { note: note.trim() } : {}),
      });
    } catch (err) {
      setError(errorMessage(err));
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
