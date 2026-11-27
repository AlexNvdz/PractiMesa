"use client";

import { Check, Copy, Link2, LoaderCircle, Monitor, Smartphone, Tablet } from "lucide-react";
import { Fragment, useCallback, useEffect, useState } from "react";
import { Dialog } from "@/components/dialog";
import { FormAlert } from "@/components/form-alert";
import { button, field, tag } from "@/components/ui";
import { errorMessage, useApi } from "@/lib/api";
import type { Me } from "@/lib/auth";
import { dateTime } from "@/lib/format";

interface Device {
  id: string;
  name: string;
  location_id: string;
  last_used_at: string | null;
  created_at: string;
  current: boolean;
  locations: { name: string };
}

interface LinkCode {
  code: string;
  expires_at: string;
  name: string;
  location: string;
}

const labelClass = "mb-1.5 block text-sm font-medium text-ink-2";
/** The API stores a name only: the glyph follows what the name says (celular, pantalla de cocina, tablet by default). */
const glyph = (name: string) => (/celular|móvil|movil|teléfono|telefono|phone/i.test(name) ? Smartphone : /pantalla|monitor|cocina|tv/i.test(name) ? Monitor : Tablet);
const LIVE_MS = 2 * 60_000;

/**
 * Linked devices (owner only): where the team signs in with username + PIN, at the device's location.
 * The owner links one with a one-time code; unlinking deletes it and ends its sessions.
 */
