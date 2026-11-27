import type { Metadata } from "next";

export const metadata: Metadata = { title: "Bienvenido de vuelta" };

export default function LoginLayout({ children }: LayoutProps<"/login">) {
  return children;
}
