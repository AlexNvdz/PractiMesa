import type { Metadata } from "next";

export const metadata: Metadata = { title: "Cocina" };

export default function CocinaLayout({ children }: LayoutProps<"/cocina">) {
  return children;
}