export function Devices({ me }: { me: Me }) {
  const api = useApi();
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [unlinking, setUnlinking] = useState<string | null>(null);
  // "En uso ahora" is judged at the moment the list loaded.
  const [now] = useState(() => Date.now());
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);

  const load = useCallback(() => api<Device[]>("/devices").then(setDevices, (err) => setError(errorMessage(err))), [api]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!devices) {
    return error ? (
      <p role="alert" className="pm-card px-6 py-12 text-center text-danger">
        {error}
      </p>
    ) : (
      <p role="status" className="py-10 text-center text-[15px] text-muted">
        Cargando dispositivos…
      </p>
    );
  }

  const unlink = async (device: Device) => {
    setRowError(null);
    try {
      await api(`/devices/${device.id}`, "DELETE");
      setDevices(devices.filter((d) => d.id !== device.id));
      setUnlinking(null);
    } catch (err) {
      setRowError({ id: device.id, message: errorMessage(err) });
    }
  };

  return (
    <div className="max-w-[1240px]">
      <p className="-mt-1 mb-[18px] max-w-[70ch] text-muted text-pretty">
        Solo los dispositivos vinculados permiten entrar con usuario y PIN, en la sede del dispositivo. Desvincular uno cierra al
        instante las sesiones abiertas en él.
      </p>
      <div className="mb-4 flex flex-wrap items-center gap-2.5">
        <span className={tag.mute}>
          {devices.length} {devices.length === 1 ? "vinculado" : "vinculados"}
        </span>
        <button type="button" onClick={() => setLinking(true)} className={`${button.primary} ml-auto h-11 pl-3.5`}>
          <Link2 size={16} aria-hidden />
          Vincular dispositivo
        </button>
      </div>

      {devices.length ? (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
          {devices.map((d) => {
            const Glyph = glyph(d.name);
            const live = d.last_used_at !== null && now - new Date(d.last_used_at).getTime() < LIVE_MS;
            return (
              <li
                key={d.id}
                className={`pm-card grid grid-cols-[48px_1fr] items-start gap-3.5 p-[18px] ${
                  d.current ? "shadow-[0_0_0_2px_var(--color-accent),0_1px_2px_rgb(23_30_46/0.04)]" : ""
                }`}
              >
                <span aria-hidden className="grid size-12 place-items-center rounded-[14px] bg-ground text-ink-2">
                  <Glyph size={22} />
                </span>
                <div className="min-w-0">
                  <h3 className="truncate text-base font-[650]">{d.name}</h3>
                  <p className="truncate text-[13.5px] text-muted">{d.locations.name}</p>
                </div>
                <div className="col-span-full flex items-center justify-between gap-2 border-t border-line pt-3">
                  <span className="figures min-w-0 truncate text-[13.5px] text-ink-2">
                    <span aria-hidden className={`mr-1.5 inline-block size-2 rounded-full ${live ? "bg-success" : "bg-line-strong"}`} />
                    {live ? "En uso ahora" : d.last_used_at ? dateTime(d.last_used_at) : "Sin usar todavía"}
                  </span>
                  {d.current ? (
                    <span className={tag.info}>Este dispositivo</span>
                  ) : unlinking === d.id ? (
                    <div className="flex gap-1">
                      <button type="button" onClick={() => void unlink(d)} className={`${button.danger} h-9 px-3 text-[13.5px]`}>
                        Desvincular
                      </button>
                      <button type="button" onClick={() => setUnlinking(null)} className={`${button.ghost} h-9 px-3 text-[13.5px]`}>
                        No
                      </button>
                    </div>
                  ) : (
                    <button type="button" onClick={() => setUnlinking(d.id)} className={`${button.ghost} -mr-1 h-9 px-3 text-[13.5px]`}>
                      Desvincular
                    </button>
                  )}
                </div>
                {rowError?.id === d.id && (
                  <p role="alert" className="col-span-full text-sm text-danger">
                    {rowError.message}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="pm-card px-6 py-12 text-center text-muted text-pretty">
          <b className="mb-1 block text-base text-ink-2">Sin dispositivos vinculados</b>
          Vincula la caja o la tablet del negocio para que tu equipo entre con usuario y PIN.
        </p>
      )}

      <Dialog
        open={linking}
        onClose={() => {
          setLinking(false);
          // The device may have been linked with the code meanwhile.
          void load();
        }}
        title="Vincular dispositivo"
      >
        {linking && <LinkForm me={me} />}
      </Dialog>
    </div>
  );
}

/** Owner picks name + location and gets a one-time code to type on the new device (after the handle). */
function LinkForm({ me }: { me: Me }) {
  const api = useApi();
  const [name, setName] = useState("");
  const [locationId, setLocationId] = useState(me.current_location_id ?? me.locations[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<LinkCode | null>(null);
  const multi = me.organization.plan_tier === "MULTI";

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return setError("Ponle un nombre, por ejemplo Caja principal.");
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ code: string; expires_at: string }>("/devices/codes", "POST", {
        name: name.trim(),
        ...(multi ? { location_id: locationId } : {}),
      });
      setLink({ ...res, name: name.trim(), location: me.locations.find((l) => l.id === locationId)?.name ?? "" });
    } catch (err) {
      setError(errorMessage(err));
    }
    setBusy(false);
  };

  if (link) return <CodeView link={link} handle={me.organization.handle} multi={multi} />;

  return (
    <form onSubmit={submit} noValidate className="space-y-5">
      <p className="text-[15px] text-ink-2 text-pretty">
        Te damos un código de un solo uso. Escríbelo en el dispositivo nuevo, después del identificador del negocio.
      </p>
      <label className="block">
        <span className={labelClass}>Nombre del dispositivo</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Caja principal" className={field} />
      </label>
      {multi && (
        <label className="block">
          <span className={labelClass}>Sede</span>
          <select value={locationId} onChange={(e) => setLocationId(e.target.value)} className={field}>
            {me.locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {error && <FormAlert>{error}</FormAlert>}
      <div className="flex justify-end border-t border-line pt-5">
        <button type="submit" disabled={busy} className={button.primary}>
          {busy && <LoaderCircle size={18} className="animate-spin motion-reduce:[animation-duration:6s]" aria-hidden />}
          Generar código
        </button>
      </div>
    </form>
  );
}

/** The code, readable from across the counter, with the steps and a live countdown. */
function CodeView({ link, handle, multi }: { link: LinkCode; handle: string; multi: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const left = Math.max(0, Math.round((new Date(link.expires_at).getTime() - now) / 1000));

  const copy = async () => {
    await navigator.clipboard.writeText(link.code).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const R = 11;
  const C = 2 * Math.PI * R;
  const total = 600;
  const urgent = left > 0 && left <= 60;
  const cell = "grid h-12 w-9 place-items-center rounded-xl bg-ground font-display text-2xl font-[750] shadow-[inset_0_0_0_1px_var(--color-line)] min-[420px]:h-14 min-[420px]:w-11 min-[420px]:text-[28px]";

  return (
    <div className="space-y-[18px]">
      <p className="-mt-1 text-sm text-muted">
        {link.name}
        {multi && link.location && ` · ${link.location}`}
      </p>
      <div
        role="img"
        aria-label={`Código ${link.code.split("").join(" ")}`}
        className={`flex items-center justify-center gap-1.5 ${left ? "" : "opacity-40"}`}
      >
        {link.code.split("").map((c, i) => (
          <Fragment key={i}>
            {i === 4 && <span aria-hidden className="mx-0.5 h-[3px] w-3 rounded-sm bg-line-strong" />}
            <span aria-hidden className={cell}>
              {c}
            </span>
          </Fragment>
        ))}
      </div>
      <div role="status" className="figures flex items-center justify-center gap-2.5 font-semibold text-ink-2">
        <svg viewBox="0 0 28 28" aria-hidden className="size-7 -rotate-90">
          <circle cx="14" cy="14" r={R} fill="none" strokeWidth="3" className="stroke-line" />
          <circle
            cx="14"
            cy="14"
            r={R}
            fill="none"
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={C}
            strokeDashoffset={C * (1 - left / total)}
            className={`transition-[stroke-dashoffset] duration-1000 ease-linear ${urgent ? "stroke-danger" : "stroke-accent"}`}
          />
        </svg>
        <span className={urgent ? "text-danger" : ""}>
          {left ? `Vence en ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "Venció. Cierra y genera otro."}
        </span>
      </div>
      <ol className="grid gap-2.5 text-[14.5px] text-ink-2 [counter-reset:s]">
        {[
          <>
            En el dispositivo nuevo abre PractiMesa y escribe <b>@{handle}</b>.
          </>,
          <>
            Toca <b>Tengo un código de vinculación</b>.
          </>,
          <>Escribe este código. Sirve una sola vez.</>,
        ].map((step, i) => (
          <li key={i} className="grid grid-cols-[26px_1fr] gap-2.5">
            <span aria-hidden className="grid size-[26px] place-items-center rounded-full bg-accent-soft text-[13px] font-extrabold text-accent">
              {i + 1}
            </span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
      {left > 0 && (
        <div className="flex border-t border-line pt-4">
          <button type="button" onClick={() => void copy()} className={`${button.secondary} w-full pl-3.5`}>
            {/* Both icons stay mounted and cross-fade (scale 0.25 → 1, blur 4px → 0); reduced motion fades only. */}
            <span aria-hidden className="relative size-4">
              {[false, true].map((state) => (
                <span
                  key={String(state)}
                  className={`absolute inset-0 transition-[opacity,scale,filter] duration-300 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-opacity ${
                    copied === state ? "opacity-100" : "opacity-0 motion-safe:scale-25 motion-safe:blur-[4px]"
                  }`}
                >
                  {state ? <Check size={16} strokeWidth={2.25} /> : <Copy size={16} strokeWidth={2.25} />}
                </span>
              ))}
            </span>
            {copied ? "Copiado" : "Copiar código"}
          </button>
        </div>
      )}
    </div>
  );
}
