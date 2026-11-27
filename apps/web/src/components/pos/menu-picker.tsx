"use client";

import { Minus, Plus } from "lucide-react";
import { useState } from "react";
import { Dialog } from "@/components/dialog";
import { button, field } from "@/components/ui";
import { cop } from "@/lib/format";
import type { Category, MenuItem } from "@/lib/pos";

export interface Pick {
  group: string;
  option: string;
  price_cop: number;
}

/** A line of the round being composed, before it goes to the kitchen. */
export interface DraftLine {
  key: string;
  item: MenuItem;
  quantity: number;
  picks: Pick[];
  notes: string;
}

export const unitPrice = (picks: Pick[], item: MenuItem) => item.price + picks.reduce((sum, p) => sum + p.price_cop, 0);
export const linePrice = (l: DraftLine) => unitPrice(l.picks, l.item) * l.quantity;

/** Category chips and product buttons; products with modifiers open a dialog to pick them. */
export function MenuPicker({
  menu,
  categories,
  onAdd,
}: {
  menu: MenuItem[];
  categories: Category[];
  onAdd: (line: Omit<DraftLine, "key">) => void;
}) {
  const [category, setCategory] = useState<string | null>(null);
  const [choosing, setChoosing] = useState<MenuItem | null>(null);
  const used = categories.filter((c) => menu.some((m) => m.category_id === c.id));
  const shown = category ? menu.filter((m) => m.category_id === category) : menu;

  if (!menu.length) {
    return (
      <p className="pm-card px-5 py-10 text-center text-[15px] text-muted">
        Esta sede todavía no tiene productos en el menú.
      </p>
    );
  }

  return (
    <div>
      {used.length > 0 && (
        <div role="group" aria-label="Categorías" className="-mx-1 mb-4 flex gap-2 overflow-x-auto px-1 pb-1">
          {[{ id: null, name: "Todo" }, ...used].map((c) => (
            <button
              key={c.id ?? "all"}
              type="button"
              aria-pressed={category === c.id}
              onClick={() => setCategory(c.id)}
              className="h-10 shrink-0 rounded-full border border-line-strong bg-surface px-4 text-sm font-medium text-ink-2 transition-[background-color,border-color,color] duration-150 hover:not-aria-pressed:bg-ground aria-pressed:border-accent aria-pressed:bg-accent-soft aria-pressed:text-accent-strong"
            >
              {c.name}
            </button>
          ))}
        </div>
      )}

      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
        {shown.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              disabled={!item.available}
              onClick={() => (item.modifiers.length ? setChoosing(item) : onAdd({ item, quantity: 1, picks: [], notes: "" }))}
              className="flex h-full min-h-24 w-full flex-col justify-between gap-2 pm-card p-4 text-left transition-[background-color,border-color,scale] duration-150 ease-out hover:enabled:border-line-strong hover:enabled:bg-ground motion-safe:enabled:active:scale-[0.96] disabled:cursor-not-allowed"
            >
              <span className="text-[15px] leading-snug font-medium text-pretty">{item.name}</span>
              <span className="figures text-sm text-muted">
                {item.available ? cop(item.price) : "No disponible"}
                {item.available && item.modifiers.length > 0 && " · con opciones"}
              </span>
            </button>
          </li>
        ))}
      </ul>

      <Dialog open={choosing !== null} onClose={() => setChoosing(null)} title={choosing?.name ?? ""}>
        {choosing && (
          <ModifierForm
            item={choosing}
            onSubmit={(line) => {
              onAdd(line);
              setChoosing(null);
            }}
          />
        )}
      </Dialog>
    </div>
  );
}

function ModifierForm({ item, onSubmit }: { item: MenuItem; onSubmit: (line: Omit<DraftLine, "key">) => void }) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState("");
  const picks: Pick[] = item.modifiers.flatMap((g) =>
    (selected[g.name] ?? []).map((name) => ({
      group: g.name,
      option: name,
      price_cop: g.options.find((o) => o.name === name)?.price_cop ?? 0,
    })),
  );
  const missing = item.modifiers.filter((g) => g.required && !selected[g.name]?.length);

  const toggle = (group: string, option: string, multiple: boolean) =>
    setSelected((s) => {
      const current = s[group] ?? [];
      if (!multiple) return { ...s, [group]: [option] };
      return { ...s, [group]: current.includes(option) ? current.filter((o) => o !== option) : [...current, option] };
    });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!missing.length) onSubmit({ item, quantity, picks, notes: notes.trim() });
      }}
      className="space-y-5"
    >
      {item.modifiers.map((g) => (
        <fieldset key={g.name}>
          <legend className="mb-2 flex w-full items-baseline justify-between gap-3 text-sm font-semibold text-ink-2">
            {g.name}
            <span className="text-xs font-normal text-muted">
              {g.required ? "Obligatorio" : "Opcional"}
              {g.multiple ? " · puedes elegir varias" : ""}
            </span>
          </legend>
          <div className="divide-y divide-line rounded-control border border-line">
            {g.options.map((o) => (
              <label
                key={o.name}
                className="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2 text-[15px] transition-[background-color] duration-150 hover:bg-ground"
              >
                <input
                  type={g.multiple ? "checkbox" : "radio"}
                  name={g.name}
                  checked={selected[g.name]?.includes(o.name) ?? false}
                  onChange={() => toggle(g.name, o.name, g.multiple)}
                  className="size-4 accent-accent"
                />
                <span className="flex-1">{o.name}</span>
                {o.price_cop > 0 && <span className="figures text-sm text-muted">+ {cop(o.price_cop)}</span>}
              </label>
            ))}
          </div>
        </fieldset>
      ))}

      <label className="block">
        <span className="mb-2 block text-sm font-semibold text-ink-2">Nota para cocina</span>
        <input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={200} placeholder="Opcional" className={field} />
      </label>

      <div className="flex items-center gap-3">
        <Stepper value={quantity} onChange={setQuantity} label={item.name} />
        <button type="submit" disabled={missing.length > 0} className={`${button.primary} flex-1`}>
          Agregar · {cop(unitPrice(picks, item) * quantity)}
        </button>
      </div>
      {missing.length > 0 && (
        <p className="text-sm text-muted">Elige {missing.map((g) => g.name.toLowerCase()).join(" y ")} para agregarlo.</p>
      )}
    </form>
  );
}

/** Quantity control; going below 1 removes the line when onRemove is given. */
export function Stepper({
  value,
  onChange,
  label,
  onRemove,
}: {
  value: number;
  onChange: (n: number) => void;
  label: string;
  onRemove?: () => void;
}) {
  const icon =
    "flex size-11 items-center justify-center text-ink-2 transition-[background-color] duration-150 hover:enabled:bg-ground disabled:opacity-40";
  return (
    <div className="flex shrink-0 items-center rounded-control border border-line-strong bg-surface">
      <button
        type="button"
        aria-label={value <= 1 && onRemove ? `Quitar ${label}` : `Uno menos: ${label}`}
        disabled={value <= 1 && !onRemove}
        onClick={() => (value <= 1 ? onRemove?.() : onChange(value - 1))}
        className={`${icon} rounded-l-[7px]`}
      >
        <Minus size={18} aria-hidden />
      </button>
      <span className="figures w-8 text-center text-[15px] font-medium">{value}</span>
      <button
        type="button"
        aria-label={`Uno más: ${label}`}
        disabled={value >= 99}
        onClick={() => onChange(value + 1)}
        className={`${icon} rounded-r-[7px]`}
      >
        <Plus size={18} aria-hidden />
      </button>
    </div>
  );
}
