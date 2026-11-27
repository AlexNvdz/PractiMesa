"use client";

import { useEffect, useState } from "react";

/** Placeholder rows for a list that is loading (same grid as the real rows, so nothing jumps). Announced once by `label`. */
export function RowSkeleton({ rows = 8, label }: { rows?: number; label?: string }) {
  return (
    <>
      {label && (
        <p role="status" className="sr-only">
          {label}
        </p>
      )}
      <ul aria-hidden className="pm-card divide-y divide-line">
        {Array.from({ length: rows }, (_, i) => (
          <li key={i} className="grid min-h-16 grid-cols-[1.6fr_1fr_110px] items-center gap-4 px-3.5 py-3 sm:px-[18px]">
            <span className="grid gap-2">
              <i className="sk-bar h-3" />
              <i className="sk-bar h-2.5 w-2/5" />
            </span>
            <i className="sk-bar h-3 max-sm:hidden" />
            <i className="sk-bar h-3" />
          </li>
        ))}
      </ul>
    </>
  );
}

/** Placeholder cards for a grid of cards (catalog, devices, locations). */
export function CardSkeleton({ cards = 6, min = 230, label }: { cards?: number; min?: number; label?: string }) {
  return (
    <>
      {label && (
        <p role="status" className="sr-only">
          {label}
        </p>
      )}
      <ul aria-hidden className="grid gap-3" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))` }}>
        {Array.from({ length: cards }, (_, i) => (
          <li key={i} className="pm-card grid min-h-[150px] content-start gap-3 p-4">
            <i className="sk-bar h-3" />
            <i className="sk-bar h-[22px] w-1/2" />
            <i className="sk-bar h-3" />
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * True for the first moments after a screen's data arrives: its cards enter one after another (100ms apart, `enter` + --i).
 * Later updates (a card removed, a switch toggled) must not replay the entrance.
 */
export function useFirstPaint(ready: boolean) {
  const [fresh, setFresh] = useState(true);
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => setFresh(false), 1500);
    return () => clearTimeout(timer);
  }, [ready]);
  return fresh;
}
