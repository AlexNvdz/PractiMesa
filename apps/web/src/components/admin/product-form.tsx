"use client";

import { LoaderCircle, Plus, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { button, field } from "@/components/ui";
import { errorMessage, useApi } from "@/lib/api";
import { ApiError } from "@/lib/auth";
import { cop, pesos } from "@/lib/format";
import type { Category, Ingredient, LocationProduct, ModifierGroup, Product, RecipeItem } from "@/lib/pos";

/** Taxes a Colombian restaurant charges, included in the price. */
const TAXES = [
  { rate: "8", label: "Impoconsumo 8%" },
  { rate: "19", label: "IVA 19%" },
  { rate: "5", label: "IVA 5%" },
  { rate: "0", label: "Sin impuesto" },
];

const labelClass = "mb-1.5 block text-sm font-medium text-ink-2";
const sectionClass = "border-t border-line pt-5";
const iconButton =
  "flex size-11 shrink-0 items-center justify-center rounded-control text-muted transition-[background-color,color] duration-150 hover:bg-danger-soft hover:text-danger";

interface RecipeLine {
  key: string;
  ingredient_id: string;
  quantity: string;
}

/** Whole-peso field shown as "$ 15.000"; empty = null. */
function Money({
  value,
  onChange,
  ...rest
}: { value: number | null; onChange: (value: number | null) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  return (
    <input
      {...rest}
      inputMode="numeric"
      value={value === null ? "" : cop(value)}
      onChange={(e) => onChange(/\d/.test(e.target.value) ? pesos(e.target.value) : null)}
      className={`${field} figures`}
    />
  );
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** What stops the product from saving, said the way the owner fixes it; null when it can save. */
function problem(name: string, price: number | null, groups: ModifierGroup[], recipe: RecipeLine[]): string | null {
  if (!name.trim()) return "Escribe el nombre del producto.";
  if (price === null) return "Escribe el precio del producto.";
  for (const [i, g] of groups.entries()) {
    if (!g.name.trim() || groups.some((o, j) => j < i && same(o.name, g.name))) return "Cada grupo de opciones necesita un nombre distinto.";
    if (!g.options.length) return `Agrega al menos una opción en "${g.name}".`;
    if (g.options.some((o, j) => !o.name.trim() || g.options.some((p, k) => k < j && same(p.name, o.name)))) {
      return `Las opciones de "${g.name}" necesitan nombres distintos.`;
    }
  }
  if (recipe.some((l) => !l.ingredient_id || !(Number(l.quantity.replace(",", ".")) > 0))) {
    return "Cada ingrediente de la receta necesita una cantidad mayor que cero.";
  }
  if (new Set(recipe.map((l) => l.ingredient_id)).size !== recipe.length) return "Un ingrediente aparece dos veces en la receta.";
  return null;
}

/**
 * Create or edit a product: master data and options (organization-wide), recipe for the inventory, and its
 * price and availability at the current location.
 */
export function ProductForm({
  product,
  categories,
  local,
  locationName,
  onSaved,
  onDeleted,
}: {
  product?: Product;
  categories: Category[];
  local?: LocationProduct;
  locationName: string;
  onSaved: (product: Product, local: LocationProduct) => void;
  onDeleted: (id: string) => void;
}) {
  const api = useApi();
  const [name, setName] = useState(product?.name ?? "");
  const [categoryId, setCategoryId] = useState(product?.category_id ?? "");
  const [price, setPrice] = useState<number | null>(product ? Number(product.base_price_cop) : null);
  const [tax, setTax] = useState(product ? String(Number(product.tax_rate)) : "8");
  const [description, setDescription] = useState(product?.description ?? "");
  const [active, setActive] = useState(product?.is_active ?? true);
  const [groups, setGroups] = useState<ModifierGroup[]>(product?.modifiers_schema ?? []);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  // null until loaded: saving replaces the whole recipe, so it must not save an empty one by accident.
  const [recipe, setRecipe] = useState<RecipeLine[] | null>(product ? null : []);
  const [localPrice, setLocalPrice] = useState<number | null>(local?.custom_price_cop == null ? null : Number(local.custom_price_cop));
  const [available, setAvailable] = useState(local?.is_available ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // A new product that saved but failed a later step is updated on retry, not created twice.
  const created = useRef<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [all, current] = await Promise.all([
          api<Ingredient[]>("/ingredients"),
          product ? api<RecipeItem[]>(`/products/${product.id}/recipe`) : Promise.resolve([]),
        ]);
        setIngredients(all);
        if (product) {
          setRecipe(current.map((r) => ({ key: r.ingredient_id, ingredient_id: r.ingredient_id, quantity: String(Number(r.quantity_required)) })));
        }
      } catch (err) {
        setError(errorMessage(err));
      }
    })();
  }, [api, product]);

  const setGroup = (i: number, patch: Partial<ModifierGroup>) => setGroups(groups.map((g, j) => (j === i ? { ...g, ...patch } : g)));
  const setOption = (i: number, k: number, patch: Partial<ModifierGroup["options"][number]>) =>
    setGroup(i, { options: groups[i].options.map((o, j) => (j === k ? { ...o, ...patch } : o)) });

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!recipe) return;
    const issue = problem(name, price, groups, recipe);
    if (issue) return setError(issue);
    setBusy(true);
    setError(null);
    try {
      const body = {
        name: name.trim(),
        category_id: categoryId || null,
        base_price_cop: price,
        tax_rate: Number(tax),
        description: description.trim() || null,
        is_active: active,
        modifiers_schema: groups.map((g) => ({
          name: g.name.trim(),
          required: g.required,
          multiple: g.multiple,
          options: g.options.map((o) => ({ name: o.name.trim(), price_cop: o.price_cop })),
        })),
      };
      const id = product?.id ?? created.current;
      const saved = id ? await api<Product>(`/products/${id}`, "PATCH", body) : await api<Product>("/products", "POST", body);
      created.current = saved.id;
      await api(
        `/products/${saved.id}/recipe`,
        "PUT",
        recipe.map((l) => ({ ingredient_id: l.ingredient_id, quantity_required: Number(l.quantity.replace(",", ".")) })),
      );
      const here = await api<LocationProduct>(`/location-products/${saved.id}`, "PUT", { custom_price_cop: localPrice, is_available: available });
      onSaved(saved, here);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/products/${product!.id}`, "DELETE");
      onDeleted(product!.id);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409
          ? "Este producto ya se vendió y no se puede eliminar. Desactívalo para sacarlo del menú."
          : errorMessage(err),
      );
      setConfirmDelete(false);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} noValidate className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block sm:col-span-2">
          <span className={labelClass}>Nombre</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={150} required className={field} />
        </label>
        <label className="block">
          <span className={labelClass}>Categoría</span>
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className={field}>
            <option value="">Sin categoría</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={labelClass}>Impuesto incluido</span>
          <select value={tax} onChange={(e) => setTax(e.target.value)} className={field}>
            {TAXES.map((t) => (
              <option key={t.rate} value={t.rate}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={labelClass}>Precio</span>
          <Money value={price} onChange={setPrice} required placeholder="$ 0" />
        </label>
        <label className="flex min-h-11 items-center gap-3 self-end text-[15px]">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="size-5 accent-accent" />
          Activo en el menú
        </label>
        <label className="block sm:col-span-2">
          <span className={labelClass}>Descripción</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} placeholder="Opcional" className={field} />
        </label>
      </div>

      <section aria-labelledby="opciones" className={sectionClass}>
        <h3 id="opciones" className="text-[15px] font-semibold">
          Opciones
        </h3>
        <p className="mt-0.5 text-sm text-muted">Tamaños, extras o términos que el cliente elige al pedir.</p>
        <div className="mt-3 space-y-3">
          {groups.map((g, i) => (
            <fieldset key={i} className="rounded-panel border border-line p-4">
              <legend className="sr-only">Grupo {g.name || i + 1}</legend>
              <div className="flex items-end gap-2">
                <label className="block flex-1">
                  <span className={labelClass}>Grupo</span>
                  <input value={g.name} onChange={(e) => setGroup(i, { name: e.target.value })} maxLength={60} placeholder="Tamaño" className={field} />
                </label>
                <button type="button" onClick={() => setGroups(groups.filter((_, j) => j !== i))} aria-label={`Quitar el grupo ${g.name}`} className={iconButton}>
                  <Trash2 size={18} aria-hidden />
                </button>
              </div>
              <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-[15px]">
                <label className="flex min-h-11 items-center gap-3">
                  <input type="checkbox" checked={g.required} onChange={(e) => setGroup(i, { required: e.target.checked })} className="size-5 accent-accent" />
                  Obligatorio
                </label>
                <label className="flex min-h-11 items-center gap-3">
                  <input type="checkbox" checked={g.multiple} onChange={(e) => setGroup(i, { multiple: e.target.checked })} className="size-5 accent-accent" />
                  Puede elegir varias
                </label>
              </div>
              <ul className="mt-2 space-y-2">
                {g.options.map((o, k) => (
                  <li key={k} className="flex items-center gap-2">
                    <input
                      value={o.name}
                      onChange={(e) => setOption(i, k, { name: e.target.value })}
                      maxLength={60}
                      aria-label={`Opción ${k + 1} de ${g.name || "el grupo"}`}
                      placeholder="Grande"
                      className={`${field} flex-1`}
                    />
                    <div className="w-32 shrink-0">
                      <Money value={o.price_cop} onChange={(v) => setOption(i, k, { price_cop: v ?? 0 })} aria-label={`Precio extra de ${o.name || "la opción"}`} />
                    </div>
                    <button
                      type="button"
                      onClick={() => setGroup(i, { options: g.options.filter((_, j) => j !== k) })}
                      aria-label={`Quitar la opción ${o.name}`}
                      className={iconButton}
                    >
                      <X size={18} aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => setGroup(i, { options: [...g.options, { name: "", price_cop: 0 }] })}
                className={`${button.ghost} mt-2 -ml-3 pl-2.5`}
              >
                <Plus size={18} strokeWidth={2.25} aria-hidden />
                Agregar opción
              </button>
            </fieldset>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setGroups([...groups, { name: "", required: false, multiple: false, options: [{ name: "", price_cop: 0 }] }])}
          className={`${button.secondary} mt-3 pl-3.5`}
        >
          <Plus size={18} strokeWidth={2.25} aria-hidden />
          Agregar grupo de opciones
        </button>
      </section>

      <section aria-labelledby="receta" className={sectionClass}>
        <h3 id="receta" className="text-[15px] font-semibold">
          Receta
        </h3>
        <p className="mt-0.5 text-sm text-muted">Lo que se descuenta del inventario por cada unidad vendida.</p>
        {!recipe ? (
          <p role="status" className="mt-3 text-sm text-muted">
            Cargando receta…
          </p>
        ) : !ingredients.length ? (
          <p className="mt-3 text-sm text-muted">Todavía no hay ingredientes. Créalos en Inventario para armar la receta.</p>
        ) : (
          <>
            <ul className="mt-3 space-y-2">
              {recipe.map((l, k) => {
                const unit = ingredients.find((g) => g.id === l.ingredient_id)?.unit;
                return (
                  <li key={l.key} className="flex items-center gap-2">
                    <select
                      value={l.ingredient_id}
                      onChange={(e) => setRecipe(recipe.map((r, j) => (j === k ? { ...r, ingredient_id: e.target.value } : r)))}
                      aria-label={`Ingrediente ${k + 1}`}
                      className={`${field} flex-1`}
                    >
                      <option value="">Elige un ingrediente</option>
                      {ingredients.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name}
                        </option>
                      ))}
                    </select>
                    <div className="relative w-32 shrink-0">
                      <input
                        inputMode="decimal"
                        value={l.quantity}
                        onChange={(e) => setRecipe(recipe.map((r, j) => (j === k ? { ...r, quantity: e.target.value.replace(/[^\d.,]/g, "") } : r)))}
                        aria-label={`Cantidad de ${ingredients.find((g) => g.id === l.ingredient_id)?.name ?? "ingrediente"}`}
                        placeholder="0"
                        className={`${field} figures ${unit ? "pr-12" : ""}`}
                      />
                      {unit && <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted">{unit}</span>}
                    </div>
                    <button
                      type="button"
                      onClick={() => setRecipe(recipe.filter((_, j) => j !== k))}
                      aria-label={`Quitar ${ingredients.find((g) => g.id === l.ingredient_id)?.name ?? "el ingrediente"}`}
                      className={iconButton}
                    >
                      <X size={18} aria-hidden />
                    </button>
                  </li>
                );
              })}
            </ul>
            <button
              type="button"
              onClick={() => setRecipe([...recipe, { key: crypto.randomUUID(), ingredient_id: "", quantity: "" }])}
              className={`${button.secondary} mt-3 pl-3.5`}
            >
              <Plus size={18} strokeWidth={2.25} aria-hidden />
              Agregar ingrediente
            </button>
          </>
        )}
      </section>

      <section aria-labelledby="sede" className={sectionClass}>
        <h3 id="sede" className="text-[15px] font-semibold">
          En {locationName}
        </h3>
        <p className="mt-0.5 text-sm text-muted">Precio propio de esta sede y si se vende hoy.</p>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className={labelClass}>Precio en esta sede</span>
            <Money value={localPrice} onChange={setLocalPrice} placeholder={price === null ? "Igual al precio" : `Igual: ${cop(price)}`} />
          </label>
          <label className="flex min-h-11 items-center gap-3 self-end text-[15px]">
            <input type="checkbox" checked={available} onChange={(e) => setAvailable(e.target.checked)} className="size-5 accent-accent" />
            Disponible en esta sede
          </label>
        </div>
      </section>

      {error && (
        <p role="alert" className="rounded-control bg-danger-soft px-3 py-2.5 text-sm text-danger">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-5">
        {product &&
          (confirmDelete ? (
            <>
              <span className="text-sm text-ink-2">¿Eliminar {product.name}?</span>
              <button type="button" disabled={busy} onClick={() => void remove()} className={button.danger}>
                Eliminar
              </button>
              <button type="button" onClick={() => setConfirmDelete(false)} className={button.ghost}>
                No
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setConfirmDelete(true)} className={`${button.quietDanger} -ml-3`}>
              Eliminar producto
            </button>
          ))}
        <button type="submit" disabled={busy || !recipe} className={`${button.primary} ml-auto`}>
          {busy && <LoaderCircle size={18} className="animate-spin motion-reduce:[animation-duration:6s]" aria-hidden />}
          {product ? "Guardar cambios" : "Crear producto"}
        </button>
      </div>
    </form>
  );
}
