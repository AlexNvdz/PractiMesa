"use client";

import { Check, ChevronDown, ChevronUp, Plus, Search, Tags, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { CardSkeleton } from "@/components/skeleton";
import { Dialog } from "@/components/dialog";
import { Sentinel } from "@/components/sentinel";
import { type Undo, UndoToast } from "@/components/undo-toast";
import { button, field } from "@/components/ui";
import { errorMessage, useApi } from "@/lib/api";
import type { Me } from "@/lib/auth";
import { cop } from "@/lib/format";
import { useDebounced, usePagedList } from "@/lib/paged";
import type { Category, LocationProduct, Product } from "@/lib/pos";
import { ProductForm, TAXES } from "./product-form";

/**
 * Catalog: products grouped by category, with their price and availability at the current location. Master
 * data is organization-wide; price and availability are per location. Only the owner edits it (Q53): a
 * supervisor reads it and marks products sold out today at its location.
 */
/** A product as the paged catalog sends it: with this location's price and availability (`local`), if any. */
type CatalogItem = Product & { local: LocationProduct | null };

export function Catalog({ me }: { me: Me }) {
  const api = useApi();
  const [categories, setCategories] = useState<Category[]>([]);
  // Availability switched on this screen, over what the page said.
  const [changed, setChanged] = useState<Record<string, LocationProduct>>({});
  const [query, setQuery] = useState("");
  const search = useDebounced(query.trim());
  // "" = the whole menu.
  const [cat, setCat] = useState("");
  const [editing, setEditing] = useState<CatalogItem | "new" | null>(null);
  const [managing, setManaging] = useState(false);
  const [categoriesError, setCategoriesError] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const list = usePagedList<CatalogItem, Record<string, number>>("/products/page", {
    limit: "24",
    ...(search ? { q: search } : {}),
    ...(cat ? { category: cat } : {}),
  });
  const owner = me.user.role === "OWNER";
  const locationName = me.locations.find((l) => l.id === me.current_location_id)?.name ?? "esta sede";
  const multi = me.organization.plan_tier === "MULTI";

  // The page remounts this screen when the location changes, so the categories load once per location.
  useEffect(() => {
    api<Category[]>("/categories").then(setCategories, (err) => setCategoriesError(errorMessage(err)));
  }, [api]);

  const error = list.error ?? categoriesError;
  if (!list.items || !list.counts) {
    return error ? (
      <p role="alert" className="pm-card px-5 py-10 text-center text-[15px] text-danger">
        {error}
      </p>
    ) : (
      <CardSkeleton label="Cargando catálogo…" />
    );
  }

  const { items, counts } = list;
  const everything = counts.all ?? 0;
  const chips = [
    { id: "", name: "Todo el menú", count: everything },
    ...categories.map((c) => ({ id: c.id, name: c.name, count: counts[c.id] ?? 0 })),
    ...(counts.none ? [{ id: "none", name: "Sin categoría", count: counts.none }] : []),
  ];
  // Pages come in category order, so each group is a run of neighbours; its number is the whole category's.
  const name = (id: string) => (id === "none" ? "Sin categoría" : (categories.find((c) => c.id === id)?.name ?? "Sin categoría"));
  const groups: { id: string; name: string; items: CatalogItem[] }[] = [];
  for (const item of items) {
    const id = item.category_id && categories.some((c) => c.id === item.category_id) ? item.category_id : "none";
    const last = groups.at(-1);
    if (last?.id === id) last.items.push(item);
    else groups.push({ id, name: name(id), items: [item] });
  }
  const product = editing === "new" ? undefined : (editing ?? undefined);
  const overrideOf = (p: CatalogItem) => changed[p.id] ?? p.local ?? undefined;

  const setAvailable = async (p: CatalogItem, available: boolean) => {
    setToggling(p.id);
    setRowError(null);
    try {
      const saved = await api<LocationProduct>(`/location-products/${p.id}`, "PUT", { is_available: available });
      setChanged((all) => ({ ...all, [p.id]: saved }));
      return true;
    } catch (err) {
      setRowError({ id: p.id, message: errorMessage(err) });
      return false;
    } finally {
      setToggling(null);
    }
  };

  // "Disponible hoy" switch: applies at once and can be undone for a few seconds.
  const toggleSoldOut = async (p: CatalogItem) => {
    const available = overrideOf(p)?.is_available !== false;
    if (await setAvailable(p, !available)) {
      setUndo({
        message: `${p.name} · ${available ? "agotado hoy" : "disponible hoy"}`,
        run: async () => {
          await setAvailable(p, available);
        },
      });
    }
  };

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <label className="relative min-w-56 flex-1 sm:max-w-sm">
          <span className="sr-only">Buscar producto</span>
          <Search size={18} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" aria-hidden />
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar producto" className={`${field} pl-10`} />
        </label>
        {owner ? (
          <>
            <button type="button" onClick={() => setManaging(true)} className={`${button.secondary} ml-auto pl-3.5`}>
              <Tags size={18} strokeWidth={2.25} aria-hidden />
              Categorías
            </button>
            <button type="button" onClick={() => setEditing("new")} className={`${button.primary} pl-3.5`}>
              <Plus size={18} strokeWidth={2.25} aria-hidden />
              Nuevo producto
            </button>
          </>
        ) : (
          <p className="ml-auto max-w-sm text-sm text-muted text-pretty">
            Solo el dueño cambia productos y precios. Tú marcas lo que se agotó hoy en {locationName}.
          </p>
        )}
      </div>

      {!everything && !search && (
        <p className="pm-card px-5 py-10 text-center text-[15px] text-muted">
          {owner ? <>Todavía no hay productos. Crea el primero con &ldquo;Nuevo producto&rdquo;.</> : "Todavía no hay productos."}
        </p>
      )}

      {(everything > 0 || search) && (
        <div className="grid items-start gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
          {/* Categories: a sticky list beside the products; a sideways strip on smaller screens. */}
          <ul
            aria-label="Categorías"
            className="flex gap-1 overflow-x-auto pm-card p-1.5 [scrollbar-width:none] lg:sticky lg:top-[92px] lg:grid lg:overflow-visible"
          >
            {chips.map((c) => (
              <li key={c.id} className="shrink-0">
                <button
                  type="button"
                  aria-pressed={cat === c.id}
                  onClick={() => setCat(c.id)}
                  className="flex h-10 w-full items-center gap-3 rounded-[10px] px-3 text-left text-sm font-semibold whitespace-nowrap text-ink-2 transition-[background-color,color] duration-150 hover:not-aria-pressed:bg-ground aria-pressed:bg-accent aria-pressed:text-white"
                >
                  {c.name}
                  <span className="figures ml-auto text-[12.5px] font-medium opacity-70">{c.count}</span>
                </button>
              </li>
            ))}
          </ul>

          <div aria-busy={list.stale} className={list.stale ? "opacity-60 transition-opacity" : "transition-opacity"}>
            {!groups.length && (
              <p className="rounded-panel border border-dashed border-line-strong px-5 py-10 text-center text-[15px] text-muted">
                {search ? <>Ningún producto coincide con &ldquo;{search}&rdquo;.</> : "Sin productos en esta categoría."}
              </p>
            )}
            {groups.map((g) => (
              <section key={g.id} aria-labelledby={`cat-${g.id}`} className="mb-8 last:mb-0">
                <h2 id={`cat-${g.id}`} className="mb-3 flex items-baseline gap-2 font-display text-[17px] font-semibold tracking-[-0.01em]">
                  {g.name}
                  <span className="figures font-sans text-[13.5px] font-medium text-muted">{counts[g.id] ?? g.items.length}</span>
                </h2>
                <ul className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3">
                  {g.items.map((p) => {
                    const override = overrideOf(p);
                    const price = override?.custom_price_cop ?? p.base_price_cop;
                    const sellable = p.is_active && override?.is_listed !== false;
                    const soldOut = override?.is_available === false;
                    const tax = TAXES.find((t) => t.rate === String(Number(p.tax_rate)))?.label ?? `Impuesto ${Number(p.tax_rate)}%`;
                    const options = p.modifiers_schema.length;
                    const body = (
                      <>
                        <h3 className={`text-base leading-snug font-semibold text-balance ${sellable && !soldOut ? "" : "text-muted"}`}>{p.name}</h3>
                        <p className={`figures font-display text-2xl font-[750] tracking-[-0.02em] ${sellable && !soldOut ? "" : "text-muted"}`}>
                          {cop(price)}
                          {override?.custom_price_cop != null && (
                            <span className="ml-2 font-sans text-xs font-medium tracking-normal text-muted">Base {cop(p.base_price_cop)}</span>
                          )}
                        </p>
                        <p className="-mt-1.5 text-[13px] text-muted">
                          {tax}
                          {Number(p.tax_rate) > 0 && " incluido"}
                          {options > 0 && ` · ${options} ${options === 1 ? "opción" : "opciones"}`}
                        </p>
                        {(!p.is_active || (multi && p.location_id) || override?.is_listed === false || soldOut) && (
                          <span className="flex flex-wrap gap-1.5">
                            {multi && p.location_id && <span className="rounded-full bg-accent-soft px-2 py-0.5 text-xs font-semibold text-accent">Solo esta sede</span>}
                            {!p.is_active ? (
                              <span className="rounded-full bg-ground px-2 py-0.5 text-xs font-semibold text-muted">Inactivo</span>
                            ) : override?.is_listed === false ? (
                              <span className="rounded-full bg-ground px-2 py-0.5 text-xs font-semibold text-muted">No se vende aquí</span>
                            ) : (
                              soldOut && <span className="rounded-full bg-warning-soft px-2 py-0.5 text-xs font-semibold text-warning">Agotado hoy</span>
                            )}
                          </span>
                        )}
                      </>
                    );
                    const card = "pm-card flex h-full w-full flex-col";
                    return (
                      // Cards far off screen skip layout and paint until scrolled near: long menus stay fast.
                      <li key={p.id} className="[contain-intrinsic-size:auto_170px] [content-visibility:auto]">
                        <div className={`${card}`}>
                          {owner ? (
                            <button
                              type="button"
                              onClick={() => setEditing(p)}
                              className="flex w-full flex-1 flex-col gap-2.5 rounded-t-2xl p-4 text-left transition-[background-color] duration-150 hover:bg-[#f7f8f5]"
                            >
                              {body}
                            </button>
                          ) : (
                            <div className="flex w-full flex-1 flex-col gap-2.5 p-4">{body}</div>
                          )}
                          {sellable && (
                            <div className="mx-4 mb-3 flex items-center justify-between gap-2 border-t border-dashed border-line-strong pt-2.5">
                              <button
                                type="button"
                                role="switch"
                                aria-checked={!soldOut}
                                disabled={toggling === p.id}
                                onClick={() => void toggleSoldOut(p)}
                                className="group inline-flex items-center gap-2 py-1 text-[13.5px] font-semibold text-ink-2 disabled:opacity-60"
                              >
                                <i className="relative h-6 w-10 shrink-0 rounded-xl bg-line-strong transition-[background-color] duration-200 group-aria-checked:bg-success after:absolute after:top-[3px] after:left-[3px] after:size-[18px] after:rounded-full after:bg-white after:shadow-[0_1px_2px_rgb(23_30_46/0.25)] after:transition-[translate] after:duration-200 after:ease-[cubic-bezier(0.2,0,0,1)] group-aria-checked:after:translate-x-4" />
                                Disponible hoy
                              </button>
                            </div>
                          )}
                          {rowError?.id === p.id && (
                            <p role="alert" className="px-4 pb-3 text-sm text-danger">
                              {rowError.message}
                            </p>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
            {list.total > 0 && (
              <Sentinel onNear={list.loadMore} busy={list.loadingMore}>
                {list.loadMore || list.loadingMore ? `Mostrando ${items.length} de ${list.total}` : `${list.total} en total`}
              </Sentinel>
            )}
          </div>
        </div>
      )}

      <UndoToast undo={undo} onClose={() => setUndo(null)} />

      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={product ? product.name : "Nuevo producto"} wide>
        <ProductForm
          key={product?.id ?? "new"}
          product={product}
          categories={categories}
          local={product ? overrideOf(product) : undefined}
          locationName={locationName}
          multi={multi}
          onSaved={(saved, here) => {
            setChanged((all) => ({ ...all, [saved.id]: here }));
            setEditing(null);
            list.reload();
          }}
          onDeleted={() => {
            setEditing(null);
            list.reload();
          }}
        />
      </Dialog>

      <Dialog open={managing} onClose={() => setManaging(false)} title="Categorías">
        <Categories
          categories={categories}
          onChange={(next) => {
            setCategories(next);
            list.reload();
          }}
        />
      </Dialog>
    </div>
  );
}

/** Add, rename, reorder and delete categories. Deleting one leaves its products without category. */
function Categories({ categories, onChange }: { categories: Category[]; onChange: (categories: Category[]) => void }) {
  const api = useApi();
  const [names, setNames] = useState<Record<string, string>>(() => Object.fromEntries(categories.map((c) => [c.id, c.name])));
  const [fresh, setFresh] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moved, setMoved] = useState("");

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const add = (event: React.FormEvent) => {
    event.preventDefault();
    if (!fresh.trim()) return;
    void run(async () => {
      const order = Math.max(-1, ...categories.map((c) => c.sort_order)) + 1;
      const saved = await api<Category>("/categories", "POST", { name: fresh.trim(), sort_order: order });
      onChange([...categories, saved]);
      setNames((all) => ({ ...all, [saved.id]: saved.name }));
      setFresh("");
    });
  };

  // Moves one step and saves the new positions (0..n-1) of the categories whose position changed.
  // The list updates at once; if a save fails, it reloads the order the server kept.
  const move = (index: number, step: -1 | 1) => {
    const to = index + step;
    if (busy || to < 0 || to >= categories.length) return;
    const next = [...categories];
    [next[index], next[to]] = [next[to], next[index]];
    onChange(next.map((c, i) => ({ ...c, sort_order: i })));
    setMoved(`${next[to].name}: posición ${to + 1} de ${next.length}`);
    void run(async () => {
      try {
        await Promise.all(next.map((c, i) => (c.sort_order === i ? null : api(`/categories/${c.id}`, "PATCH", { sort_order: i }))));
      } catch (err) {
        onChange(await api<Category[]>("/categories"));
        throw err;
      }
    });
  };
  const arrow =
    "flex size-11 shrink-0 items-center justify-center rounded-control text-ink-2 transition-[background-color,color] duration-150 hover:not-aria-disabled:bg-ground hover:not-aria-disabled:text-ink aria-disabled:cursor-not-allowed aria-disabled:opacity-40";

  return (
    <div>
      <p className="text-sm text-muted">El orden de aquí es el del menú en el POS y la tienda. Al eliminar una categoría, sus productos quedan sin categoría.</p>
      <p aria-live="polite" className="sr-only">
        {moved}
      </p>
      <ul className="mt-4 space-y-2">
        {categories.map((c, i) => {
          const changed = names[c.id]?.trim() && names[c.id].trim() !== c.name;
          return (
            <li key={c.id} className="flex items-center gap-1">
              {/* aria-disabled, not disabled: the focused arrow keeps focus when it reaches the end. */}
              <button type="button" onClick={() => move(i, -1)} aria-disabled={i === 0 || busy} aria-label={`Subir ${c.name}`} className={arrow}>
                <ChevronUp size={18} aria-hidden />
              </button>
              <button type="button" onClick={() => move(i, 1)} aria-disabled={i === categories.length - 1 || busy} aria-label={`Bajar ${c.name}`} className={arrow}>
                <ChevronDown size={18} aria-hidden />
              </button>
              <input
                value={names[c.id] ?? ""}
                onChange={(e) => setNames((all) => ({ ...all, [c.id]: e.target.value }))}
                maxLength={100}
                aria-label={`Nombre de la categoría ${c.name}`}
                className={`${field} ml-1 flex-1`}
              />
              {changed ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const saved = await api<Category>(`/categories/${c.id}`, "PATCH", { name: names[c.id].trim() });
                      onChange(categories.map((x) => (x.id === c.id ? saved : x)));
                    })
                  }
                  aria-label={`Guardar ${names[c.id]}`}
                  className="flex size-11 shrink-0 items-center justify-center rounded-control text-accent-strong transition-[background-color] duration-150 hover:enabled:bg-accent-soft"
                >
                  <Check size={18} strokeWidth={2.25} aria-hidden />
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api(`/categories/${c.id}`, "DELETE");
                      onChange(categories.filter((x) => x.id !== c.id));
                    })
                  }
                  aria-label={`Eliminar la categoría ${c.name}`}
                  className="flex size-11 shrink-0 items-center justify-center rounded-control text-muted transition-[background-color,color] duration-150 hover:enabled:bg-danger-soft hover:enabled:text-danger"
                >
                  <Trash2 size={18} aria-hidden />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <form onSubmit={add} className="mt-4 flex gap-2">
        <input value={fresh} onChange={(e) => setFresh(e.target.value)} maxLength={100} placeholder="Nueva categoría" aria-label="Nueva categoría" className={`${field} flex-1`} />
        <button type="submit" disabled={busy || !fresh.trim()} className={button.secondary}>
          Agregar
        </button>
      </form>
      {error && (
        <p role="alert" className="mt-3 rounded-control bg-danger-soft px-3 py-2.5 text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
