# ESPECIFICACIÓN TÉCNICA Y PLAN DE TRABAJO: SAAS POS + TIENDA ONLINE (COLOMBIA)

## 1. CONTEXTO Y OBJETIVO DEL PROYECTO
Actúa como Arquitecto de Software Senior y Tech Lead Full-Stack. Vamos a construir un SaaS vertical para restaurantes, cafeterías y *dark kitchens* en Colombia que fusiona:
1. **Operación en local (estilo Fudo):** POS, gestión de mesas/comandas, apertura/cierre de caja con arqueo, e inventario por recetas/escandallos.
2. **Pedidos directos al consumidor (estilo Weevi):** Tienda web *mobile-first* por subdominio (`slug.tudominio.com`), modificadores de platos, disponibilidad en tiempo real, zonas de domicilio en mapa, pedidos programados y cupones.
3. **Pagos y Facturación Electrónica Colombia (Factus + Factus Pay):** Cobros digitales mediante **QR dinámico de Factus Pay** confirmados vía **Webhook**, y emisión de **Facturación Electrónica / Documento Equivalente POS** mediante la **API Sandbox de Factus** (sin depender de datáfonos físicos).
4. **Preparado para Fudo AI (Fases finales):** La base de datos y los servicios de pedidos/reservas deben quedar listos para conectar en versiones futuras un agente de WhatsApp Business + IA que tome pedidos, agende reservas y analice métricas financieras.

---

## 2. STACK TECNOLÓGICO, QA Y DESPLIEGUE
- **Frontend:** Next.js (App Router) + TypeScript + Tailwind CSS (desplegado en **Vercel** con soporte de subdominios wildcard `*.tudominio.com`).
- **Backend:** Node.js + TypeScript (NestJS o Express/Fastify modular) desplegado en **Railway**.
- **Base de Datos:** PostgreSQL 16 (en **Railway** para prod, Docker en local) con aislamiento multi-tenant estricto.
- **Almacenamiento de Imágenes:** **Cloudflare R2** (fotos de productos y logos de restaurantes).
- **Seguridad Perimetral y DNS:** **Cloudflare** (DNS Wildcard, SSL Full Strict, WAF, Rate Limiting en login/checkout/webhooks).
- **Calidad y Seguridad de Código (CI/Local):** **Jest** (pruebas unitarias y de integración) + **SonarQube** (análisis estático, vulnerabilidades OWASP y *Quality Gate* obligatorio).

---

## 3. ARQUITECTURA MULTI-TENANT Y MODELO DE 2 PLANES
Usaremos **Base de Datos Compartida con `organization_id` y `location_id` obligatorios en todas las consultas** (y Row-Level Security / middleware de contexto de tenant).

### Planes de Suscripción
1. **Plan Pequeño (`plan_tier = 'SINGLE'`):**
   - `max_locations = 1`.
   - 1 caja/terminal activa, tienda web directa (`slug.tudominio.com`), inventario básico, QR Factus Pay y facturación Factus.
   - La UI oculta selectores de sede y reportes consolidados, pero internamente guarda siempre `location_id` para permitir ascenso inmediato sin migrar datos.
2. **Plan Multilocal (`plan_tier = 'MULTI'`):**
   - `max_locations > 1` (escalable por sede).
   - Catálogo maestro a nivel `organization_id` con sobrescritura de precios y disponibilidad por sede (`location_products`), inventario independiente por sede (`location_stock`), zonas de domicilio por sede, roles granulares y reportes consolidados.

---

## 4. ESQUEMA DE BASE DE DATOS POSTGRESQL (DDL INICIAL)
Implementa este esquema base mediante migraciones (Prisma o Drizzle/Knex):

