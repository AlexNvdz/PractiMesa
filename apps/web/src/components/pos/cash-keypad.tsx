"use client";

import { CornerDownLeft, Delete, X } from "lucide-react";
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
  "flex h-14 items-center justify-center rounded-control border transition-[background-color,scale] duration-150 ease-out [-webkit-tap-highlight-color:transparent] motion-safe:enabled:active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50";
const keyStyle = {
  digit: `${keyBase} border-line-strong bg-surface text-xl font-medium text-ink hover:enabled:bg-ground`,
  op: `${keyBase} border-line-strong bg-ground text-xl font-medium text-ink-2 hover:enabled:bg-line`,
  clear: `${keyBase} border-line-strong bg-surface text-base font-medium text-danger hover:enabled:bg-danger-soft`,
  enter: `${keyBase} flex-col gap-1 border-transparent bg-ink text-sm font-semibold text-surface hover:enabled:bg-ink-2`,
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
  const keys: [Key, string, keyof typeof keyStyle, string?][] = [
    ["clear", "Borrar todo", "clear"],
    ["back", "Borrar", "op"],
    ["×", "Multiplicar", "op"],
    ["enter", "Ingresar", "enter", "row-span-5 h-auto"],
    ["7", "7", "digit"],
    ["8", "8", "digit"],
    ["9", "9", "digit"],
    ["4", "4", "digit"],
    ["5", "5", "digit"],
    ["6", "6", "digit"],
    ["1", "1", "digit"],
    ["2", "2", "digit"],
    ["3", "3", "digit"],
    ["0", "0", "digit"],
    ["00", "Dos ceros", "digit"],
    ["000", "Tres ceros", "digit"],
  ];

  return (
    // Container query, not viewport: with the sidebar a 768px tablet leaves too little room for two columns.
    <div className="@container">
      <div className="grid gap-4 @2xl:grid-cols-[minmax(0,1fr)_20rem] @2xl:items-start">
        <div className="flex min-h-40 flex-col rounded-panel border border-line bg-ground @2xl:min-h-[15.5rem]">
          <ol aria-label="Conteo" className="flex-1 space-y-1 px-4 pt-3 pb-2">
            {tape.lines.map((line, i) => (
              <li key={i} className="figures flex items-center gap-2 text-[15px] text-ink-2">
                <span className="flex-1">
                  {qty(line.value)}
                  {line.times !== 1 && <span className="text-muted"> × {qty(line.times)}</span>}
                </span>
                <span className="text-ink">{cop(amount(line))}</span>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => apply({ ...tape, lines: tape.lines.filter((_, j) => j !== i) })}
                  aria-label={`Quitar ${qty(line.value)}${line.times !== 1 ? ` por ${line.times}` : ""}`}
                  className="-mr-2 flex size-8 shrink-0 items-center justify-center rounded-control text-muted transition-[background-color,color] duration-150 hover:bg-surface hover:text-danger"
                >
                  <X size={16} strokeWidth={2} aria-hidden />
                </button>
              </li>
            ))}
            <li className={`figures flex items-center gap-2 text-[15px] ${typing ? "text-ink" : "text-muted"}`} aria-label="Escribiendo">
              <span className="flex-1">
                {typing ? qty(tape.value) : tape.lines.length ? "Siguiente valor" : "Escribe un valor, × y la cantidad, e Ingresar"}
                {tape.times !== null && <span> × {tape.times ? qty(tape.times) : ""}</span>}
                {!disabled && <span aria-hidden className="ml-0.5 inline-block h-[1.1em] w-px translate-y-[0.2em] bg-accent motion-safe:animate-pulse" />}
              </span>
              {typing && tape.times && <span>{cop(pending(tape))}</span>}
              {tape.lines.length > 0 && <span className="size-8 shrink-0" aria-hidden />}
            </li>
          </ol>
          <p className="flex items-baseline justify-between gap-3 border-t border-line px-4 py-3">
            <span className="text-sm font-medium text-ink-2">{label}</span>
            <output aria-live="polite" className="figures text-2xl font-semibold tracking-[-0.01em] text-ink">
              {cop(total(tape))}
            </output>
          </p>
        </div>

        <div className="grid grid-cols-4 gap-2" role="group" aria-label="Teclado">
          {keys.map(([key, name, style, extra]) => (
            <button
              key={key}
              type="button"
              disabled={disabled}
              onClick={() => tap(key)}
              aria-label={/^\d+$/.test(name) || key === "enter" ? undefined : name}
              className={`${keyStyle[style]} ${extra ?? ""}`}
            >
              {key === "back" ? (
                <Delete size={22} strokeWidth={2} aria-hidden />
              ) : key === "clear" ? (
                "C"
              ) : key === "enter" ? (
                <>
                  <CornerDownLeft size={22} strokeWidth={2.25} aria-hidden />
                  Ingresar
                </>
              ) : (
                <span className={key === "×" ? "text-2xl" : ""}>{key}</span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
