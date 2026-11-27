"use client";

import { useEffect, useRef, useState } from "react";

/**
 * End of a long list: calls `onNear` when it comes within 600px of the viewport (so the next page is ready before
 * the person gets there) and says how much is shown. Keeps asking while it stays in view, e.g. on tall screens.
 */
export function Sentinel({ onNear, busy = false, children }: { onNear?: () => void; busy?: boolean; children: React.ReactNode }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const near = useRef(onNear);
  useEffect(() => {
    near.current = onNear;
  });
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => setVisible(entries[0].isIntersecting), { rootMargin: "600px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Re-runs after every page (busy flips), so a short first page still fills the screen.
  useEffect(() => {
    if (visible && !busy) near.current?.();
  }, [visible, busy, children]);

  return (
    <p ref={ref} aria-live="polite" className="min-h-[50px] p-4 text-center text-[13.5px] text-muted">
      {children}
    </p>
  );
}
