import { AlertCircle } from "lucide-react";

/** Form-level error under the fields, announced when it appears. */
export function FormAlert({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <p id={id} role="alert" className="flex items-start gap-2 rounded-control bg-danger-soft px-3 py-2.5 text-sm text-danger">
      <AlertCircle size={16} strokeWidth={2.25} className="mt-0.5 shrink-0" aria-hidden />
      {children}
    </p>
  );
}
