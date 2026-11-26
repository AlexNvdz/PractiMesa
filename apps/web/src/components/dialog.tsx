"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef } from "react";

/**
 * Modal on the native <dialog>: focus trap, Escape and backdrop close, focus returns to the opener.
 * Children mount only while open, so each opening starts with fresh state.
 */
export function Dialog({
  open,
  onClose,
  title,
  wide = false,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Long forms (product editor). */
  wide?: boolean;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      // A click on the backdrop lands on the dialog element itself.
      onClick={(e) => e.target === e.currentTarget && onClose()}
      className={`m-auto max-h-[calc(100dvh-32px)] w-[calc(100%-32px)] ${wide ? "max-w-[640px]" : "max-w-[480px]"} overflow-y-auto overscroll-contain rounded-sheet border border-transparent bg-surface p-0 text-ink shadow-panel transition-[opacity,scale,display,overlay] transition-discrete duration-150 ease-out backdrop:bg-ink/30 not-open:opacity-0 starting:open:opacity-0 motion-safe:not-open:scale-[0.96] motion-safe:starting:open:scale-[0.96]`}
    >
      <div className="p-5 sm:p-6">
        <div className="mb-5 flex items-start justify-between gap-4">
          <h2 id={titleId} className="pt-1.5 font-display text-lg font-bold tracking-[-0.01em] text-balance">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="-mt-0.5 -mr-2 flex size-10 shrink-0 items-center justify-center rounded-control text-ink-2 transition-[background-color] duration-150 hover:bg-ground"
          >
            <X size={20} aria-hidden />
          </button>
        </div>
        {open && children}
      </div>
    </dialog>
  );
}
