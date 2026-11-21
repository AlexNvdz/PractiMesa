const COP = new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 });

/** "$ 15.000". The API sends money as decimal strings. */
export const cop = (value: string | number) => COP.format(Number(value));

/** Whole pesos typed in a money field ("$ 15.000" → 15000). */
export const pesos = (text: string) => Number(text.replace(/\D/g, "")) || 0;

const TIME = new Intl.DateTimeFormat("es-CO", { hour: "numeric", minute: "2-digit", timeZone: "America/Bogota" });
const DATE_TIME = new Intl.DateTimeFormat("es-CO", {
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "America/Bogota",
});

export const time = (iso: string) => TIME.format(new Date(iso));
export const dateTime = (iso: string) => DATE_TIME.format(new Date(iso));

/** Time since an ISO date: "12 min", "2 h 41 min". */
export function elapsed(iso: string, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
