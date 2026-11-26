// Shared control styles (DESIGN.md): 44px controls, 150ms color transitions, press scale 0.96 when motion is allowed.
// Each variant sets its own weight and color so no two utilities of the same property meet on one element.
const base =
  "inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-control px-[18px] text-[15px] whitespace-nowrap transition-[background-color,border-color,color,scale] duration-150 ease-out motion-safe:enabled:active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-50";

export const button = {
  primary: `${base} bg-accent font-semibold text-surface hover:enabled:bg-accent-strong`,
  secondary: `${base} border border-line-strong bg-surface font-semibold text-ink-2 hover:enabled:border-muted hover:enabled:text-ink`,
  /** Only for handing food over ("Marcar entregada", "Entregada"): yellow means food is ready. */
  ready: `${base} bg-ready font-semibold text-ready-ink hover:enabled:bg-[#e5a800]`,
  danger: `${base} bg-danger font-semibold text-surface hover:enabled:bg-[#991b1b]`,
  ghost: `${base} font-medium text-ink-2 hover:enabled:bg-ground hover:enabled:text-ink`,
  quietDanger: `${base} font-medium text-danger hover:enabled:bg-danger-soft`,
};

export const field =
  "h-12 w-full rounded-control border border-line-strong bg-surface px-3.5 text-base text-ink placeholder:text-muted transition-[border-color] duration-150 hover:border-muted focus:border-accent focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent aria-[invalid=true]:border-danger";

/** Segmented choice (tip, payment method): a radio styled as a button. */
export const choice =
  "flex min-h-11 cursor-pointer items-center justify-center rounded-control border border-line-strong bg-surface px-3 text-center text-sm font-medium text-ink-2 transition-[background-color,border-color,color] duration-150 hover:not-has-checked:bg-ground has-checked:border-accent has-checked:bg-accent-soft has-checked:text-accent-strong has-disabled:cursor-not-allowed has-disabled:opacity-50 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent";
