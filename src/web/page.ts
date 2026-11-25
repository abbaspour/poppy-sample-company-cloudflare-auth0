import type { AgentInfo, Visitor, VisitorKind } from "./identity";

const HEADLINES: Record<VisitorKind, { title: string; detail: string }> = {
  signed_out: { title: "You are signed out", detail: "Nobody is signed in to this browser." },
  user: { title: "You are signed in as a user", detail: "A person signed in with their own account." },
  agent_guest: {
    title: "An agent is browsing as a guest",
    detail: "A personal agent joined this browser to its Session signed out. It has no account here.",
  },
  agent_for_user: {
    title: "An agent is acting on behalf of a user",
    detail: "A personal agent joined this browser to its Session and is signed in as the user who approved it.",
  },
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function rows(entries: [string, string | undefined][]): string {
  return entries
    .filter((e): e is [string, string] => e[1] !== undefined)
    .map(([k, v]) => `<tr><th scope="row">${escapeHtml(k)}</th><td><code>${escapeHtml(v)}</code></td></tr>`)
    .join("\n");
}

function agentRows(agent: AgentInfo): [string, string | undefined][] {
  return [
    ["Agent", agent.id],
    ["Agent application", agent.clientId],
    ["Poppy Agent ID", agent.agentId],
    ["Poppy Session ID", agent.sessionId],
    ["Poppy User ID", agent.userId],
  ];
}

const STYLE = `
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; color: #1a1a1a; }
  h1 { font-size: 1.1rem; margin: 0 0 1rem; color: #555; font-weight: 600; }
  h2 { font-size: 1.6rem; margin: 0 0 .25rem; }
  nav { margin: 0 0 2rem; } nav a { margin-right: 1rem; }
  .status { padding: 1rem 1.25rem; border-radius: .5rem; background: #f3f4f6; border-left: .35rem solid #6b7280; }
  .status.user { border-color: #2563eb; } .status.agent_guest { border-color: #d97706; } .status.agent_for_user { border-color: #7c3aed; }
  .status.error { border-color: #dc2626; }
  table { border-collapse: collapse; margin: 1.5rem 0; width: 100%; }
  th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
  th { width: 11rem; font-weight: 600; color: #444; } code { word-break: break-all; }
  td.num, th.num { text-align: right; width: auto; }
  a { color: #2563eb; } .note { color: #666; }`;

/** What every page shares: the Company's name, the links its visitor can use, and the style. */
function layout(o: { companyName: string; visitor: Visitor; body: string }): string {
  const { kind } = o.visitor;
  const links = [`<a href="/">Home</a>`];
  if (kind === "agent_guest" || kind === "agent_for_user") links.push(`<a href="/cart">Cart</a>`);
  if (kind === "user" || kind === "agent_for_user") links.push(`<a href="/orders">Orders</a>`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(o.companyName)}</title>
<style>${STYLE}
</style>
</head>
<body>
<h1>${escapeHtml(o.companyName)}</h1>
<nav>${links.join("")}</nav>
${o.body}
</body>
</html>
`;
}

function money(amount: number, currency: string): string {
  return `${escapeHtml(currency)} ${amount.toFixed(2)}`;
}

/** The page at `/`. Every value that comes from a token is escaped. */
export function renderHome(
  visitor: Visitor,
  o: { companyName: string; loginEnabled: boolean; notice?: string },
): string {
  const { title, detail } = HEADLINES[visitor.kind];
  const details = rows([
    ["Subject", visitor.subject],
    ["Name", visitor.name],
    ["Email", visitor.email],
    ...(visitor.agent ? agentRows(visitor.agent) : []),
    ["Approved scopes", visitor.scopes ? (visitor.scopes.length ? visitor.scopes.join(" ") : "none") : undefined],
    ["Session ends", visitor.expiresAt ? new Date(visitor.expiresAt * 1000).toISOString() : undefined],
  ]);

  // A guest can't sign in from here: it signs in through its agent, which joins the browser again.
  let actions = "";
  if (visitor.kind === "signed_out") {
    actions = o.loginEnabled ? `<a href="/auth/login">Log in</a>` : `<span class="note">Login isn't configured on this server.</span>`;
  } else {
    actions = `<a href="/auth/logout">${visitor.kind === "user" ? "Log out" : "End this session"}</a>`;
  }

  return layout({
    companyName: o.companyName,
    visitor,
    body: `${o.notice ? `<div class="status error" role="alert"><p>${escapeHtml(o.notice)}</p></div>\n` : ""}<div class="status ${visitor.kind}" role="status" data-visitor-kind="${visitor.kind}">
  <h2>${escapeHtml(title)}</h2>
  <p>${escapeHtml(detail)}</p>
</div>
${details ? `<table>\n${details}\n</table>` : ""}
<p>${actions}</p>`,
  });
}

