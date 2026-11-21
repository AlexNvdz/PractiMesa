import type { Metadata } from "next";

export const metadata: Metadata = { title: "Caja" };

export default function CajaLayout({ children }: LayoutProps<"/caja">) {
  return children;
}
