"use client";

import { Delete, X } from "lucide-react";
import { useEffect, useState } from "react";
import { cop, qty } from "@/lib/format";

/** One line of the tape: a value and how many ("20.000 × 10"). */
interface Line {
  value: number;
  times: number;
}
/** Committed lines plus the one being typed; `times` is null until "×" is pressed. */
export interface Tape {
  lines: Line[];
  value: string;
  times: string | null;
}
export type Key = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "00" | "000" | "×" | "enter" | "back" | "clear";

export const EMPTY: Tape = { lines: [], value: "", times: null };
const VALUE_DIGITS = 9; // up to $ 999.999.999 per pile
const TIMES_DIGITS = 4; // up to 9.999 bills of one kind

const pending = (t: Tape) => Number(t.value || 0) * (t.times ? Number(t.times) : 1);
const amount = (l: Line) => l.value * l.times;
/** Committed lines plus the one being typed, so nothing typed is lost on submit. */
export const total = (t: Tape) => t.lines.reduce((sum, l) => sum + amount(l), 0) + pending(t);

/** Applies one key to the tape. Pure, so typing, the on-screen keys and tests share it. */
export function press(t: Tape, key: Key): Tape {
  const typingTimes = t.times !== null;
  if (/^\d+$/.test(key)) {
    const current = typingTimes ? t.times! : t.value;
    const next = (current + key).replace(/^0+(?=\d)/, "");
    if (next.length > (typingTimes ? TIMES_DIGITS : VALUE_DIGITS)) return t;
    return typingTimes ? { ...t, times: next } : { ...t, value: next };
  }
  switch (key) {
    case "×":
      return t.value && !typingTimes ? { ...t, times: "" } : t;
    case "enter": {
      const line: Line = { value: Number(t.value || 0), times: t.times ? Number(t.times) : 1 };
      return line.value * line.times ? { lines: [...t.lines, line], value: "", times: null } : { ...t, value: "", times: null };
    }
    case "back":
      if (typingTimes) return { ...t, times: t.times ? t.times.slice(0, -1) : null };
      return { ...t, value: t.value.slice(0, -1) };
    case "clear":
      return EMPTY;
  }
  return t;
}

const KEYBOARD: Record<string, Key> = { "*": "×", x: "×", X: "×", "+": "enter", Enter: "enter", Backspace: "back", Escape: "clear", Delete: "clear" };

const keyBase =
  "flex h-[52px] items-center justify-center rounded-xl font-[650] shadow-[inset_0_0_0_1px_var(--color-line)] transition-[background-color,scale] duration-150 ease-out [-webkit-tap-highlight-color:transparent] motion-safe:enabled:active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50";
const keyStyle = {
  digit: `${keyBase} bg-ground text-xl hover:enabled:bg-[#e9ebe6]`,
  fn: `${keyBase} bg-ground text-[15px] text-ink-2 hover:enabled:bg-[#e9ebe6]`,
  enter: `${keyBase} bg-accent text-[15px] text-white shadow-none hover:enabled:bg-accent-strong`,
};

/**
 * Cash count keypad, like a supermarket register: type a value, optionally "×" and how many, then "Ingresar".
 * A wrong line is removed with its ✕. Physical keys work too (digits, * or x, Enter or +, Backspace, Esc).
 */
export function CashKeypad({ label, disabled, onChange }: { label: string; disabled?: boolean; onChange: (total: number) => void }) {
  const [tape, setTape] = useState<Tape>(EMPTY);

  const apply = (next: Tape) => {
    setTape(next);
    onChange(total(next));
  };
  const tap = (key: Key) => apply(press(tape, key));

  useEffect(() => {
    if (disabled) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.ctrlKey || e.metaKey || e.altKey || target.closest("input, textarea, select, dialog")) return;
      // Enter on a focused button presses that button (the submit one included), not "Ingresar".
      if (e.key === "Enter" && target.closest("button")) return;
      const key = /^\d$/.test(e.key) ? (e.key as Key) : KEYBOARD[e.key];
      if (!key) return;
      e.preventDefault();
      setTape((t) => {
        const next = press(t, key);
        onChange(total(next));
        return next;
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [disabled, onChange]);

  const typing = tape.value !== "";
  // Same grid as a till: digits on the left three columns, functions down the right one, "Ingresar" at the end.
  const keys: [Key, string, keyof typeof keyStyle][] = [
    ["7", "7", "digit"],
    ["8", "8", "digit"],
    ["9", "9", "digit"],
    ["clear", "Borrar todo", "fn"],
    ["4", "4", "digit"],
    ["5", "5", "digit"],
    ["6", "6", "digit"],
    ["back", "Borrar", "fn"],
    ["1", "1", "digit"],
    ["2", "2", "digit"],
    ["3", "3", "digit"],
    ["×", "Multiplicar", "fn"],
    ["00", "Dos ceros", "digit"],
    ["0", "0", "digit"],
    ["000", "Tres ceros", "digit"],
    ["enter", "Ingresar", "enter"],
  ];
  const screen = tape.times !== null ? `${cop(Number(tape.value))} × ${tape.times || "…"}` : typing ? cop(Number(tape.value)) : "$ 0";

  return (
    // Container query, not viewport: with the sidebar a 768px tablet leaves too little room for two columns.
    <div className="@container">
      <div className="grid gap-[18px] @2xl:grid-cols-[minmax(0,1fr)_minmax(0,300px)] @2xl:items-start">
        <div>
          <h3 className="mb-2 text-[13px] font-bold text-muted">{label}</h3>
          <ol aria-label="Conteo" className="grid max-h-[260px] content-start gap-1 overflow-y-auto overscroll-contain">
            {tape.lines.length ? (
              tape.lines.map((line, i) => (
                <li key={i} className="figures grid grid-cols-[1fr_auto_36px] items-center gap-2 rounded-control bg-ground py-1.5 pr-1 pl-3">
                  <span>
                    {cop(line.value)}
                    {line.times !== 1 && <small className="text-muted"> × {qty(line.times)}</small>}
                  </span>
                  <b className="font-bold">{cop(amount(line))}</b>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => apply({ ...tape, lines: tape.lines.filter((_, j) => j !== i) })}
                    aria-label={`Quitar ${cop(amount(line))}`}
                    className="grid size-9 place-items-center rounded-lg text-muted transition-[background-color,color] duration-150 hover:bg-surface hover:text-danger"
                  >
                    <X size={16} aria-hidden />
                  </button>
                </li>
              ))
            ) : (
              <li className="py-2.5 text-sm text-muted">Escribe cada billete o monto e Ingresar. Ej.: 50000 × 3.</li>
            )}
          </ol>
        </div>

        <div>
          <div aria-live="polite" className="mb-2.5 flex min-h-16 flex-col justify-center rounded-[14px] bg-ink px-4 py-3 text-white">
            <small className="text-[12.5px] text-white/60">{tape.times !== null ? "Cantidad" : "Monto"}</small>
            <b className="figures font-display text-[26px] tracking-[-0.01em]">{screen}</b>
          </div>
          <div className="grid grid-cols-4 gap-1.5" role="group" aria-label="Teclado">
            {keys.map(([key, name, style]) => (
              <button
                key={key}
                type="button"
                disabled={disabled}
                onClick={() => tap(key)}
                aria-label={/^\d+$/.test(name) || key === "enter" ? undefined : name}
                className={keyStyle[style]}
              >
                {key === "back" ? <Delete size={16} aria-hidden /> : key === "clear" ? "C" : key === "enter" ? "Ingresar" : key}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
