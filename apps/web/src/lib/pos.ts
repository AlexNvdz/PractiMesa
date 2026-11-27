/** API shapes used by the POS screens (money and rates arrive as decimal strings). */

export type TableStatus = "FREE" | "OCCUPIED" | "RESERVED";

export interface Floor {
  id: string;
  name: string;
}

export interface DiningTable {
  id: string;
  name: string;
  number: number;
  capacity: number;
  status: TableStatus;
  floor_id: string | null;
}

export interface ModifierGroup {
  name: string;
  required: boolean;
  multiple: boolean;
  options: { name: string; price_cop: number }[];
}

export interface Category {
  id: string;
  name: string;
  sort_order: number;
}

export interface Product {
  id: string;
  name: string;
  category_id: string | null;
  base_price_cop: string;
  tax_rate: string;
  description: string | null;
  modifiers_schema: ModifierGroup[];
  is_active: boolean;
  /** Set = product of that location only; null = chain product (Q43). */
  location_id: string | null;
}

export interface Ingredient {
  id: string;
  name: string;
  unit: string;
}

/** Stock of one ingredient at the current location; a missing row means 0. */
export interface LocationStock {
  ingredient_id: string;
  current_qty: string;
  min_alert_qty: string;
}

export interface RecipeItem {
  ingredient_id: string;
  quantity_required: string;
}

export interface LocationProduct {
  product_id: string;
  custom_price_cop: string | null;
  is_available: boolean;
  /** false = this location never sells it (permanent); is_available = false is "sold out today". */
  is_listed: boolean;
}

/** A product as this location sells it. */
export interface MenuItem {
  id: string;
  name: string;
  category_id: string | null;
  price: number;
  available: boolean;
  modifiers: ModifierGroup[];
}

export interface OrderItem {
  id: string;
  quantity: number;
  unit_price_cop: string;
  selected_modifiers: { group: string; option: string; price_cop: number }[];
  notes: string | null;
  round: number;
  products: { name: string };
  /** Voided lines stay on the account, out of totals (Q55). */
  voided_at: string | null;
  void_reason: VoidReason | null;
  void_note: string | null;
  voider?: { full_name: string } | null;
}

export type VoidReason = "MISTAKE" | "NOT_WANTED" | "DELAY" | "OTHER";
export const VOID_REASONS: Record<VoidReason, string> = {
  MISTAKE: "Error al pedir",
  NOT_WANTED: "El cliente ya no lo quiere",
  DELAY: "Demora",
  OTHER: "Otro",
};

/** Lines still on the account (not voided). */
export const liveItems = <T extends { voided_at: string | null }>(items: T[]) => items.filter((i) => !i.voided_at);

/** Kitchen state of a round (comanda), in order. */
export type RoundStatus = "PENDING" | "PREPARING" | "READY" | "DELIVERED";

export interface OrderRound {
  id: string;
  round: number;
  status: RoundStatus;
  /** When the round went to the kitchen. */
  created_at: string;
}

export interface Order {
  id: string;
  order_number: number;
  table_id: string | null;
  order_type: "DINE_IN" | "PICKUP";
  status: string;
  payment_status: "UNPAID" | "PENDING_QR" | "PAID";
  payment_method: string | null;
  subtotal_cop: string;
  tax_cop: string;
  total_cop: string;
  tip_cop: string;
  factus_qr_payload: string | null;
  factus_status: "NOT_SENT" | "PENDING" | "VALIDATED" | "ERROR";
  factus_invoice_number: string | null;
  factus_pdf_url: string | null;
  factus_error: string | null;
  created_at: string;
  order_items: OrderItem[];
  order_rounds: OrderRound[];
  dining_tables: { name: string } | null;
}

/** A ticket on the kitchen screen (GET /kitchen/rounds): a round still to serve. */
export interface KitchenRound {
  id: string;
  order_id: string;
  round: number;
  status: Exclude<RoundStatus, "DELIVERED">;
  created_at: string;
  orders: { order_number: number; order_type: Order["order_type"]; dining_tables: { name: string } | null };
  order_items: Pick<OrderItem, "id" | "quantity" | "selected_modifiers" | "notes" | "products" | "voided_at">[];
}

export interface StockAlert {
  ingredient_id: string;
  name: string;
  unit: string;
  current_qty: string;
}

export interface CashRegister {
  id: string;
  status: "OPEN" | "CLOSED";
  opened_at: string;
  closed_at: string | null;
  opening_amount_cop: string;
  expected_closing_cop: string | null;
  actual_closing_cop: string | null;
  users: { full_name: string } | null;
}

export const isOpen = (o: Order) => o.payment_status !== "PAID" && o.status !== "CANCELLED";

/** Rounds of an order still to serve: not delivered and with a line that was not voided. */
export const roundsToServe = (o: Order) =>
  o.order_rounds.filter((r) => r.status !== "DELIVERED" && o.order_items.some((i) => i.round === r.round && !i.voided_at));

/** Paid before the food reached the table: Mesas keeps showing it until every round is delivered. */
export const toServe = (o: Order) => o.payment_status === "PAID" && o.status !== "CANCELLED" && roundsToServe(o).length > 0;

/** A round the kitchen finished and nobody has taken to the table yet. */
export const hasReady = (o: Order) => o.order_rounds.some((r) => r.status === "READY");

/** Tables and counter orders with food ready; a table with two orders ready counts once. */
export const readyCount = (orders: Order[]) => new Set(orders.filter(hasReady).map((o) => o.table_id ?? o.id)).size;
