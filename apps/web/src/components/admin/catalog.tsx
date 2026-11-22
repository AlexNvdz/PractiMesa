"use client";

import { Check, ChevronDown, ChevronUp, Plus, Search, Tags, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Dialog } from "@/components/dialog";
import { button, field } from "@/components/ui";
import { errorMessage, useApi } from "@/lib/api";
import type { Me } from "@/lib/auth";
import { cop, fold } from "@/lib/format";
import type { Category, LocationProduct, Product } from "@/lib/pos";
import { ProductForm } from "./product-form";

/**
 * Catalog admin (OWNER/ADMIN): products grouped by category, with their price and availability at the
 * current location. Master data is organization-wide; price and availability are per location.
 */
export function Catalog({ me }: { me: Me }) {
  const api = useApi();
  const [products, setProducts] = useState<Product[] | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [local, setLocal] = useState<Record<string, LocationProduct>>({});
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Product | "new" | null>(null);
  const [managing, setManaging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locationName = me.locations.find((l) => l.id === me.current_location_id)?.name ?? "esta sede";
  const multi = me.organization.plan_tier === "MULTI";

  // The page remounts this screen when the location changes, so it loads once per location.
  useEffect(() => {
    void (async () => {
      try {
        const [p, c, l] = await Promise.all([
          api<Product[]>("/products"),
          api<Category[]>("/categories"),
          api<LocationProduct[]>("/location-products"),
        ]);
        setProducts(p);
        setCategories(c);
        setLocal(Object.fromEntries(l.map((x) => [x.product_id, x])));
      } catch (err) {
        setError(errorMessage(err));
      }
    })();
  }, [api]);

  if (!products) {
    return error ? (
      <p role="alert" className="rounded-panel border border-line bg-surface px-5 py-10 text-center text-[15px] text-danger">
        {error}
      </p>
    ) : (
      <p role="status" className="py-10 text-center text-[15px] text-muted">
        Cargando catálogo…
      </p>
    );
  }

  // Chain products plus this location's own ones; other locations' own products are theirs to manage (Q43).
  const visible = products.filter((p) => !p.location_id || p.location_id === me.current_location_id);
  const shown = query ? visible.filter((p) => fold(p.name).includes(fold(query))) : visible;
  const groups = [
    ...categories.map((c) => ({ id: c.id, name: c.name, items: shown.filter((p) => p.category_id === c.id) })),
    { id: "none", name: "Sin categoría", items: shown.filter((p) => !p.category_id || !categories.some((c) => c.id === p.category_id)) },
  ].filter((g) => g.items.length);
  const product = editing === "new" ? undefined : (editing ?? undefined);

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <label className="relative min-w-56 flex-1 sm:max-w-sm">
          <span className="sr-only">Buscar producto</span>
          <Search size={18} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" aria-hidden />
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar producto" className={`${field} pl-10`} />
        </label>
        <button type="button" onClick={() => setManaging(true)} className={`${button.secondary} ml-auto pl-3.5`}>
          <Tags size={18} strokeWidth={2.25} aria-hidden />
          Categorías
        </button>
        <button type="button" onClick={() => setEditing("new")} className={`${button.primary} pl-3.5`}>
          <Plus size={18} strokeWidth={2.25} aria-hidden />
          Nuevo producto
        </button>
      </div>

      {!visible.length && (
        <p className="rounded-panel border border-line bg-surface px-5 py-10 text-center text-[15px] text-muted">
          Todavía no hay productos. Crea el primero con &ldquo;Nuevo producto&rdquo;.
        </p>
      )}
      {visible.length > 0 && !groups.length && <p className="py-10 text-center text-[15px] text-muted">Ningún producto coincide con &ldquo;{query}&rdquo;.</p>}

      {groups.map((g) => (
        <section key={g.id} aria-labelledby={`cat-${g.id}`} className="mb-8">
          <h2 id={`cat-${g.id}`} className="mb-3 flex items-baseline gap-2 text-sm font-semibold text-ink-2">
            {g.name}
            <span className="figures font-normal text-muted">{g.items.length}</span>
          </h2>
          <ul className="divide-y divide-line rounded-panel border border-line bg-surface">
            {g.items.map((p) => {
              const override = local[p.id];
              const price = override?.custom_price_cop ?? p.base_price_cop;
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => setEditing(p)}
                    className="flex min-h-14 w-full items-center gap-4 px-5 py-3 text-left transition-[background-color] duration-150 first:rounded-t-panel last:rounded-b-panel hover:bg-ground"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] font-medium">{p.name}</span>
                      {p.modifiers_schema.length > 0 && (
                        <span className="block truncate text-sm text-muted">{p.modifiers_schema.map((m) => m.name).join(" · ")}</span>
                      )}
                    </span>
                    {multi && p.location_id && <span className="rounded-full bg-ground px-2 py-0.5 text-xs font-medium text-muted">Solo esta sede</span>}
                    {!p.is_active ? (
                      <span className="rounded-full bg-ground px-2 py-0.5 text-xs font-medium text-muted">Inactivo</span>
                    ) : override?.is_listed === false ? (
                      <span className="rounded-full bg-ground px-2 py-0.5 text-xs font-medium text-muted">No se vende aquí</span>
                    ) : (
                      override?.is_available === false && (
                        <span className="rounded-full bg-warning-soft px-2 py-0.5 text-xs font-medium text-warning">No disponible aquí</span>
                      )
                    )}
                    <span className="text-right">
                      <span className="figures block text-[15px] font-medium">{cop(price)}</span>
                      {override?.custom_price_cop != null && <span className="figures block text-xs text-muted">Base {cop(p.base_price_cop)}</span>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={product ? product.name : "Nuevo producto"} wide>
        <ProductForm
          key={product?.id ?? "new"}
          product={product}
          categories={categories}
          local={product ? local[product.id] : undefined}
          locationName={locationName}
          multi={multi}
          onSaved={(saved, here) => {
            setProducts((all) => [...(all ?? []).filter((p) => p.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name, "es")));
            setLocal((all) => ({ ...all, [saved.id]: here }));
            setEditing(null);
          }}
          onDeleted={(id) => {
            setProducts((all) => all?.filter((p) => p.id !== id) ?? null);
            setEditing(null);
          }}
        />
      </Dialog>

      <Dialog open={managing} onClose={() => setManaging(false)} title="Categorías">
        <Categories categories={categories} onChange={setCategories} />
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
