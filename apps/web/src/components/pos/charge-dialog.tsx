"use client";

import { AlertTriangle, CircleCheck, ExternalLink, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { button, choice, field } from "@/components/ui";
import { errorMessage, useApi } from "@/lib/api";
import { cop } from "@/lib/format";
import type { Order, StockAlert } from "@/lib/pos";

type Method = "CASH" | "MANUAL_TRANSFER" | "FACTUS_PAY_QR";
type Tip = "none" | "5" | "10" | "other";

const METHODS: { value: Method; label: string }[] = [
  { value: "CASH", label: "Efectivo" },
  { value: "MANUAL_TRANSFER", label: "Transferencia" },
  { value: "FACTUS_PAY_QR", label: "QR Bre-B" },
];
const METHOD_LABEL: Record<string, string> = { CASH: "Efectivo", MANUAL_TRANSFER: "Transferencia", FACTUS_PAY_QR: "QR Bre-B" };
const TIPS: { value: Tip; label: string }[] = [
  { value: "none", label: "Sin propina" },
  { value: "5", label: "5%" },
  { value: "10", label: "10%" },
  { value: "other", label: "Otro valor" },
];
/** DIAN identification document codes offered at the counter. */
const DOCUMENTS = [
  { value: "13", label: "Cédula de ciudadanía" },
  { value: "31", label: "NIT" },
  { value: "22", label: "Cédula de extranjería" },
  { value: "41", label: "Pasaporte" },
];
/** Factus Pay accepts collections between these amounts. */
const QR_MIN = 10_000;
const QR_MAX = 12_100_000;

/**
 * Charges an order: tip, payment method and the electronic invoice switch (Q6). A QR payment waits on
 * screen and turns into "Pago recibido" by itself when the live feed brings the order back paid.
 */
export function ChargeForm({ order, onChange, onDone }: { order: Order; onChange: (order: Order) => void; onDone: () => void }) {
  const api = useApi();
  const [step, setStep] = useState<"form" | "qr" | "done">(order.payment_status === "PENDING_QR" ? "qr" : "form");
  const [alerts, setAlerts] = useState<StockAlert[]>([]);
  // The page keeps `order` fresh from the live feed; QR → paid needs no polling.
  const shown = step === "qr" && order.payment_status === "PAID" ? "done" : step;

  if (shown === "qr") return <QrStep order={order} onOtherMethod={() => setStep("form")} />;
  if (shown === "done") return <DoneStep order={order} alerts={alerts} onDone={onDone} />;

  return (
    <PaymentForm
      order={order}
      onPaid={(paid, stock) => {
        onChange(paid);
        setAlerts(stock);
        setStep(paid.payment_status === "PAID" ? "done" : "qr");
      }}
      api={api}
    />
  );
}

function PaymentForm({
  order,
  onPaid,
  api,
}: {
  order: Order;
  onPaid: (order: Order, alerts: StockAlert[]) => void;
  api: ReturnType<typeof useApi>;
}) {
  const [tip, setTip] = useState<Tip>("none");
  const [otherTip, setOtherTip] = useState("");
  const [method, setMethod] = useState<Method>("CASH");
  const [wantInvoice, setWantInvoice] = useState(order.factus_status === "PENDING");
  const [withData, setWithData] = useState(false);
  const [doc, setDoc] = useState("13");
  const [identification, setIdentification] = useState("");
  const [dv, setDv] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const subtotal = Number(order.subtotal_cop);
  const tipCop =
    tip === "none" ? 0 : tip === "other" ? Math.max(0, Math.round(Number(otherTip.replace(/\D/g, "")) || 0)) : Math.round((subtotal * Number(tip)) / 100);
  const due = Number(order.total_cop) + tipCop;
  const qrAllowed = due >= QR_MIN && due <= QR_MAX;
  const isCompany = doc === "31";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // The invoice is requested first: it validates the customer before money moves, and is emitted once paid.
      if (wantInvoice && (order.factus_status === "NOT_SENT" || order.factus_status === "ERROR")) {
        const customer = withData
          ? {
              identification_document_code: doc,
              identification: identification.trim(),
              legal_organization_code: isCompany ? "1" : "2",
              ...(isCompany ? { company: name.trim(), ...(dv ? { dv } : {}) } : { names: name.trim() }),
              ...(email.trim() ? { email: email.trim() } : {}),
            }
          : undefined;
        await api(`/orders/${order.id}/invoice`, "POST", customer ? { customer } : {});
      }
      const tipBody = tip === "5" || tip === "10" ? { tip_percent: Number(tip) } : tipCop ? { tip_cop: tipCop } : {};
      const paid = await api<Order & { stock_alerts?: StockAlert[] }>(`/orders/${order.id}/pay`, "POST", {
        payment_method: method,
        ...tipBody,
      });
      onPaid(paid, paid.stock_alerts ?? []);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-6">
      <dl className="space-y-1.5 text-[15px]">
        <Row label="Cuenta" value={cop(order.total_cop)} />
        <Row label="Propina" value={cop(tipCop)} />
        <div className="flex items-baseline justify-between border-t border-line pt-3">
          <dt className="font-semibold">Total a cobrar</dt>
          <dd className="figures text-2xl font-semibold tracking-[-0.02em]">{cop(due)}</dd>
        </div>
      </dl>

      <fieldset>
        <legend className="mb-2 text-sm font-semibold text-ink-2">Propina voluntaria</legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {TIPS.map((t) => (
            <label key={t.value} className={choice}>
              <input type="radio" name="tip" value={t.value} checked={tip === t.value} onChange={() => setTip(t.value)} className="sr-only" />
              {t.label}
            </label>
          ))}
        </div>
        {tip === "other" && (
          <input
            inputMode="numeric"
            aria-label="Valor de la propina en pesos"
            placeholder="$ 0"
            value={otherTip}
            onChange={(e) => setOtherTip(e.target.value)}
            className={`${field} figures mt-2`}
          />
        )}
        {(tip === "5" || tip === "10") && (
          <p className="mt-2 text-xs text-muted">Sobre el subtotal sin impuestos ({cop(subtotal)}).</p>
        )}
      </fieldset>

      <fieldset>
        <legend className="mb-2 text-sm font-semibold text-ink-2">Medio de pago</legend>
        <div className="grid grid-cols-3 gap-2">
          {METHODS.map((m) => (
            <label key={m.value} className={choice}>
              <input
                type="radio"
                name="method"
                value={m.value}
                checked={method === m.value}
                disabled={m.value === "FACTUS_PAY_QR" && !qrAllowed}
                onChange={() => setMethod(m.value)}
                className="sr-only"
              />
              {m.label}
            </label>
          ))}
        </div>
        {!qrAllowed && <p className="mt-2 text-xs text-muted">El QR Bre-B cobra desde {cop(QR_MIN)}.</p>}
      </fieldset>

      <fieldset className="rounded-control border border-line p-4">
        <legend className="sr-only">Factura electrónica</legend>
        <label className="flex cursor-pointer items-center justify-between gap-4">
          <span>
            <span className="block text-[15px] font-medium">¿Requiere factura electrónica?</span>
            <span className="block text-sm text-muted">Solo si el cliente la pide.</span>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={wantInvoice}
            disabled={order.factus_status === "PENDING"}
            onChange={(e) => setWantInvoice(e.target.checked)}
            className="peer sr-only"
          />
          <span
            aria-hidden
            className="relative h-6 w-10 shrink-0 rounded-full border border-transparent bg-line-strong transition-[background-color] duration-150 peer-checked:bg-accent peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent peer-disabled:opacity-50 after:absolute after:top-px after:left-px after:size-5 after:rounded-full after:border after:border-transparent after:bg-surface after:shadow-sm after:transition-[translate] after:duration-150 peer-checked:after:translate-x-4"
          />
        </label>

        {order.factus_status === "PENDING" && (
          <p className="mt-3 text-sm text-muted">Ya está pedida: se emite al recibir el pago.</p>
        )}
        {wantInvoice && order.factus_status !== "PENDING" && (
          <div className="mt-4 space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <label className={choice}>
                <input type="radio" name="invoice-to" checked={!withData} onChange={() => setWithData(false)} className="sr-only" />
                Consumidor final
              </label>
              <label className={choice}>
                <input type="radio" name="invoice-to" checked={withData} onChange={() => setWithData(true)} className="sr-only" />
                Con datos del cliente
              </label>
            </div>
            {withData && (
              <div className="grid gap-3 sm:grid-cols-[1fr_1fr]">
                <label className="block sm:col-span-2">
                  <span className="mb-1.5 block text-sm font-medium text-ink-2">Documento</span>
                  <select value={doc} onChange={(e) => setDoc(e.target.value)} className={field}>
                    {DOCUMENTS.map((d) => (
                      <option key={d.value} value={d.value}>
                        {d.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={`block ${isCompany ? "" : "sm:col-span-2"}`}>
                  <span className="mb-1.5 block text-sm font-medium text-ink-2">Número</span>
                  <input
                    required
                    inputMode={doc === "41" ? "text" : "numeric"}
                    pattern="[0-9A-Za-z]{3,20}"
                    value={identification}
                    onChange={(e) => setIdentification(e.target.value)}
                    className={`${field} figures`}
                  />
                </label>
                {isCompany && (
                  <label className="block">
                    <span className="mb-1.5 block text-sm font-medium text-ink-2">Dígito de verificación</span>
                    <input inputMode="numeric" pattern="[0-9]" maxLength={1} value={dv} onChange={(e) => setDv(e.target.value)} className={`${field} figures`} />
                  </label>
                )}
                <label className="block sm:col-span-2">
                  <span className="mb-1.5 block text-sm font-medium text-ink-2">{isCompany ? "Razón social" : "Nombre completo"}</span>
                  <input required maxLength={150} value={name} onChange={(e) => setName(e.target.value)} className={field} />
                </label>
                <label className="block sm:col-span-2">
                  <span className="mb-1.5 block text-sm font-medium text-ink-2">Correo para enviar la factura</span>
                  <input type="email" maxLength={150} placeholder="Opcional" value={email} onChange={(e) => setEmail(e.target.value)} className={field} />
                </label>
              </div>
            )}
          </div>
        )}
      </fieldset>

      {error && (
        <p role="alert" className="flex items-start gap-2 rounded-control bg-danger-soft px-3 py-2.5 text-sm text-danger">
          <AlertTriangle size={18} className="mt-px shrink-0" aria-hidden />
          {error}
        </p>
      )}

      <button type="submit" disabled={busy} className={`${button.primary} w-full`}>
        {busy && <LoaderCircle size={18} className="animate-spin motion-reduce:[animation-duration:6s]" aria-hidden />}
        {method === "FACTUS_PAY_QR" ? `Mostrar QR por ${cop(due)}` : `Cobrar ${cop(due)}`}
      </button>
    </form>
  );
}

function QrStep({ order, onOtherMethod }: { order: Order; onOtherMethod: () => void }) {
  const due = Number(order.total_cop) + Number(order.tip_cop);
  return (
    <div className="text-center">
      <p className="figures text-3xl font-semibold tracking-[-0.02em]">{cop(due)}</p>
      <p className="mt-1 text-sm text-muted">Pídele al cliente que escanee el código con la app de su banco.</p>
      {order.factus_qr_payload ? (
        // eslint-disable-next-line @next/next/no-img-element -- data URI from Factus Pay, nothing to optimize
        <img
          src={order.factus_qr_payload}
          alt={`Código QR de pago por ${cop(due)}`}
          className="mx-auto mt-5 size-64 rounded-control outline-1 -outline-offset-1 outline-black/10"
        />
      ) : (
        <div className="mx-auto mt-5 flex size-64 items-center justify-center rounded-control bg-ground text-sm text-muted">
          Generando el QR…
        </div>
      )}
      <p role="status" className="mt-5 flex items-center justify-center gap-2 text-[15px] font-medium text-ink-2">
        <LoaderCircle size={18} className="animate-spin motion-reduce:[animation-duration:6s]" aria-hidden />
        Esperando el pago
      </p>
      <p className="mt-1 text-sm text-muted">Esta pantalla cambia sola cuando el banco lo confirme.</p>
      <button type="button" onClick={onOtherMethod} className={`${button.ghost} mt-5`}>
        Cobrar por otro medio
      </button>
    </div>
  );
}

function DoneStep({ order, alerts, onDone }: { order: Order; alerts: StockAlert[]; onDone: () => void }) {
  const paid = Number(order.total_cop) + Number(order.tip_cop);
  return (
    <div>
      <div className="text-center">
        <CircleCheck size={40} strokeWidth={1.75} className="enter mx-auto text-success" aria-hidden />
        <p role="status" className="mt-3 text-lg font-semibold">
          Pago recibido
        </p>
        <p className="figures mt-1 text-3xl font-semibold tracking-[-0.02em]">{cop(paid)}</p>
        <p className="mt-1 text-sm text-muted">
          {METHOD_LABEL[order.payment_method ?? ""] ?? "Pago"}
          {Number(order.tip_cop) > 0 && ` · incluye propina de ${cop(order.tip_cop)}`}
        </p>
      </div>

      {order.factus_status !== "NOT_SENT" && (
        <div className="mt-6 rounded-control border border-line px-4 py-3 text-sm">
          {order.factus_status === "PENDING" && (
            <p className="flex items-center gap-2 text-ink-2">
              <LoaderCircle size={16} className="animate-spin motion-reduce:[animation-duration:6s]" aria-hidden />
              Emitiendo la factura electrónica…
            </p>
          )}
          {order.factus_status === "VALIDATED" && (
            <p className="flex flex-wrap items-center justify-between gap-2">
              <span>
                Factura <span className="figures font-medium">{order.factus_invoice_number}</span> validada por la DIAN
              </span>
              {order.factus_pdf_url && (
                <a href={order.factus_pdf_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-accent-strong underline">
                  Ver PDF
                  <ExternalLink size={14} aria-hidden />
                </a>
              )}
            </p>
          )}
          {order.factus_status === "ERROR" && (
            <p className="text-danger">No se pudo emitir la factura: {order.factus_error ?? "Factus la rechazó."}</p>
          )}
        </div>
      )}

      {alerts.length > 0 && (
        <div className="mt-4 rounded-control bg-warning-soft px-4 py-3 text-sm text-warning">
          <p className="font-semibold">Inventario bajo</p>
          <ul className="mt-1 space-y-0.5">
            {alerts.map((a) => (
              <li key={a.ingredient_id} className="figures">
                {a.name}: {Number(a.current_qty).toLocaleString("es-CO")} {a.unit}
              </li>
            ))}
          </ul>
        </div>
      )}

      <button type="button" onClick={onDone} className={`${button.primary} mt-6 w-full`}>
        Listo
      </button>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between text-muted">
      <dt>{label}</dt>
      <dd className="figures text-ink-2">{value}</dd>
    </div>
  );
}
