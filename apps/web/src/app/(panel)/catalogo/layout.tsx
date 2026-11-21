import type { Metadata } from "next";

export const metadata: Metadata = { title: "Catálogo" };

export default function CatalogoLayout({ children }: LayoutProps<"/catalogo">) {
  return children;
}