/** A page that says why the visitor can't see what they asked for. */
export function renderMessage(
  visitor: Visitor,
  o: { companyName: string; title: string; detail: string; scope?: string },
): string {
  return layout({
    companyName: o.companyName,
    visitor,
    body: `<div class="status error" role="alert"${o.scope ? ` data-missing-scope="${escapeHtml(o.scope)}"` : ""}>
  <h2>${escapeHtml(o.title)}</h2>
  <p>${escapeHtml(o.detail)}</p>
</div>`,
  });
}

interface CartSummary {
  sid: string;
  items: { sku: string; quantity: number; name?: string; line_total: number }[];
  total: number;
  currency: string;
}

/** The cart of the agent's Session: the one its API calls fill (§6). */
export function renderCart(visitor: Visitor, cart: CartSummary | null, o: { companyName: string }): string {
  const agent = visitor.agent;
  const table = !cart
    ? `<p class="note">The agent hasn't used the APIs in this Session yet, so there is no cart.</p>`
    : cart.items.length === 0
      ? `<p class="note">The cart is empty.</p>`
      : `<table>
<tr><th scope="col">Item</th><th scope="col" class="num">Quantity</th><th scope="col" class="num">Total</th></tr>
${cart.items
  .map(
    (i) =>
      `<tr><td>${escapeHtml(i.name ?? i.sku)} <code>${escapeHtml(i.sku)}</code></td><td class="num">${i.quantity}</td><td class="num">${money(i.line_total, cart.currency)}</td></tr>`,
  )
  .join("\n")}
<tr><th scope="row">Total</th><td></td><td class="num">${money(cart.total, cart.currency)}</td></tr>
</table>`;
  return layout({
    companyName: o.companyName,
    visitor,
    body: `<h2>Cart</h2>
<p class="note">Session <code>${escapeHtml(agent?.sessionId ?? "")}</code>${agent?.userId ? ` for User <code>${escapeHtml(agent.userId)}</code>` : ""}. The same cart the agent fills through the API.</p>
${table}`,
  });
}

interface OrderView {
  id: string;
  created_at: string;
  status: string;
  items: { name: string; quantity: number }[];
  total: number;
  currency: string;
  returns: { sku: string }[];
}

/** The account's orders. */
export function renderOrders(visitor: Visitor, orders: OrderView[], o: { companyName: string }): string {
  const list = orders.length
    ? `<table>
<tr><th scope="col">Order</th><th scope="col">Items</th><th scope="col">Status</th><th scope="col" class="num">Total</th></tr>
${orders
  .map(
    (r) =>
      `<tr><td><code>${escapeHtml(r.id)}</code><br><span class="note">${escapeHtml(r.created_at.slice(0, 10))}</span></td><td>${r.items.map((i) => `${i.quantity} × ${escapeHtml(i.name)}`).join("<br>")}</td><td>${escapeHtml(r.status)}${r.returns.length ? ` (${r.returns.length} return${r.returns.length > 1 ? "s" : ""})` : ""}</td><td class="num">${money(r.total, r.currency)}</td></tr>`,
  )
  .join("\n")}
</table>`
    : `<p class="note">No orders yet.</p>`;
  return layout({ companyName: o.companyName, visitor, body: `<h2>Orders</h2>\n${list}` });
}
