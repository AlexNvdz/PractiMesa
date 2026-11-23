import type { Metadata } from "next";

export const metadata: Metadata = { title: "Equipo" };

export default function EquipoLayout({ children }: LayoutProps<"/equipo">) {
  return children;
}
