"use client";

import { LoaderCircle, Plus } from "lucide-react";
import { useEffect, useState } from "react";
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
  revoked_at: string | null;
  created_at: string;
  current: boolean;
  locations: { name: string };
  users: { full_name: string };
}

const labelClass = "mb-1.5 block text-sm font-medium text-ink-2";
const badge = "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium";

/**
 * Authorized devices (Q29, Q33): where the team signs in with username + PIN. Revoking one ends its sessions.
 * Admins see only the devices of their locations (Q42).
 */
export function Devices({ me }: { me: Me }) {
  const api = useApi();
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const multi = me.organization.plan_tier === "MULTI";

  useEffect(() => {
    api<Device[]>("/devices").then(setDevices, (err) => setError(errorMessage(err)));
  }, [api]);

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

  const revoke = async (device: Device) => {
    setRowError(null);
    try {
      await api(`/devices/${device.id}/revoke`, "POST");
      setDevices(devices.map((d) => (d.id === device.id ? { ...d, revoked_at: new Date().toISOString() } : d)));
      setRevoking(null);
    } catch (err) {
      setRowError({ id: device.id, message: errorMessage(err) });
    }
  };

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <p className="max-w-xl text-sm text-muted text-pretty">
          En estos dispositivos tu equipo entra con su usuario y PIN, en la sede del dispositivo. Al revocar uno, se cierran sus sesiones.
        </p>
        {!devices.some((d) => d.current && !d.revoked_at) && (
          <button type="button" onClick={() => setAdding(true)} className={`${button.primary} ml-auto pl-3.5`}>
            <Plus size={18} strokeWidth={2.25} aria-hidden />
            Autorizar este dispositivo
          </button>
        )}
      </div>

      {devices.length ? (
        <ul className="divide-y divide-line rounded-panel border border-line bg-surface">
          {devices.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className={`truncate text-[15px] font-medium ${d.revoked_at ? "text-muted" : ""}`}>{d.name}</p>
                <p className="truncate text-sm text-muted">
                  {multi && `${d.locations.name} · `}
                  {d.last_used_at ? `usado ${dateTime(d.last_used_at)}` : "sin usar"} · autorizado por {d.users.full_name}
                </p>
                {rowError?.id === d.id && (
                  <p role="alert" className="mt-1 text-sm text-danger">
                    {rowError.message}
                  </p>
                )}
              </div>
              {d.current && !d.revoked_at && <span className={`${badge} bg-accent-soft text-accent-strong`}>Este dispositivo</span>}
              {d.revoked_at && <span className={`${badge} bg-ground text-muted`}>Revocado</span>}
              {!d.revoked_at &&
                (revoking === d.id ? (
                  <div className="-mr-3 flex gap-1">
                    <button type="button" onClick={() => void revoke(d)} className={button.danger}>
                      Revocar
                    </button>
                    <button type="button" onClick={() => setRevoking(null)} className={button.ghost}>
                      No
                    </button>
                  </div>
                ) : (
                  <button type="button" onClick={() => setRevoking(d.id)} className={`${button.quietDanger} -mr-3`}>
                    Revocar
                  </button>
                ))}
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-panel border border-line bg-surface px-5 py-10 text-center text-[15px] text-muted text-pretty">
          Todavía no hay dispositivos autorizados. Autoriza la caja o la tablet del negocio para que tu equipo entre con usuario y PIN.
        </p>
      )}

      <Dialog open={adding} onClose={() => setAdding(false)} title="Autorizar este dispositivo">
        <AuthorizeForm
          me={me}
          onDone={(device) => {
            setDevices([device, ...devices.map((d) => ({ ...d, current: false }))]);
            setAdding(false);
          }}
        />
      </Dialog>
    </div>
  );
}

function AuthorizeForm({ me, onDone }: { me: Me; onDone: (device: Device) => void }) {
  const api = useApi();
  const [name, setName] = useState("");
  const [locationId, setLocationId] = useState(me.current_location_id ?? me.locations[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const multi = me.organization.plan_tier === "MULTI";

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return setError("Ponle un nombre, por ejemplo Caja principal.");
    setBusy(true);
    setError(null);
    try {
      onDone(await api<Device>("/devices", "POST", { name: name.trim(), ...(multi ? { location_id: locationId } : {}) }));
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-5">
      <p className="text-[15px] text-ink-2 text-pretty">
        Desde ahora, en este navegador tu equipo podrá entrar con su usuario y PIN
        {multi ? " en la sede que elijas." : "."}
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
          Autorizar
        </button>
      </div>
    </form>
  );
}
