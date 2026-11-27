"use client";

import { ConciergeBell, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export interface Undo {
  message: string;
  /** Reverts the action; reports its own errors. */
  run: () => Promise<void>;
}

const SECONDS = 8;

/**
 * "Deshacer" notice after a tap that is easy to get wrong (kitchen steps, a delivered round). It stays
 * SECONDS, paused while the pointer or focus is on it, so nobody has to race the timer.
 */
export function UndoToast({ undo, onClose }: { undo: Undo | null; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });

  const start = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => close.current(), SECONDS * 1000);
  };
  const pause = () => clearTimeout(timer.current);

  useEffect(() => {
    if (!undo) return;
    timer.current = setTimeout(() => close.current(), SECONDS * 1000);
    return () => clearTimeout(timer.current);
  }, [undo]);

  if (!undo) return null;
  return (
    <div
      role="status"
      onPointerEnter={pause}
      onPointerLeave={start}
      onFocus={pause}
      onBlur={start}
      // Dark toast, centred at the bottom (clear of the tab bar and the floating "Para llevar" button).
      className="enter fixed inset-x-0 bottom-6 z-40 mx-auto flex w-max max-w-[calc(100vw-32px)] items-center gap-3.5 rounded-[14px] bg-ink py-2.5 pr-2.5 pl-4 text-[14.5px] text-white shadow-panel max-sm:bottom-[calc(84px+env(safe-area-inset-bottom))] sm:max-[852px]:bottom-[88px]"
    >
      {/* Handing food over is the bell moment: the one place a toast carries the service yellow. */}
      {/: lista$/.test(undo.message) && <ConciergeBell size={16} aria-hidden className="shrink-0 text-ready" />}
      <p className="min-w-0 flex-1">{undo.message}</p>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await undo.run();
          } finally {
            setBusy(false);
            onClose();
          }
        }}
        className="inline-flex h-9 shrink-0 items-center gap-2 rounded-control bg-white/12 px-3.5 font-bold text-white transition-[background-color,scale] duration-150 ease-out hover:enabled:bg-white/20 disabled:opacity-60 motion-safe:enabled:active:scale-[0.96]"
      >
        {busy && <LoaderCircle size={18} className="animate-spin motion-reduce:[animation-duration:6s]" aria-hidden />}
        Deshacer
      </button>
    </div>
  );
}
