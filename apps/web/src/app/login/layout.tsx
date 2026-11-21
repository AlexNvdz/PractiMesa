import type { Metadata } from "next";

export const metadata: Metadata = { title: "Inicia sesión" };

export default function LoginLayout({ children }: LayoutProps<"/login">) {
  return children;
}
