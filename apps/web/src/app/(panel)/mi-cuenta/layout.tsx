import type { Metadata } from "next";

export const metadata: Metadata = { title: "Mi cuenta" };

export default function MiCuentaLayout({ children }: LayoutProps<"/mi-cuenta">) {
  return children;
}
