# PractiMesa — contexto del proyecto para agentes

Archivo vivo: actualízalo cuando cambie una decisión, el estado de una fase o una regla. Es público (repo público): **nunca** pongas aquí secretos, credenciales ni datos personales.

## Qué es

SaaS vertical para restaurantes, cafeterías y dark kitchens en Colombia:
POS (mesas, comandas, caja con arqueo, inventario por recetas) + tienda web por subdominio (`{slug}.dominio`) + cobro QR con **Factus Pay** (Bre-B) + facturación electrónica con **Factus**. Base preparada para un agente de WhatsApp con IA (Fase 6).

Spec original: `docs/spec.md`. Las decisiones de abajo **mandan sobre la spec** cuando chocan.

## Stack y estructura

```
apps/api/   NestJS 12 (ESM-only, app compilada a CJS) + Prisma 7 + PostgreSQL 16   -> Railway
apps/web/   Next.js 16 App Router + Tailwind 4 (ver apps/web/AGENTS.md: APIs nuevas)  -> Vercel
docs/       spec.md (spec original)
.github/    CI: tests + SonarQube Cloud
```

- `apps/api/src/common/tenant/` — `TenantMiddleware`: tenant SOLO desde JWT firmado + DB, nunca desde headers de org del cliente. `x-location-id` se valida contra sedes permitidas.
- `apps/api/src/common/guards/plan.guard.ts` — límite de sedes (SINGLE = 1 siempre).
- `apps/api/src/generated/prisma/` — cliente generado (gitignored). Regenerar con `npm run db:generate -w apps/api`.
- `apps/api/prisma/schema.prisma` + `prisma/migrations/` — esquema. Cambios: editar schema y `npx prisma migrate dev --name <cambio>` en `apps/api`.

## Comandos

```bash
npm run db:up                          # Postgres Docker en localhost:5433 (5432 lo usa un Postgres local)
npm run dev:api | npm run dev:web      # API :4000 (/api/health), web :3000
npm test                               # Jest (necesita --experimental-vm-modules, ya en el script)
npm run test:cov -w apps/api           # lcov; umbral 80% en src/common
npm run factus:check -w apps/api       # verifica credenciales Factus + Factus Pay sin imprimir secretos
npm run sonar:up && npm run sonar:local  # SonarQube local :9000
```

## Reglas

- **Secretos**: solo en `apps/api/.env` (gitignored) o en secrets de GitHub/Railway/Vercel. `.env.example` lleva placeholders vacíos. Revisa el diff antes de cada commit. GitHub push protection está activo.
- **Commits**: identidad noreply de GitHub (ya configurada en el repo local). Conventional commits.
- **Multi-tenant**: toda consulta filtra por `organization_id` (y `location_id` cuando aplica). Ningún dato de una org puede leerse, editarse ni alterarse vía webhook desde otra.
- **Tests**: cada módulo nuevo trae sus tests en el mismo PR. El CI corre Jest + Quality Gate de SonarQube Cloud (`AlexNvdz_PractiMesa`); si falla, no se mergea.
- **CI**: acciones fijadas por SHA, `npm ci --ignore-scripts`, `SONAR_TOKEN` solo en el paso de scan.
- **Idioma**: UI y docs de negocio en español (es-CO, COP). Código, comentarios y commits en inglés.
- **Fases**: se trabaja fase por fase; no empezar la siguiente sin confirmación del usuario.

## Integraciones (verificado 2026-11-20 contra la documentación oficial)

**Factus (facturación)** — https://developers.factus.com.co
- Sandbox `https://api-sandbox.factus.com.co`, prod `https://api.factus.com.co`.
- OAuth2 `POST /oauth/token` (`grant_type=password` / `refresh_token`); leer `expires_in` en runtime (docs inconsistentes).
- Factura: `POST /v2/bills/validate` → `number`, `cufe`, `links.qr`. Rango sandbox **389 = Factura de Venta (SETP)**.
- **No existe documento equivalente POS** en Factus (solo tipo `01` factura electrónica de venta).
- Sin confirmar: si una cuenta de integrador puede emitir para varios NIT (preguntar a Factus).

**Factus Pay (recaudos QR Bre-B)** — https://pay-developers.factus.com.co
- Sandbox `https://pay-api-sandbox.factus.com.co` (también es el panel), prod `https://pay-api.factus.com.co`. Simulador: `/simulator`.
- Auth `POST /auth {email,password}` → token sin expiración; **cada `/auth` revoca el token anterior** (reautenticar solo ante 401, no en cada request).
- `POST /v1/collections {reference_code, amount, expiration}` → QR base64 PNG + `breb_key`; idempotente por `reference_code` (= `order.id`). Monto COP 1.000–12.100.000, pago exacto. `GET /v1/collections/:ref` → `ready` | `paid`.
- Webhook: se configura en el panel; solo se dispara al pasar a `paid`; **sin HMAC**: la clave llega en `?key=`. Comparar en tiempo constante (401 si no coincide) **y** confirmar con `GET /v1/collections/:ref` (estado y monto) antes de marcar `PAID`. Sin event id → deduplicar por `reference_code`. Hasta 6 reintentos.
- Sin reembolsos por API. Sin split. Cada comercio = cuenta propia con su NIT. Costo COP 800 + IVA por recaudo.

## Decisiones (planificación con grill-me)

| # | Decisión | Estado |
|---|---|---|
| Q1 | Objetivo: **demo comercial + portafolio** (no piloto real todavía) | ✅ |
| Q6 | Factura electrónica **solo si el cliente la solicita**; si la pide sin dar datos → consumidor final `222222222222` | ✅ |
| Q2 | Tests por módulo; staging en Railway temprano (tras auth en Fase 2); Fase 4 = auditoría + tests de aislamiento | ⏳ por confirmar |
| Q3 | Auth propia: email+password (argon2), JWT corto + refresh en cookie httpOnly; PIN para meseros | ⏳ |
| Q4 | Una sola app Next.js, ruteo por host (`app.` admin/POS, `{slug}.` tienda) | ⏳ |
| Q5 | Credenciales Factus/Factus Pay por organización (cifradas); sandbox comparte las del `.env` | ⏳ |
| Q7 | DINE_IN = cuenta abierta por mesa, pago y factura al cerrar; web PICKUP/DELIVERY paga antes | ⏳ |
| Q8 | DDL: `order_number` por sede, `organization_id` en `dining_tables`/`cash_registers`, email único global | ⏳ |
| Q9 | Aislamiento en dos capas: extensión Prisma + RLS Postgres en tablas críticas | ⏳ |
| Q10 | Dominio: pendiente saber si existe; si no, URL de Railway para staging | ⏳ |
| Q11 | Plan en `docs/PLAN.md` + GitHub Milestones por fase + Issues por tarea | ⏳ |

## Estado

- **Fase 1** ✅ entorno local, CI + SonarQube Cloud (Quality Gate OK), TenantMiddleware, PlanGuard, credenciales Factus/Factus Pay verificadas.
- **Planificación Fases 2–6** 🔄 en curso (tabla de arriba).
- Pendiente aparte: 21 alertas Dependabot en dependencias de desarrollo (jest, prisma CLI); `npm audit --omit=dev` = 0.
- Webhook de Factus Pay aún sin registrar en el panel (requiere URL HTTPS pública; la clave ya existe en el `.env` local).
