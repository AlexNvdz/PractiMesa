/** PractiMesa mark: a P drawn as a plate rim seen from above; the yellow dot is the plate served (same yellow as "ready to serve"). */
export function LogoMark({ size = 40, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden className={`shrink-0 ${className ?? ""}`}>
      <rect width="40" height="40" rx="11" fill="var(--color-accent)" />
      <rect x="10.5" y="9" width="5.6" height="22" rx="2.8" fill="#fff" />
      <circle cx="21.6" cy="17" r="6.6" fill="none" stroke="#fff" strokeWidth="5.6" />
      <circle cx="21.6" cy="17" r="2.3" fill="var(--color-ready)" />
    </svg>
  );
}

/** Mark + name. The name is real text, so the logo reads as "PractiMesa" to screen readers. */
export function Logo({ size = 40, className, nameClassName }: { size?: number; className?: string; nameClassName?: string }) {
  return (
    <span className={`flex items-center gap-3 ${className ?? ""}`}>
      <LogoMark size={size} />
      <span className={`font-display font-[750] tracking-[-0.025em] whitespace-nowrap text-accent [font-variation-settings:'opsz'_48] ${nameClassName ?? ""}`}>
        PractiMesa
      </span>
    </span>
  );
}
