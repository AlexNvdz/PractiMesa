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
