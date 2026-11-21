import type { Metadata } from "next";

export const metadata: Metadata = { title: "Mesas" };

export default function MesasLayout({ children }: LayoutProps<"/mesas">) {
  return children;
}
