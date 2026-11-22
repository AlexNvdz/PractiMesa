import type { Metadata } from "next";

export const metadata: Metadata = { title: "Sedes" };

export default function SedesLayout({ children }: LayoutProps<"/sedes">) {
  return children;
}
