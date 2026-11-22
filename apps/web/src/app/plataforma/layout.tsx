import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Plataforma",
  robots: { index: false },
};

export default function PlataformaLayout({ children }: LayoutProps<"/plataforma">) {
  return children;
}
