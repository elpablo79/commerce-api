/**
 * Creates the schema, two demo accounts and a small catalogue. Safe to run again:
 * existing products keep their current stock.
 */
import bcrypt from "bcryptjs";
import { loadConfig } from "../src/config";
import { createPool, migrate } from "../src/db";

const config = loadConfig();
if (config.env === "production") {
  throw new Error("Refusing to seed demo accounts and data in production");
}

const PRODUCTS: [sku: string, name: string, description: string, priceCents: number, stock: number][] = [
  ["KB-MECH-01", "Mechanical Keyboard", "75% layout, hot-swappable switches, USB-C.", 8900, 40],
  ["MS-ERGO-01", "Ergonomic Mouse", "Vertical grip, 4000 DPI, rechargeable.", 4900, 60],
  ["MN-27-4K", "27-inch 4K Monitor", "IPS panel, 60 Hz, USB-C with 65 W power delivery.", 32900, 15],
  ["HP-NC-01", "Noise-Cancelling Headphones", "Bluetooth 5.3, 30 hours of battery life.", 17900, 25],
  ["WC-1080", "1080p Webcam", "Wide angle, built-in microphone, privacy shutter.", 5900, 50],
  ["HUB-7IN1", "USB-C Hub 7-in-1", "HDMI, 2x USB-A, SD, microSD, Ethernet, 100 W pass-through.", 4500, 80],
  ["SSD-1TB", "Portable SSD 1 TB", "USB 3.2 Gen 2, up to 1050 MB/s.", 8900, 35],
  ["DESK-MAT", "Desk Mat XL", "900 x 400 mm, stitched edges, non-slip base.", 2500, 100],
  ["LAMP-LED", "LED Desk Lamp", "Adjustable colour temperature, USB charging port.", 3900, 45],
  ["CHAIR-ERGO", "Ergonomic Office Chair", "Lumbar support, adjustable armrests, mesh back.", 24900, 8],
  ["STAND-LAP", "Aluminium Laptop Stand", "Foldable, fits 11 to 17 inch laptops.", 3500, 70],
  ["CABLE-USBC", "USB-C Cable 2 m", "100 W charging, 10 Gbps data.", 1500, 200],
];

const pool = createPool(config.databaseUrl);
try {
  await migrate(pool);

  const password = process.env.SEED_PASSWORD ?? "demo-password-123";
  const hash = await bcrypt.hash(password, config.bcryptRounds);
  for (const [email, role] of [
    ["admin@example.com", "admin"],
    ["customer@example.com", "customer"],
  ]) {
    await pool.query(
      `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role`,
      [email, hash, role],
    );
  }

  let added = 0;
  for (const [sku, name, description, priceCents, stock] of PRODUCTS) {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO products (sku, name, description, price_cents, stock)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (sku) DO NOTHING RETURNING id`,
      [sku, name, description, priceCents, stock],
    );
    if (res.rows[0]) {
      added++;
      await pool.query(
        "INSERT INTO inventory_movements (product_id, delta, reason) VALUES ($1, $2, 'initial')",
        [res.rows[0].id, stock],
      );
    }
  }
  console.log(`Seed complete: ${added} new products, accounts admin@example.com and customer@example.com.`);
  console.log(`Password for both: ${password}`);
} finally {
  await pool.end();
}
