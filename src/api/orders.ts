import { json } from "../http";
import { PRODUCTS } from "./shop";
import type { Context } from "../router";

/** A sample order history per account, stored in KV next to the Sessions. */
export interface Order {
  id: string;
  created_at: string;
  status: "placed" | "delivered";
  items: { sku: string; name: string; quantity: number; price: number }[];
  total: number;
  currency: "USD";
  returns: { id: string; sku: string; reason: string | null; created_at: string; status: "requested" }[];
}

const PRIVATE = { "cache-control": "private, no-store" };

function ordersKey(account: string): string {
  return `orders:${encodeURIComponent(account)}`;
}

function line(sku: string, quantity: number) {
  const p = PRODUCTS.find((x) => x.sku === sku)!;
  return { sku, name: p.name, quantity, price: p.price };
}

function order(id: string, created_at: string, status: Order["status"], items: Order["items"]): Order {
  return { id, created_at, status, items, total: items.reduce((s, i) => s + i.price * i.quantity, 0), currency: "USD", returns: [] };
}

/** Every new account starts with two delivered orders, so there is something to read and return. */
function seed(): Order[] {
  return [
    order("ord_1042", "2026-10-02T09:12:00Z", "delivered", [line("stormline-insulated-m", 1)]),
    order("ord_1043", "2026-10-21T17:40:00Z", "delivered", [line("tee-m", 2), line("mug", 1)]),
  ];
}

/** The account's orders, seeded on first use. Also used by the Company Agent (§8). */
export async function loadOrders(kv: KVNamespace, account: string): Promise<Order[]> {
  const stored = await kv.get<Order[]>(ordersKey(account), "json");
  return stored ?? seed();
}

function load(ctx: Context): Promise<Order[]> {
  return loadOrders(ctx.env.SESSIONS, ctx.account!.sub);
}

async function save(ctx: Context, orders: Order[]): Promise<void> {
  await ctx.env.SESSIONS.put(ordersKey(ctx.account!.sub), JSON.stringify(orders));
}

function invalid(description: string, status = 400): Response {
  return json({ error: "invalid_request", error_description: description }, status, PRIVATE);
}

function randomId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return prefix + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** GET /api/orders (orders:read) */
export async function listOrders(ctx: Context): Promise<Response> {
  const orders = await load(ctx);
  return json({ orders: orders.map(({ returns, ...o }) => ({ ...o, returns: returns.length })) }, 200, PRIVATE);
}

/** GET /api/orders/{id} (orders:read) */
export async function getOrder(ctx: Context): Promise<Response> {
  const found = (await load(ctx)).find((o) => o.id === ctx.params.id);
  return found ? json(found, 200, PRIVATE) : json({ error: "not_found" }, 404, PRIVATE);
}

/**
 * POST /api/orders (orders:write): places an order from the Session's cart. The cart was filled
 * signed out; checking it out needs the account, so the same Session continues signed in (§5.4).
 */
export async function checkout(ctx: Context): Promise<Response> {
  const cart = ctx.session.record.cart;
  if (cart.length === 0) return invalid("the Session's cart is empty");
  const orders = await load(ctx);
  const placed = order(randomId("ord_"), new Date().toISOString(), "placed", cart.map((i) => line(i.sku, i.quantity)));
  orders.unshift(placed);
  await save(ctx, orders);
  ctx.session.record.cart = [];
  await ctx.store.put(ctx.session.key, ctx.session.record);
  return json(placed, 201, PRIVATE);
}

/** POST /api/orders/{id}/returns (orders:write) {sku, reason?} */
export async function requestReturn(ctx: Context): Promise<Response> {
  let body: { sku?: unknown; reason?: unknown };
  try {
    body = await ctx.request.json();
  } catch {
    return invalid("body must be JSON");
  }
  const orders = await load(ctx);
  const found = orders.find((o) => o.id === ctx.params.id);
  if (!found) return json({ error: "not_found" }, 404, PRIVATE);
  if (found.status !== "delivered") return invalid("only delivered orders can be returned", 409);
  if (typeof body.sku !== "string" || !found.items.some((i) => i.sku === body.sku)) {
    return invalid("sku isn't in this order");
  }
  if (found.returns.some((r) => r.sku === body.sku)) return invalid("a return for this item was already requested", 409);
  const ret = {
    id: randomId("ret_"),
    sku: body.sku,
    reason: typeof body.reason === "string" ? body.reason.slice(0, 500) : null,
    created_at: new Date().toISOString(),
    status: "requested" as const,
  };
  found.returns.push(ret);
  await save(ctx, orders);
  return json(ret, 201, PRIVATE);
}
