"use client";

import { Check, Copy, LoaderCircle, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Dialog } from "@/components/dialog";
import { FormAlert } from "@/components/form-alert";
import { button, field } from "@/components/ui";
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
const badge = "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium";

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
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const multi = me.organization.plan_tier === "MULTI";

  const load = useCallback(() => api<Device[]>("/devices").then(setDevices, (err) => setError(errorMessage(err))), [api]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!devices) {
    return error ? (
      <p role="alert" className="rounded-panel border border-line bg-surface px-5 py-10 text-center text-[15px] text-danger">
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
    <div>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <p className="max-w-xl text-sm text-muted text-pretty">
          En estos dispositivos tu equipo entra con su usuario y PIN, en la sede del dispositivo. Al desvincular uno, se borra y se
          cierran sus sesiones.
        </p>
        <button type="button" onClick={() => setLinking(true)} className={`${button.primary} ml-auto pl-3.5`}>
          <Plus size={18} strokeWidth={2.25} aria-hidden />
          Vincular dispositivo
        </button>
      </div>

      {devices.length ? (
        <ul className="divide-y divide-line rounded-panel border border-line bg-surface">
          {devices.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[15px] font-medium">{d.name}</p>
                <p className="truncate text-sm text-muted">
                  {multi && `${d.locations.name} · `}
                  {d.last_used_at ? `Usado ${dateTime(d.last_used_at)}` : "Sin usar todavía"}
                </p>
                {rowError?.id === d.id && (
                  <p role="alert" className="mt-1 text-sm text-danger">
                    {rowError.message}
                  </p>
                )}
              </div>
              {d.current && <span className={`${badge} bg-accent-soft text-accent-strong`}>Este dispositivo</span>}
              {unlinking === d.id ? (
                <div className="-mr-3 flex gap-1">
                  <button type="button" onClick={() => void unlink(d)} className={button.danger}>
                    Desvincular
                  </button>
                  <button type="button" onClick={() => setUnlinking(null)} className={button.ghost}>
                    No
                  </button>
                </div>
              ) : (
                <button type="button" onClick={() => setUnlinking(d.id)} className={`${button.quietDanger} -mr-3`}>
                  Desvincular
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-panel border border-line bg-surface px-5 py-10 text-center text-[15px] text-muted text-pretty">
          Todavía no hay dispositivos vinculados. Vincula la caja o la tablet del negocio para que tu equipo entre con usuario y PIN.
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
  const shown = `${link.code.slice(0, 4)}-${link.code.slice(4)}`;

  const copy = async () => {
    await navigator.clipboard.writeText(link.code).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-5">
      <div className="rounded-control bg-ground px-5 py-6 text-center">
        <p className="text-sm text-muted">
          {link.name}
          {multi && link.location && ` · ${link.location}`}
        </p>
        <p
          className={`mt-2 font-mono text-[32px] leading-none font-semibold tracking-[0.12em] ${left ? "text-ink" : "text-muted line-through"}`}
          aria-label={`Código ${link.code.split("").join(" ")}`}
        >
          {shown}
        </p>
        <p role="status" className="figures mt-3 text-sm text-muted">
          {left ? `Vence en ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "Venció. Cierra y genera otro."}
        </p>
        {left > 0 && (
          <button type="button" onClick={() => void copy()} className={`${button.ghost} mt-2 pl-3.5`}>
            {/* Both icons stay mounted and cross-fade (scale 0.25 → 1, blur 4px → 0); reduced motion fades only. */}
            <span aria-hidden className="relative size-[18px]">
              {[false, true].map((state) => (
                <span
                  key={String(state)}
                  className={`absolute inset-0 transition-[opacity,scale,filter] duration-300 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-opacity ${
                    copied === state ? "opacity-100" : "opacity-0 motion-safe:scale-25 motion-safe:blur-[4px]"
                  }`}
                >
                  {state ? <Check size={18} strokeWidth={2.25} /> : <Copy size={18} strokeWidth={2.25} />}
                </span>
              ))}
            </span>
            {copied ? "Copiado" : "Copiar código"}
          </button>
        )}
      </div>
      <ol className="list-decimal space-y-1.5 pl-5 text-[15px] text-ink-2 marker:text-muted">
        <li>En el dispositivo nuevo, abre PractiMesa y escribe @{handle}.</li>
        <li>Toca “Tengo un código de vinculación” y escribe este código.</li>
        <li>Listo: tu equipo ya puede entrar ahí con su usuario y PIN.</li>
      </ol>
    </div>
  );
}
