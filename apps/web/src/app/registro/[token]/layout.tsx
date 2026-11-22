import { LoaderCircle } from "lucide-react";
import type { Metadata } from "next";
import { Suspense } from "react";

export const metadata: Metadata = { title: "Crea tu negocio", robots: { index: false } };

// The token is only known per request: useParams suspends, so the page needs a boundary (cacheComponents).
export default function RegistroLayout({ children }: LayoutProps<"/registro/[token]">) {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-dvh items-center justify-center text-muted">
          <LoaderCircle size={22} className="animate-spin motion-reduce:[animation-duration:6s]" aria-hidden />
        </div>
      }
    >
      {children}
    </Suspense>
  );
}
