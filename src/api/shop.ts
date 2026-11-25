import { json } from "../http";
import type { Context } from "../router";

export const PRODUCTS = [
  { sku: "tee-m", name: "Poppy T-shirt, medium", price: 25, currency: "USD" },
  { sku: "tee-l", name: "Poppy T-shirt, large", price: 25, currency: "USD" },
  { sku: "mug", name: "Poppy mug", price: 12, currency: "USD" },
  { sku: "stormline-insulated-m", name: "Stormline insulated jacket, medium", price: 190, currency: "USD" },
];

// responses depend on the Session, so shared caches must not reuse them
const PRIVATE = { "cache-control": "private, no-store" };

/** A Session's cart with names and totals. The website shows the same cart the API does. */
export function cartSummary(sid: string, cart: { sku: string; quantity: number }[]) {
  const items = cart.map((item) => {
    const product = PRODUCTS.find((p) => p.sku === item.sku);
    return { ...item, name: product?.name, line_total: (product?.price ?? 0) * item.quantity };
  });
  return { sid, items, total: items.reduce((sum, i) => sum + i.line_total, 0), currency: "USD" };
}

function cartView(ctx: Context) {
  return cartSummary(ctx.session.sid, ctx.session.record.cart);
}

/** GET /api/products */
export function listProducts(): Response {
  return json({ products: PRODUCTS }, 200, PRIVATE);
}

/** GET /api/cart */
export function getCart(ctx: Context): Response {
  return json(cartView(ctx), 200, PRIVATE);
}

/** DELETE /api/cart */
export async function emptyCart(ctx: Context): Promise<Response> {
  ctx.session.record.cart = [];
  await ctx.store.put(ctx.session.key, ctx.session.record);
  return json(cartView(ctx), 200, PRIVATE);
}

/** POST /api/cart/items {sku, quantity?} */
export async function addToCart(ctx: Context): Promise<Response> {
  let body: { sku?: unknown; quantity?: unknown };
  try {
    body = await ctx.request.json();
  } catch {
    return json({ error: "invalid_request", error_description: "body must be JSON" }, 400);
  }
  const quantity = body.quantity === undefined ? 1 : body.quantity;
  if (typeof body.sku !== "string" || !PRODUCTS.some((p) => p.sku === body.sku)) {
    return json({ error: "invalid_request", error_description: "unknown sku" }, 400);
  }
  if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
    return json({ error: "invalid_request", error_description: "quantity must be 1..99" }, 400);
  }
  const existing = ctx.session.record.cart.find((i) => i.sku === body.sku);
  if (existing) existing.quantity = Math.min(99, existing.quantity + quantity);
  else ctx.session.record.cart.push({ sku: body.sku, quantity });
  await ctx.store.put(ctx.session.key, ctx.session.record);
  return json(cartView(ctx), 201, PRIVATE);
}

/** GET /api/session: what the Company knows about this Session (for debugging) */
export function getSession(ctx: Context): Response {
  const r = ctx.session.record;
  return json(
    {
      client_id: r.client_id,
      sid: r.sid,
      sub: r.sub,
      agent_id: r.agent_id,
      new_session: ctx.session.isNew,
      signed_in: ctx.account !== null,
      account: r.account,
      scopes: ctx.account?.scopes ?? [],
      protocol_version: r.protocol_version,
      created_at: r.created_at,
      requests: r.requests,
    },
    200,
    PRIVATE,
  );
}

/**
 * DELETE /api/session (demo): the Company ends the Session, so its next request gets
 * session_ended and the agent has to start a new one (§5.5).
 */
export async function endSession(ctx: Context): Promise<Response> {
  ctx.session.record.ended = true;
  await ctx.store.put(ctx.session.key, ctx.session.record);
  return new Response(null, { status: 204 });
}
