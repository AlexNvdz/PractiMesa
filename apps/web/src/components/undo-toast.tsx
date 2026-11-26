"use client";

import { LoaderCircle } from "lucide-react";
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
      // Floats over the board: shadow, plus a transparent border so forced-colors mode still draws an edge.
      className="enter fixed inset-x-4 bottom-[calc(76px+env(safe-area-inset-bottom))] z-40 sm:bottom-4 mx-auto flex max-w-md items-center gap-3 rounded-panel border border-transparent bg-surface py-2 pr-2 pl-4 text-[15px] text-ink shadow-panel"
    >
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
        className="inline-flex h-11 shrink-0 items-center gap-2 rounded-control px-3 font-semibold text-accent-strong transition-[background-color,scale] duration-150 ease-out hover:enabled:bg-accent-soft disabled:opacity-60 motion-safe:enabled:active:scale-[0.96]"
      >
        {busy && <LoaderCircle size={18} className="animate-spin motion-reduce:[animation-duration:6s]" aria-hidden />}
        Deshacer
      </button>
    </div>
  );
}
