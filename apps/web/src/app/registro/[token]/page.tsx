"use client";

import { LoaderCircle } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { FormAlert } from "@/components/form-alert";
import { button, field } from "@/components/ui";
import { ApiError, useAuth } from "@/lib/auth";

interface Invitation {
  plan_tier: "SINGLE" | "MULTI";
  max_locations: number;
}

const HANDLE = /^[A-Za-z0-9_]{3,30}$/;
const labelClass = "mb-1.5 block text-sm font-medium text-ink-2";
const hintClass = "mt-1.5 text-sm text-muted text-pretty";

function messageFor(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) return "Demasiados intentos. Espera un minuto e inténtalo de nuevo.";
    // The API explains a taken handle or email, an invalid field or a spent link, in Spanish.
    if (err.detail && err.status < 500) return err.detail;
    return "Algo falló de nuestro lado. Inténtalo de nuevo en un momento.";
  }
  return "No pudimos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.";
}

/** Sign-up with a platform invitation (Q28): business, owner and first location, then straight into the panel. */
export default function RegistroPage() {
  const { token } = useParams<{ token: string }>();
  const { register } = useAuth();
  const router = useRouter();
  const [invitation, setInvitation] = useState<Invitation | null | undefined>(undefined);
  const [form, setForm] = useState({
    handle: "",
    business_name: "",
    nit: "",
    owner_name: "",
    email: "",
    phone: "",
    password: "",
    location_name: "",
    city: "",
    address: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const errorId = useId();
  const handleHint = useId();

  useEffect(() => {
    fetch(`/api/auth/register/${encodeURIComponent(token)}`)
      .then((res) => (res.ok ? (res.json() as Promise<Invitation>) : null))
      .then(setInvitation, () => setInvitation(null));
  }, [token]);

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: key === "handle" ? e.target.value.replace(/^@/, "").trim() : e.target.value }));

  const handleBad = checked && !HANDLE.test(form.handle);
  const missing = (["business_name", "owner_name", "email", "phone", "location_name", "city", "address"] as const).filter(
    (k) => !form[k].trim(),
  );

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setChecked(true);
    if (!HANDLE.test(form.handle)) return setError("Revisa el identificador: solo letras, números y _ (de 3 a 30).");
    if (missing.length) return setError("Completa los campos marcados.");
    if (form.password.length < 8) return setError("La contraseña debe tener al menos 8 caracteres.");
    setError(null);
    setSubmitting(true);
    try {
      const trimmed = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, k === "password" ? v : v.trim()]));
      await register(token, { ...trimmed, nit: trimmed.nit || null });
      router.replace("/");
    } catch (err) {
      setError(messageFor(err));
      setSubmitting(false);
    }
  }

  if (invitation === undefined) {
    return (
      <div role="status" className="flex min-h-dvh items-center justify-center text-muted">
        <LoaderCircle size={22} className="animate-spin motion-reduce:[animation-duration:6s]" aria-hidden />
        <span className="sr-only">Revisando tu invitación…</span>
      </div>
    );
  }

  const input = (key: keyof typeof form, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <input
      value={form[key]}
      onChange={set(key)}
      aria-invalid={checked && missing.includes(key as (typeof missing)[number]) ? true : undefined}
      className={field}
      {...props}
    />
  );

  return (
    <main className="flex min-h-dvh justify-center px-5 pt-[8vh] pb-12">
      <div className="w-full max-w-[560px]">
        <p className="enter mb-8 text-center text-xl font-semibold tracking-[-0.02em]">PractiMesa</p>

        {invitation ? (
          <div className="enter rounded-panel border border-line bg-surface p-7 [--i:1] sm:p-8">
            <h1 className="text-2xl font-semibold tracking-[-0.02em] text-balance">Crea tu negocio</h1>
            <p className="mt-1.5 text-[15px] text-muted text-pretty">
              Te invitaron al plan{" "}
              {invitation.plan_tier === "SINGLE" ? "Pequeño (1 sede)" : `Multilocal (hasta ${invitation.max_locations} sedes)`}. Al terminar
              entras directo a tu panel.
            </p>

            <form className="mt-7 space-y-8" onSubmit={onSubmit} noValidate>
              <fieldset className="space-y-4">
                <legend className="mb-4 text-[15px] font-semibold">Tu negocio</legend>
                <label className="block">
                  <span className={labelClass}>Identificador</span>
                  <span className="relative block">
                    <span aria-hidden className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-muted">
                      @
                    </span>
                    <input
                      value={form.handle}
                      onChange={set("handle")}
                      maxLength={30}
                      autoCapitalize="none"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="PizzeriaDario"
                      aria-invalid={handleBad || undefined}
                      aria-describedby={handleHint}
                      className={`${field} pl-7`}
                    />
                  </span>
                  <span id={handleHint} className={`block ${hintClass} ${handleBad ? "text-danger" : ""}`}>
                    Letras, números y _ (de 3 a 30). Es el nombre de tu tienda en línea y no se puede cambiar después.
                  </span>
                </label>
                <label className="block">
                  <span className={labelClass}>Nombre del negocio</span>
                  {input("business_name", { maxLength: 150, autoComplete: "organization", placeholder: "Pizzería Darío" })}
                </label>
                <label className="block">
                  <span className={labelClass}>NIT</span>
                  {input("nit", { maxLength: 30, inputMode: "numeric", placeholder: "Opcional", className: `${field} figures` })}
                </label>
              </fieldset>

              <fieldset className="space-y-4">
                <legend className="mb-4 text-[15px] font-semibold">Tu cuenta de dueño</legend>
                <label className="block">
                  <span className={labelClass}>Tu nombre</span>
                  {input("owner_name", { maxLength: 120, autoComplete: "name" })}
                </label>
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="block">
                    <span className={labelClass}>Correo</span>
                    {input("email", { type: "email", maxLength: 150, autoComplete: "email", autoCapitalize: "none", spellCheck: false })}
                  </label>
                  <label className="block">
                    <span className={labelClass}>Teléfono</span>
                    {input("phone", { type: "tel", maxLength: 30, autoComplete: "tel", className: `${field} figures` })}
                  </label>
                </div>
                <label className="block">
                  <span className={labelClass}>Contraseña</span>
                  {input("password", {
                    type: "password",
                    maxLength: 200,
                    autoComplete: "new-password",
                    "aria-invalid": checked && form.password.length < 8 ? true : undefined,
                  })}
                  <span className={`block ${hintClass}`}>Mínimo 8 caracteres.</span>
                </label>
              </fieldset>

              <fieldset className="space-y-4">
                <legend className="mb-4 text-[15px] font-semibold">Tu primera sede</legend>
                <label className="block">
                  <span className={labelClass}>Nombre de la sede</span>
                  {input("location_name", { maxLength: 120, placeholder: "Sede Centro" })}
                </label>
                <div className="grid gap-4 sm:grid-cols-[1fr_2fr]">
                  <label className="block">
                    <span className={labelClass}>Ciudad</span>
                    {input("city", { maxLength: 80, autoComplete: "address-level2", placeholder: "Medellín" })}
                  </label>
                  <label className="block">
                    <span className={labelClass}>Dirección</span>
                    {input("address", { maxLength: 300, autoComplete: "street-address", placeholder: "Calle 10 #40-20" })}
                  </label>
                </div>
              </fieldset>

              {error && <FormAlert id={errorId}>{error}</FormAlert>}

              <button type="submit" disabled={submitting} className={`${button.primary} w-full`}>
                {submitting && <LoaderCircle size={18} className="animate-spin motion-reduce:[animation-duration:6s]" aria-hidden />}
                {submitting ? "Creando tu negocio…" : "Crear mi negocio"}
              </button>
            </form>
          </div>
        ) : (
          <div role="alert" className="enter rounded-panel border border-line bg-surface p-7 [--i:1] sm:p-8">
            <h1 className="text-2xl font-semibold tracking-[-0.02em] text-balance">Esta invitación ya no sirve</h1>
            <p className="mt-1.5 text-[15px] text-muted text-pretty">
              El enlace no existe, ya se usó o venció (dura 24 horas). Pídele uno nuevo a quien te invitó a PractiMesa.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
