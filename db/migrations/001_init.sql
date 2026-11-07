CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role          text NOT NULL DEFAULT 'customer' CHECK (role IN ('customer', 'admin')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku         text NOT NULL UNIQUE,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  stock       integer NOT NULL DEFAULT 0 CHECK (stock >= 0),
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX products_catalog_idx ON products (created_at DESC, id) WHERE active;

CREATE TABLE orders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users (id),
  status            text NOT NULL CHECK (status IN ('pending', 'paid', 'shipped', 'delivered', 'cancelled')),
  total_cents       integer NOT NULL CHECK (total_cents >= 0),
  currency          text NOT NULL DEFAULT 'usd',
  payment_provider  text,
  payment_reference text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  paid_at           timestamptz,
  shipped_at        timestamptz,
  delivered_at      timestamptz,
  cancelled_at      timestamptz
);

CREATE INDEX orders_user_idx ON orders (user_id, created_at DESC);
CREATE INDEX orders_pending_idx ON orders (created_at) WHERE status = 'pending';
CREATE UNIQUE INDEX orders_payment_ref_idx
  ON orders (payment_provider, payment_reference)
  WHERE payment_reference IS NOT NULL;

-- Name, SKU and price are copied here so that later catalog edits never change past orders.
CREATE TABLE order_items (
  order_id         uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  product_id       uuid NOT NULL REFERENCES products (id),
  sku              text NOT NULL,
  name             text NOT NULL,
  unit_price_cents integer NOT NULL CHECK (unit_price_cents >= 0),
  quantity         integer NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (order_id, product_id)
);

-- Append-only audit trail of every stock change.
CREATE TABLE inventory_movements (
  id         bigserial PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES products (id),
  delta      integer NOT NULL CHECK (delta <> 0),
  reason     text NOT NULL CHECK (reason IN ('initial', 'admin_adjustment', 'order_reserved', 'order_cancelled')),
  order_id   uuid REFERENCES orders (id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX inventory_movements_product_idx ON inventory_movements (product_id, created_at DESC);

-- Webhook deliveries already processed, so retries from the payment provider are harmless.
CREATE TABLE payment_events (
  provider    text NOT NULL,
  event_id    text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);
