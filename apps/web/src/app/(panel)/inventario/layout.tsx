import type { Metadata } from "next";

export const metadata: Metadata = { title: "Inventario" };

export default function InventarioLayout({ children }: LayoutProps<"/inventario">) {
  return children;
}
