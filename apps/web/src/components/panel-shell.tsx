"use client";

import {
  BookOpen,
  LoaderCircle,
  ChartColumn,
  ChefHat,
  ChevronsLeft,
  ChevronsRight,
  Ellipsis,
  History,
  House,
  LayoutGrid,
  LogOut,
  MapPin,
  MonitorSmartphone,
  Package,
  ReceiptText,
  UserRound,
  Users,
  Wallet,
  X,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Logo, LogoMark } from "@/components/logo";
import { useApi } from "@/lib/api";
import { ROLE_LABEL, useAuth, type Me, type Role } from "@/lib/auth";
import { useLive } from "@/lib/live";
import { type Order, readyCount } from "@/lib/pos";

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
  { label: "Cocina", icon: ChefHat, href: "/cocina", roles: ["OWNER", "ADMIN", "CASHIER", "WAITER", "KITCHEN"] },
  { label: "Catálogo", icon: BookOpen, href: "/catalogo", roles: ["OWNER", "ADMIN"] },
  { label: "Inventario", icon: Package, href: "/inventario", roles: ["OWNER", "ADMIN", "CASHIER"] },
  { label: "Registro", icon: History, href: "/registro", roles: ["OWNER", "ADMIN"] },
  { label: "Equipo", icon: Users, href: "/equipo", roles: ["OWNER"] },
  { label: "Dispositivos", icon: MonitorSmartphone, href: "/dispositivos", roles: ["OWNER"] },
  { label: "Sedes", icon: MapPin, href: "/sedes", roles: ["OWNER"] },
  { label: "Reportes", icon: ChartColumn },
];

/** Phone tab bar: the service screens each role uses most; everything else lives under "Más". */
const TABS = ["/mesas", "/cocina", "/caja"];

/** Desktop rail: compact (icons) or open (labels); the choice is kept on this browser. */
const RAIL_KEY = "pm_rail";

const initials = (name: string) =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

const visible = (role: Role) => NAV.filter((item) => !item.roles || item.roles.includes(role));
const isActive = (pathname: string, href: string) =>
  href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);

// Rail rows. Inside the compact rail (group/rail closed) the label fades out and comes back as a tooltip to the right.
const row =
  "relative flex h-11 w-full items-center gap-3.5 rounded-xl px-3 text-[15px] whitespace-nowrap transition-[background-color,color] duration-150";
const navRow = "group-data-[rail=closed]/rail:w-52";
const idle = "text-ink-2 hover:bg-rail-hover hover:text-ink";
const current = "bg-accent font-[650] text-white";
const label = "transition-opacity duration-150 group-data-[rail=closed]/rail:pointer-events-none group-data-[rail=closed]/rail:opacity-0";
const tip =
  "group-data-[rail=closed]/rail:after:pointer-events-none group-data-[rail=closed]/rail:after:fixed group-data-[rail=closed]/rail:after:left-[82px] group-data-[rail=closed]/rail:after:z-50 group-data-[rail=closed]/rail:after:rounded-lg group-data-[rail=closed]/rail:after:bg-ink group-data-[rail=closed]/rail:after:px-2.5 group-data-[rail=closed]/rail:after:py-1.5 group-data-[rail=closed]/rail:after:text-[13px] group-data-[rail=closed]/rail:after:font-semibold group-data-[rail=closed]/rail:after:text-white group-data-[rail=closed]/rail:after:opacity-0 group-data-[rail=closed]/rail:after:transition-opacity group-data-[rail=closed]/rail:after:content-[attr(data-tip)] group-data-[rail=closed]/rail:hover:after:opacity-100 group-data-[rail=closed]/rail:focus-visible:after:opacity-100";

/** Yellow count of tables with food ready: on the icon in the compact rail, at the end of the row otherwise. */
function Badge({ n, onDark = false }: { n?: number; onDark?: boolean }) {
  if (!n) return null;
  return (
    <span
      aria-label={`${n} para servir`}
      className={`figures ml-auto grid h-[18px] min-w-[18px] place-items-center rounded-full bg-ready px-1.5 text-[11px] font-extrabold text-ready-ink motion-safe:animate-[pop_.4s_var(--ease-out)] group-data-[rail=closed]/rail:absolute group-data-[rail=closed]/rail:top-[7px] group-data-[rail=closed]/rail:left-[30px] group-data-[rail=closed]/rail:ring-2 ${
        onDark ? "ring-accent" : "ring-rail"
      }`}
    >
      {n}
    </span>
  );
}

