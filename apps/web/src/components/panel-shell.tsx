"use client";

import {
  BookOpen,
  LoaderCircle,
  ChartColumn,
  ChefHat,
  House,
  LayoutGrid,
  LogOut,
  MapPin,
  Menu,
  Package,
  ReceiptText,
  Wallet,
  X,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ROLE_LABEL, useAuth, type Me, type Role } from "@/lib/auth";

interface NavItem {
  label: string;
  icon: LucideIcon;
  href?: string; // modules without a route yet render as "Pronto"
  roles?: Role[]; // hidden from other roles
}

const NAV: NavItem[] = [
  { label: "Inicio", icon: House, href: "/" },
  { label: "Mesas", icon: LayoutGrid, href: "/mesas", roles: ["OWNER", "ADMIN", "CASHIER", "WAITER"] },
  { label: "Pedidos", icon: ReceiptText },
  { label: "Caja", icon: Wallet, href: "/caja", roles: ["OWNER", "ADMIN", "CASHIER"] },
  { label: "Cocina", icon: ChefHat, href: "/cocina", roles: ["OWNER", "ADMIN", "KITCHEN"] },
  { label: "Catálogo", icon: BookOpen, href: "/catalogo", roles: ["OWNER", "ADMIN"] },
  { label: "Inventario", icon: Package },
  { label: "Reportes", icon: ChartColumn },
];

const initials = (name: string) =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

