import type { Metadata } from "next";

export const metadata: Metadata = { title: "Mesas y zonas" };

export default function EditarMesasLayout({ children }: LayoutProps<"/mesas/editar">) {
  return children;
}
