import type { Metadata } from "next";

export const metadata: Metadata = { title: "Dispositivos" };

export default function DispositivosLayout({ children }: LayoutProps<"/dispositivos">) {
  return children;
}