```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. ORGANIZACIONES Y PLANES
CREATE TABLE organizations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(150) NOT NULL,
    slug VARCHAR(80) UNIQUE NOT NULL,
    nit VARCHAR(30),
    plan_tier VARCHAR(20) NOT NULL CHECK (plan_tier IN ('SINGLE', 'MULTI')),
    max_locations INT NOT NULL DEFAULT 1,
    subscription_status VARCHAR(20) NOT NULL DEFAULT 'TRIAL',
    factus_config JSONB NOT NULL DEFAULT '{"sandbox": true, "client_id": null, "numbering_range_id": null}',
    ai_agent_enabled BOOLEAN NOT NULL DEFAULT FALSE, -- Reservado para módulo WhatsApp AI v3
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. SEDES / LOCALES
CREATE TABLE locations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name VARCHAR(120) NOT NULL,
    city VARCHAR(80) NOT NULL,
    address TEXT NOT NULL,
    phone_whatsapp VARCHAR(30),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    delivery_config JSONB NOT NULL DEFAULT '{"enabled": true, "min_order_cop": 15000, "zones": []}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. USUARIOS Y ROLES
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email VARCHAR(150) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    full_name VARCHAR(120) NOT NULL,
    role VARCHAR(30) NOT NULL CHECK (role IN ('OWNER', 'ADMIN', 'CASHIER', 'WAITER', 'KITCHEN')),
    allowed_location_ids UUID[] DEFAULT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. CATÁLOGO Y DISPONIBILIDAD POR SEDE
CREATE TABLE categories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    sort_order INT NOT NULL DEFAULT 0
);

CREATE TABLE products (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
    name VARCHAR(150) NOT NULL,
    description TEXT,
    base_price_cop NUMERIC(12, 2) NOT NULL,
    tax_rate NUMERIC(5, 2) NOT NULL DEFAULT 8.00, -- Impoconsumo 8% / IVA 19%
    dian_standard_code VARCHAR(30) DEFAULT '999',
    image_url TEXT,
    modifiers_schema JSONB NOT NULL DEFAULT '[]',
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE location_products (
    location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    custom_price_cop NUMERIC(12, 2),
    is_available BOOLEAN NOT NULL DEFAULT TRUE,
    PRIMARY KEY (location_id, product_id)
);

-- 5. INVENTARIO Y RECETAS
CREATE TABLE ingredients (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name VARCHAR(120) NOT NULL,
    unit VARCHAR(20) NOT NULL -- 'gr', 'ml', 'und'
);

CREATE TABLE location_stock (
    location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    ingredient_id UUID NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
    current_qty NUMERIC(12, 3) NOT NULL DEFAULT 0,
    min_alert_qty NUMERIC(12, 3) NOT NULL DEFAULT 0,
    PRIMARY KEY (location_id, ingredient_id)
);

CREATE TABLE product_recipes (
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    ingredient_id UUID NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
    quantity_required NUMERIC(12, 3) NOT NULL,
    PRIMARY KEY (product_id, ingredient_id)
);

-- 6. MESAS, CAJAS, CLIENTES Y PEDIDOS
CREATE TABLE dining_tables (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    name VARCHAR(40) NOT NULL,
    capacity INT NOT NULL DEFAULT 4,
    status VARCHAR(20) NOT NULL DEFAULT 'FREE' CHECK (status IN ('FREE', 'OCCUPIED', 'RESERVED'))
);

CREATE TABLE cash_registers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    opened_by UUID NOT NULL REFERENCES users(id),
    opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at TIMESTAMPTZ,
    opening_amount_cop NUMERIC(12, 2) NOT NULL,
    expected_closing_cop NUMERIC(12, 2),
    actual_closing_cop NUMERIC(12, 2),
    status VARCHAR(20) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED'))
);

CREATE TABLE customers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    full_name VARCHAR(120) NOT NULL,
    identification_type VARCHAR(10) DEFAULT '13', -- 13: Cédula, 31: NIT (para Factus DIAN)
    identification_number VARCHAR(30) DEFAULT '222222222222', -- Consumidor final por defecto
    phone VARCHAR(30) NOT NULL,
    email VARCHAR(150),
    loyalty_points INT NOT NULL DEFAULT 0,
    UNIQUE (organization_id, phone)
);

CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    cash_register_id UUID REFERENCES cash_registers(id),
    table_id UUID REFERENCES dining_tables(id),
    customer_id UUID REFERENCES customers(id),
    order_number SERIAL,
    channel VARCHAR(20) NOT NULL CHECK (channel IN ('POS', 'WEB_STORE', 'WHATSAPP_AI')),
    order_type VARCHAR(20) NOT NULL CHECK (order_type IN ('DINE_IN', 'PICKUP', 'DELIVERY')),
    status VARCHAR(25) NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY', 'COMPLETED', 'CANCELLED')),
    subtotal_cop NUMERIC(12, 2) NOT NULL,
    tax_cop NUMERIC(12, 2) NOT NULL,
    delivery_fee_cop NUMERIC(12, 2) NOT NULL DEFAULT 0,
    discount_cop NUMERIC(12, 2) NOT NULL DEFAULT 0,
    total_cop NUMERIC(12, 2) NOT NULL,
    payment_method VARCHAR(30) CHECK (payment_method IN ('CASH', 'FACTUS_PAY_QR', 'MANUAL_TRANSFER')),
    payment_status VARCHAR(20) NOT NULL DEFAULT 'UNPAID' CHECK (payment_status IN ('UNPAID', 'PENDING_QR', 'PAID', 'REFUNDED')),
    factus_payment_ref VARCHAR(120), -- ID/Referencia de transacción QR Factus Pay
    factus_qr_payload TEXT, -- URL o string QR generado por Factus Pay
    factus_invoice_number VARCHAR(50), -- Número de factura electrónica / doc equivalente emitido
    factus_cufe TEXT, -- CUFE/CUDE devuelto por Factus Sandbox
    factus_status VARCHAR(25) NOT NULL DEFAULT 'NOT_SENT' CHECK (factus_status IN ('NOT_SENT', 'PENDING', 'VALIDATED', 'ERROR')),
    delivery_address JSONB,
    scheduled_for TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE order_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id),
    quantity INT NOT NULL CHECK (quantity > 0),
    unit_price_cop NUMERIC(12, 2) NOT NULL,
    selected_modifiers JSONB NOT NULL DEFAULT '[]',
    notes TEXT
);

-- 7. RESERVAS (Base lista para Fudo AI en versión final)
CREATE TABLE reservations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    customer_id UUID REFERENCES customers(id),
    table_id UUID REFERENCES dining_tables(id),
    party_size INT NOT NULL,
    reserved_at TIMESTAMPTZ NOT NULL,
    source VARCHAR(20) NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL', 'WEB', 'WHATSAPP_AI')),
    status VARCHAR(20) NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN ('CONFIRMED', 'SEATED', 'CANCELLED', 'NO_SHOW'))
);

-- 8. LOG DE WEBHOOKS (Idempotencia y auditoría para Factus Pay)
CREATE TABLE webhook_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    provider VARCHAR(40) NOT NULL, -- 'FACTUS_PAY'
    external_event_id VARCHAR(150) UNIQUE NOT NULL,
    payload JSONB NOT NULL,
    processed BOOLEAN NOT NULL DEFAULT FALSE,
    processed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_orders_org_loc_date ON orders(organization_id, location_id, created_at DESC);
CREATE INDEX idx_orders_factus_ref ON orders(factus_payment_ref);

## 5. INTEGRACIÓN FACTUS SANDBOX Y FACTUS PAY (QR + WEBHOOK)
Crea un módulo desacoplado src/modules/factus/ con dos servicios principales:

FactusAuthService:

Autenticación OAuth2 contra la API Sandbox de Factus (grant_type: password o refresh_token), cacheando el access_token en memoria/Redis y renovándolo automáticamente antes de expirar.

FactusPayService (Cobros por QR):

Al crear un pedido (en POS o Tienda Web) con payment_method = 'FACTUS_PAY_QR', solicita a Factus Pay la generación del QR dinámico asociado al order.id y total_cop.

Guarda factus_payment_ref y factus_qr_payload, pasando el pedido a payment_status = 'PENDING_QR' para mostrar el QR en pantalla al cliente.

Endpoint Webhook (POST /api/webhooks/factus-pay):

Verifica la firma/secreto del webhook enviado por Factus Pay (rechazar con 401 si no coincide).

Valida idempotencia insertando en webhook_events (external_event_id único) para evitar procesar dos veces el mismo pago.

Cuando el evento confirma pago aprobado: dentro de una transacción SQL, actualiza payment_status = 'PAID', cambia status = 'CONFIRMED', descuenta el inventario por receta (location_stock) y dispara de forma asíncrona la emisión del documento electrónico si el cliente solicitó factura.

FactusInvoicingService (Facturación Electrónica / Documento Equivalente):

Mapea los order_items, impuestos (Impoconsumo/IVA) y datos del customer (o 222222222222 Consumidor Final) al payload requerido por el endpoint de facturas/documentos de Factus Sandbox.

Guarda factus_invoice_number, factus_cufe y factus_status = 'VALIDATED' en la orden.

6. PLAN DE TRABAJO POR FASES (EJECUCIÓN PASO A PASO)
Fase 1: Entorno Local, Docker, Jest y SonarQube
Genera el docker-compose.yml local con:

postgres:16-alpine (puerto 5432)

sonarqube:lts-community (puerto 9000)

Inicializa el proyecto Backend (TypeScript) y Frontend (Next.js).

Configura jest.config.ts con reporte lcov y sonar-project.properties apuntando a http://localhost:9000.

Implementa el TenantMiddleware y PlanGuard (que bloquee crear >1 sede si plan_tier === 'SINGLE').

Fase 2: Núcleo POS + Inventario + Factus Sandbox
Implementa CRUD de categorías, productos con modificadores, ingredientes y recetas.

Implementa apertura/cierre de caja (cash_registers) y gestión de mesas.

Implementa creación de órdenes en POS con pago en Efectivo o QR Factus Pay + el webhook idempotente de Factus Pay + emisión de factura en Factus Sandbox.

Fase 3: Tienda Online Directa (Weevi) + Lógica Multilocal
Crea el storefront público dinámico por subdominio ([slug].tudominio.com) con carrito, modificadores, zonas de domicilio (delivery_config), pedidos programados y pago por QR Factus Pay.

Implementa las vistas y endpoints exclusivos de plan_tier = 'MULTI' (location_products para precios/stock por sede y reporte consolidado).

Fase 4: Suite de Pruebas de Seguridad y Calidad (Antes de Desplegar)
Escribe y ejecuta en Jest + SonarQube:

Test de aislamiento multi-tenant: Verificar que un usuario de Org A nunca pueda leer, editar ni recibir webhooks que alteren datos de Org B.

Test de límites de plan: Verificar bloqueo de 2da sede en SINGLE y habilitación en MULTI.

Test de webhook Factus Pay: Simular firma inválida (401), pago aprobado (200 + descuento de stock + transición de estado) y reenvío duplicado del mismo evento (idempotencia).

Auditoría SonarQube local: Correr npm test -- --coverage y sonar-scanner, asegurando 0 vulnerabilidades, 0 security hotspots sin revisar y >= 80% de cobertura en servicios críticos.

Fase 5: Despliegue Inicial (Railway + Vercel + Cloudflare)
Despliega PostgreSQL y Backend en Railway con variables de entorno del Sandbox de Factus.

Despliega Frontend en Vercel configurando dominios wildcard (*.tudominio.com).

Configura Cloudflare:

DNS con proxy naranja activo + registro CNAME * hacia Vercel.

SSL/TLS en modo Full (Strict).

WAF administrado + Rate Limiting en /api/auth/*, /api/public/orders y /api/webhooks/factus-pay (permitiendo IPs/firmas válidas).

Fase 6: Módulo Final (Post-MVP — Fudo AI en WhatsApp)
Conectar WhatsApp Cloud API + LLM con Tool Calling usando los mismos servicios internos (OrderService con channel = 'WHATSAPP_AI' y ReservationService con source = 'WHATSAPP_AI'), más consultas de métricas financieras por chat.

INSTRUCCIÓN DE INICIO PARA CLAUDE
Comienza ejecutando la Fase 1:

Entrégame la estructura de carpetas recomendada del monorepo (apps/api, apps/web).

Genera el docker-compose.yml para PostgreSQL + SonarQube local.

Genera sonar-project.properties, jest.config.ts y la configuración inicial de variables de entorno (.env.example) incluyendo las credenciales de Factus Sandbox y Factus Pay.

Espera mi confirmación antes de pasar a la Fase 2.