function Sidebar({ me, onNavigate }: { me: Me; onNavigate?: () => void }) {
  const pathname = usePathname();
  const { logout } = useAuth();
  const plan =
    me.organization.plan_tier === "SINGLE" ? "Plan Pequeño" : "Plan Multilocal";

  return (
    <div className="flex h-full flex-col">
      {/* 56px row shares the header's centreline. */}
      <p className="flex h-14 shrink-0 items-center border-b border-line px-5 text-xl font-semibold tracking-[-0.02em]">
        PractiMesa
      </p>
      <div className="px-5 pt-4 pb-3">
        <p className="truncate text-sm font-medium text-ink">
          {me.organization.name}
        </p>
        <p className="text-xs text-muted">{plan}</p>
      </div>

      <nav
        aria-label="Principal"
        className="flex-1 overflow-y-auto overscroll-contain px-3 py-2"
      >
        <ul className="space-y-0.5">
          {NAV.filter((item) => !item.roles || item.roles.includes(me.user.role)).map(({ label, icon: Icon, href }) => {
            if (!href) {
              return (
                <li key={label}>
                  <span
                    aria-disabled="true"
                    className="flex h-10 items-center gap-3 rounded-control px-3 text-sm text-muted"
                  >
                    <Icon size={18} aria-hidden />
                    {label}
                    <span className="ml-auto rounded-full bg-ground px-2 py-0.5 text-xs font-medium text-muted">
                      Pronto
                    </span>
                  </span>
                </li>
              );
            }
            const active = pathname === href;
            return (
              <li key={label}>
                <Link
                  href={href}
                  onClick={onNavigate}
                  aria-current={active ? "page" : undefined}
                  className={`flex h-10 items-center gap-3 rounded-control px-3 text-sm transition-[background-color,color] duration-150 ${
                    active
                      ? "bg-accent-soft font-medium text-accent-strong"
                      : "text-ink-2 hover:bg-ground hover:text-ink"
                  }`}
                >
                  {/* Stroke follows the label weight: 2 at 400, 2.25 at 500 (18px icon). */}
                  <Icon size={18} strokeWidth={active ? 2.25 : 2} aria-hidden />
                  {label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="border-t border-line p-3">
        <div className="flex items-center gap-3 px-2 py-1.5">
          <span
            aria-hidden
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent-strong"
          >
            {initials(me.user.full_name)}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{me.user.full_name}</p>
            <p className="truncate text-xs text-muted">
              {ROLE_LABEL[me.user.role]}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void logout()}
          className="mt-1 flex h-10 w-full items-center gap-3 rounded-control px-3 text-sm text-ink-2 transition-[background-color,color] duration-150 hover:bg-ground hover:text-ink"
        >
          <LogOut size={18} aria-hidden />
          Cerrar sesión
        </button>
      </div>
    </div>
  );
}

export function PanelLoading() {
  return (
    <div
      className="flex min-h-dvh items-center justify-center text-muted"
      role="status"
    >
      <LoaderCircle
        size={22}
        className="animate-spin motion-reduce:[animation-duration:6s]"
        aria-hidden
      />
      <span className="sr-only">Cargando tu panel…</span>
    </div>
  );
}

export function PanelShell({
  me,
  title,
  wide = false,
  children,
}: {
  me: Me;
  title: string;
  /** Operation screens (table map) use the whole width. */
  wide?: boolean;
  children: React.ReactNode;
}) {
  const { setLocation } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const drawer = useRef<HTMLDialogElement>(null);
  const location = me.locations.find((l) => l.id === me.current_location_id);

  // Modal <dialog>: traps focus, closes on Escape and returns focus to the menu button.
  useEffect(() => {
    const dialog = drawer.current;
    if (!dialog) return;
    if (menuOpen && !dialog.open) dialog.showModal();
    if (!menuOpen && dialog.open) dialog.close();
  }, [menuOpen]);

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[240px_1fr]">
      <aside className="sticky top-0 hidden h-dvh border-r border-line bg-surface md:block">
        <Sidebar me={me} />
      </aside>

      <dialog
        id="panel-menu"
        ref={drawer}
        aria-label="Menú"
        onClose={() => setMenuOpen(false)}
        // A click on the backdrop lands on the dialog element itself.
        onClick={(e) => e.target === e.currentTarget && setMenuOpen(false)}
        className="fixed inset-y-0 left-0 m-0 h-dvh max-h-none w-[264px] max-w-none overscroll-contain border-r border-transparent bg-surface p-0 text-ink shadow-panel transition-[translate,opacity,display,overlay] transition-discrete duration-300 ease-[cubic-bezier(0.2,0,0,1)] backdrop:bg-ink/30 motion-safe:not-open:-translate-x-full motion-safe:starting:open:-translate-x-full motion-reduce:not-open:opacity-0 motion-reduce:starting:open:opacity-0 md:hidden"
      >
        {/* First focusable in the dialog, so showModal() focuses it (React's autoFocus sets no attribute). */}
        <button
          type="button"
          onClick={() => setMenuOpen(false)}
          aria-label="Cerrar menú"
          className="absolute top-2 right-2 z-10 flex size-10 items-center justify-center rounded-control text-ink-2 transition-[background-color] duration-150 hover:bg-ground"
        >
          <X size={20} aria-hidden />
        </button>
        <Sidebar me={me} onNavigate={() => setMenuOpen(false)} />
      </dialog>

      <div className="min-w-0">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-surface px-4 md:px-8">
          <button
            type="button"
            onClick={() => setMenuOpen(true)}
            aria-label="Abrir menú"
            aria-expanded={menuOpen}
            aria-controls="panel-menu"
            className="-ml-1 flex size-10 items-center justify-center rounded-control text-ink-2 transition-[background-color,scale] duration-150 ease-out hover:bg-ground motion-safe:active:scale-[0.96] md:hidden"
          >
            <Menu size={20} aria-hidden />
          </button>
          <h1 className="text-[15px] font-semibold">{title}</h1>
          {me.locations.length > 1 ? (
            <label className="ml-auto flex items-center gap-1.5 text-sm text-muted">
              <MapPin size={16} strokeWidth={2.5} aria-hidden />
              <span className="sr-only">Sede</span>
              <select
                value={me.current_location_id ?? ""}
                onChange={(e) => setLocation(e.target.value)}
                className="h-10 rounded-control border border-line-strong bg-surface pr-8 pl-2.5 font-medium text-ink-2 transition-[border-color] duration-150 hover:border-muted"
              >
                {me.locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name} · {l.city}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            location && (
              <p className="ml-auto flex items-center gap-1.5 text-sm text-muted">
                <MapPin size={16} strokeWidth={2.5} aria-hidden />
                <span className="font-medium text-ink-2">{location.name}</span>
                <span className="hidden sm:inline">· {location.city}</span>
              </p>
            )
          )}
        </header>
        <main className={`mx-auto px-4 py-8 md:px-8 md:py-10 ${wide ? "max-w-[1440px]" : "max-w-[1120px]"}`}>
          {children}
        </main>
      </div>
    </div>
  );
}
