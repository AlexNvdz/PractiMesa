"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef } from "react";

/**
 * Modal on the native <dialog>: focus trap, Escape and backdrop close, focus returns to the opener.
 * Children mount only while open, so each opening starts with fresh state.
 * `side` opens it as a sheet from the right (from the bottom on phones) for editing a row of a long list.
 */
export function Dialog({
  open,
  onClose,
  title,
  subtitle,
  wide = false,
  side = false,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  /** One line under the title (where it applies, what it does). */
  subtitle?: string;
  /** Long forms (product editor). */
  wide?: boolean;
  side?: boolean;
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

  const frame = side
    ? "m-0 ml-auto h-dvh max-h-none w-[min(460px,100%)] max-w-none rounded-l-[22px] shadow-[-24px_0_60px_-30px_rgb(23_30_46/0.45)] duration-300 ease-[cubic-bezier(0.2,0,0,1)] motion-safe:not-open:translate-x-full motion-safe:starting:open:translate-x-full max-sm:mt-auto max-sm:h-[92dvh] max-sm:w-full max-sm:rounded-t-[22px] max-sm:rounded-l-none motion-safe:max-sm:not-open:translate-x-0 motion-safe:max-sm:not-open:translate-y-full motion-safe:max-sm:starting:open:translate-x-0 motion-safe:max-sm:starting:open:translate-y-full"
    : `m-auto max-h-[calc(100dvh-32px)] w-[calc(100%-32px)] ${wide ? "max-w-[640px]" : "max-w-[480px]"} rounded-[22px] shadow-[0_30px_80px_-24px_rgb(23_30_46/0.5)] duration-300 ease-[cubic-bezier(0.2,0,0,1)] motion-safe:not-open:translate-y-3 motion-safe:starting:open:translate-y-3`;

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      // A click on the backdrop lands on the dialog element itself.
      onClick={(e) => e.target === e.currentTarget && onClose()}
      className={`${frame} overflow-hidden overscroll-contain border border-transparent bg-surface p-0 text-ink transition-[opacity,translate,display,overlay] transition-discrete backdrop:bg-ink/[0.34] not-open:opacity-0 starting:open:opacity-0 open:flex open:flex-col`}
    >
      <header className="flex shrink-0 items-start gap-3 border-b border-line px-6 pt-[22px] pb-4">
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="font-display text-2xl font-bold tracking-[-0.02em] text-balance">
            {title}
          </h2>
          {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Cerrar"
          className="-mt-0.5 -mr-2 grid size-10 shrink-0 place-items-center rounded-control text-ink-2 transition-[background-color] duration-150 hover:bg-ground"
        >
          <X size={20} aria-hidden />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-5">{open && children}</div>
    </dialog>
  );
}