function Sidebar({
  me,
  badges,
  onNavigate,
  onToggle,
}: {
  me: Me;
  badges?: Record<string, number>;
  onNavigate?: () => void;
  /** Only the desktop rail can be compacted. */
  onToggle?: { open: boolean; toggle: () => void };
}) {
  const pathname = usePathname();
  const { logout } = useAuth();
  const plan = me.organization.plan_tier === "SINGLE" ? "Plan Pequeño" : "Plan Multilocal";
  const account = pathname === "/mi-cuenta";

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-[68px] shrink-0 items-center px-[18px]">
        <Logo size={40} ink className="text-[21px]" nameClassName={label} />
      </div>
      <div className={`px-[18px] pt-0.5 pb-3.5 whitespace-nowrap ${label}`}>
        <p className="truncate text-sm leading-[1.45] font-semibold text-ink">{me.organization.name}</p>
        <p className="text-[12.5px] leading-[21.75px] text-rail-muted">{plan}</p>
      </div>

      {/* Scrollbar hidden until the pointer is over the list; the fade at both ends hints that it scrolls. */}
      <nav
        aria-label="Principal"
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain rail-scroll py-1 pr-3.5 pl-3.5 group-data-[rail=closed]/rail:pr-0 not-group-data-[rail=closed]/rail:mask-[linear-gradient(to_bottom,transparent,#000_10px,#000_calc(100%-28px),transparent)]"
      >
        <ul className="grid grid-cols-[minmax(0,1fr)] gap-0.5">
          {visible(me.user.role).map(({ label: text, icon: Icon, href }) => {
            if (!href) {
              return (
                <li key={text}>
                  <span aria-disabled="true" data-tip={`${text} · Pronto`} className={`${row} ${navRow} ${tip} text-rail-muted`}>
                    <Icon size={20} aria-hidden className="shrink-0" />
                    <span className={label}>{text}</span>
                    <span className={`ml-auto rounded-full bg-rail-hover px-2 py-px text-[11.5px] font-semibold ${label}`}>Pronto</span>
                  </span>
                </li>
              );
            }
            const active = isActive(pathname, href);
            return (
              <li key={text}>
                <Link
                  href={href}
                  onClick={onNavigate}
                  aria-current={active ? "page" : undefined}
                  data-tip={text}
                  className={`${row} ${navRow} ${tip} ${active ? current : idle}`}
                >
                  <Icon size={20} aria-hidden className="shrink-0" />
                  <span className={label}>{text}</span>
                  <Badge n={badges?.[href]} onDark={active} />
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-0.5 border-t border-line px-3.5 pt-2.5 pb-3.5">
        <div className="flex items-center gap-3 px-1.5 pt-1.5 pb-2">
          <span
            aria-hidden
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-ready text-[13px] font-extrabold text-ready-ink"
          >
            {initials(me.user.full_name)}
          </span>
          <div className={`min-w-0 whitespace-nowrap ${label}`}>
            <p className="truncate text-sm leading-[1.45] font-semibold text-ink">{me.user.full_name}</p>
            <p className="truncate text-[12.5px] leading-[21.75px] text-rail-muted">{ROLE_LABEL[me.user.role]}</p>
          </div>
        </div>
        <Link
          href="/mi-cuenta"
          onClick={onNavigate}
          aria-current={account ? "page" : undefined}
          data-tip="Mi cuenta"
          className={`${row} ${tip} ${account ? current : idle}`}
        >
          <UserRound size={20} aria-hidden className="shrink-0" />
          <span className={label}>Mi cuenta</span>
        </Link>
        <button type="button" onClick={() => void logout()} data-tip="Cerrar sesión" className={`${row} ${tip} ${idle}`}>
          <LogOut size={20} aria-hidden className="shrink-0" />
          <span className={label}>Cerrar sesión</span>
        </button>
        {onToggle && (
          <button
            type="button"
            onClick={onToggle.toggle}
            aria-expanded={onToggle.open}
            aria-keyshortcuts="]"
            data-tip="Expandir menú  ]"
            className={`${row} ${tip} ${idle}`}
          >
            {onToggle.open ? <ChevronsLeft size={20} aria-hidden className="shrink-0" /> : <ChevronsRight size={20} aria-hidden className="shrink-0" />}
            <span className={label}>Contraer menú</span>
          </button>
        )}
      </div>
    </div>
  );
}

/** Roles that see "Mesas" in the menu, and so its count of food ready to serve. */
const SERVICE_ROLES: Role[] = ["OWNER", "ADMIN", "CASHIER", "WAITER"];

/**
 * Yellow count on "Mesas" for every screen: how many tables and counter orders have food ready.
 * Off on Mesas itself, which already knows it and passes it in `badges`.
 */
function useReadyBadge(role: Role, enabled: boolean) {
  const api = useApi();
  const [count, setCount] = useState(0);
  const on = enabled && SERVICE_ROLES.includes(role);
  const load = useCallback(() => api<Order[]>("/orders").then((orders) => setCount(readyCount(orders)), () => undefined), [api]);
  // Any change to an order may flip a round to ready or delivered: reload the short list of orders in service.
  useLive(
    () => void load(),
    (event) => event.type === "order" && void load(),
    on,
  );
  return count;
}

export function PanelLoading() {
  return (
    <div className="flex min-h-dvh items-center justify-center text-muted" role="status">
      <LoaderCircle size={22} className="animate-spin motion-reduce:[animation-duration:6s]" aria-hidden />
      <span className="sr-only">Cargando tu panel…</span>
    </div>
  );
}

export function PanelShell({
  me,
  title,
  wide = false,
  badges,
  children,
}: {
  me: Me;
  title: string;
  /** Operation screens (table map) use the whole width. */
  wide?: boolean;
  /** Counts shown on menu entries, by route (e.g. food ready on "/mesas"). */
  badges?: Record<string, number>;
  children: React.ReactNode;
}) {
  const { setLocation } = useAuth();
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  // The shell only renders in the browser (after login), so localStorage is there.
  const [railOpen, setRailOpen] = useState(() => localStorage.getItem(RAIL_KEY) === "open");
  const drawer = useRef<HTMLDialogElement>(null);
  const location = me.locations.find((l) => l.id === me.current_location_id);
  const tabs = visible(me.user.role).filter((item) => item.href && TABS.includes(item.href));
  const rail = railOpen ? "open" : "closed";
  const readyHere = useReadyBadge(me.user.role, pathname !== "/mesas");
  const counts: Record<string, number> = { "/mesas": readyHere, ...badges };

  const toggleRail = () => setRailOpen((open) => !open);

  useEffect(() => localStorage.setItem(RAIL_KEY, rail), [rail]);

  // "]" opens and closes the rail, except while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key !== "]" || e.ctrlKey || e.metaKey || e.altKey || t.closest("input, textarea, select, [contenteditable=true], dialog")) return;
      setRailOpen((open) => !open);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Modal <dialog>: traps focus, closes on Escape and returns focus to the menu button.
  useEffect(() => {
    const dialog = drawer.current;
    if (!dialog) return;
    if (menuOpen && !dialog.open) dialog.showModal();
    if (!menuOpen && dialog.open) dialog.close();
  }, [menuOpen]);

  return (
    <div
      data-rail={rail}
      className="min-h-dvh sm:grid sm:grid-cols-[76px_1fr] sm:transition-[grid-template-columns] sm:duration-[280ms] sm:ease-(--ease-out) sm:data-[rail=open]:grid-cols-[256px_1fr]"
    >
      <aside data-rail={rail} aria-label="Menú" className="group/rail sticky top-0 hidden h-dvh overflow-hidden border-r border-line bg-rail sm:block">
        <Sidebar me={me} badges={counts} onToggle={{ open: railOpen, toggle: toggleRail }} />
      </aside>

      <dialog
        id="panel-menu"
        ref={drawer}
        aria-label="Menú"
        onClose={() => setMenuOpen(false)}
        // A click on the backdrop lands on the dialog element itself.
        onClick={(e) => e.target === e.currentTarget && setMenuOpen(false)}
        className="fixed inset-y-0 left-0 m-0 h-dvh max-h-none w-[284px] max-w-none overscroll-contain rounded-r-sheet border-r border-transparent bg-rail p-0 text-ink shadow-panel transition-[translate,opacity,display,overlay] transition-discrete duration-300 ease-(--ease-out) backdrop:bg-ink/30 motion-safe:not-open:-translate-x-full motion-safe:starting:open:-translate-x-full motion-reduce:not-open:opacity-0 motion-reduce:starting:open:opacity-0 sm:hidden"
      >
        {/* First focusable in the dialog, so showModal() focuses it (React's autoFocus sets no attribute). */}
        <button
          type="button"
          onClick={() => setMenuOpen(false)}
          aria-label="Cerrar menú"
          className="absolute top-3.5 right-3 z-10 flex size-10 items-center justify-center rounded-control text-ink-2 transition-[background-color] duration-150 hover:bg-rail-hover"
        >
          <X size={20} aria-hidden />
        </button>
        <Sidebar me={me} badges={counts} onNavigate={() => setMenuOpen(false)} />
      </dialog>

      <div className="min-w-0">
        <header className="sticky top-0 z-30 flex h-[60px] items-center gap-2.5 border-b border-line bg-ground/85 px-4 backdrop-blur-md sm:h-[68px] sm:gap-3.5 sm:px-7">
          <LogoMark size={32} className="sm:hidden" />
          <h1 className="font-display text-[21px] font-bold tracking-[-0.02em] sm:text-[22px]">{title}</h1>
          {me.locations.length > 1 ? (
            <label className="ml-auto flex min-w-0 items-center gap-1.5 text-sm text-muted">
              <MapPin size={18} aria-hidden className="hidden shrink-0 sm:block" />
              <span className="sr-only">Sede</span>
              <select
                value={me.current_location_id ?? ""}
                onChange={(e) => setLocation(e.target.value)}
                className="h-10 max-w-[148px] truncate rounded-control border border-line-strong bg-surface pr-8 pl-2.5 font-semibold text-ink-2 transition-[border-color] duration-150 hover:border-muted sm:max-w-none"
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
              <p className="ml-auto flex min-w-0 items-center gap-1.5 text-sm text-muted">
                <MapPin size={16} strokeWidth={2.5} aria-hidden className="shrink-0" />
                <span className="truncate font-semibold text-ink-2">{location.name}</span>
                <span className="hidden sm:inline">· {location.city}</span>
              </p>
            )
          )}
        </header>
        <main
          className={`mx-auto px-3.5 pt-4 pb-[calc(96px+env(safe-area-inset-bottom))] sm:px-7 sm:pt-6 sm:pb-12 ${wide ? "max-w-[1440px]" : "max-w-[1120px]"}`}
        >
          {children}
        </main>
      </div>

      {/* Phone: the main screens one tap away; "Más" opens the full menu. */}
      <nav
        aria-label="Accesos rápidos"
        className="fixed inset-x-0 bottom-0 z-30 grid auto-cols-fr grid-flow-col border-t border-line bg-surface/95 px-2 pt-1.5 pb-[calc(6px+env(safe-area-inset-bottom))] backdrop-blur-md sm:hidden"
      >
        {tabs.map(({ label: text, icon: Icon, href }) => {
          const active = isActive(pathname, href!);
          return (
            <Link
              key={text}
              href={href!}
              aria-current={active ? "page" : undefined}
              className={`flex flex-col items-center gap-0.5 pt-1 pb-0.5 text-xs font-semibold ${active ? "text-ink" : "text-muted"}`}
            >
              <span className={`relative grid h-[30px] w-14 place-items-center rounded-full transition-[background-color] duration-150 ${active ? "bg-accent-soft text-accent" : ""}`}>
                <Icon size={20} aria-hidden />
                {!!counts[href!] && (
                  <span className="figures absolute -top-1 left-[calc(50%+6px)] grid h-[18px] min-w-[18px] place-items-center rounded-full bg-ready px-1.5 text-[11px] font-extrabold text-ready-ink ring-2 ring-surface">
                    {counts[href!]}
                  </span>
                )}
              </span>
              {text}
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => setMenuOpen(true)}
          aria-expanded={menuOpen}
          aria-controls="panel-menu"
          className="flex flex-col items-center gap-0.5 pt-1 pb-0.5 text-xs font-semibold text-muted"
        >
          <span className="grid h-[30px] w-14 place-items-center rounded-full">
            <Ellipsis size={20} aria-hidden />
          </span>
          Más
        </button>
      </nav>
    </div>
  );
}
