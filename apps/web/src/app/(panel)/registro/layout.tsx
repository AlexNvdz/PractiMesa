import type { Metadata } from "next";

export const metadata: Metadata = { title: "Registro" };

export default function RegistroLayout({ children }: LayoutProps<"/registro">) {
  return children;
}
