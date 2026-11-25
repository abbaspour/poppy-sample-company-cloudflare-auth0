import { handleLogin } from "@auth0/auth0-hono";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { loadOrders } from "../api/orders";
import { cartSummary } from "../api/shop";
import { type Env, PROTOCOL_VERSION, companyOrigin, issuer } from "../env";
import { webAuth, webAuthConfigured } from "./auth";
import { type Visitor, classifyVisitor } from "./identity";
import { LoginInitiationError, parseLoginInitiation } from "./join";
import { renderCart, renderHome, renderMessage, renderOrders } from "./page";
import { STOPPED, type SessionLink, linkPoppySession } from "./poppy-session";

type AppContext = Context<{ Bindings: Env }>;

/** The website's pages, which see the session. The APIs and discovery documents never do. */
const PAGES = ["/", "/cart", "/orders"];

/** The login, which is also where an agent's browser join ends (Application Login URI). */
const login: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (!webAuthConfigured(c.env)) return next();
  let returnTo: string | undefined;
  try {
    ({ returnTo } = parseLoginInitiation(new URL(c.req.url), {
      issuer: issuer(c.env) as string,
      appOrigin: companyOrigin(c.env),
    }));
  } catch (error) {
    if (error instanceof LoginInitiationError) return c.text(error.message, 400);
    throw error;
  }
  return handleLogin({ redirectAfterLogin: returnTo })(c, next);
};

interface Visit {
  visitor: Visitor;
  link: SessionLink;
  /** why an agent's session isn't honored, if it was one */
  stopped?: string;
}

/**
 * Who is visiting, as the website acts on it. An agent's session is the agent's Session at the
 * Company too (§6), so it stops acting once the Company has ended that Session, or when the
 * Session is signed in to another account (§5.4). A person's session is the SDK's to expire.
 */
async function visit(c: AppContext): Promise<Visit> {
  const session = c.var.auth0?.session;
  // the access token for the Company's API carries the scopes the user approved for an agent
  const scope = session?.tokenSets?.find((t) => t.audience === (c.env.AUTH0_AUDIENCE || companyOrigin(c.env)))?.scope;
  const visitor = classifyVisitor(c.var.auth0?.user ?? null, { scope });
  const link = await linkPoppySession(c.env, visitor);
  if (link.status === "ended" || link.status === "account_mismatch") {
    return { visitor: { kind: "signed_out" }, link, stopped: STOPPED[link.status] };
  }
  return { visitor, link };
}

const PRIVATE_HTML = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
};

function html(c: AppContext, body: string, status: 200 | 401 | 403 = 200): Response {
  for (const [k, v] of Object.entries(PRIVATE_HTML)) c.header(k, v);
  return c.html(body, status);
}

/**
 * The website applies an agent's scopes, as the APIs do (§6): after a signed-in join it allows
 * nothing beyond what the user approved for the agent. A person's own login isn't limited.
 */
function lacksScope(v: Visitor, scope: string): boolean {
  return v.kind === "agent_for_user" && !v.scopes?.includes(scope);
}

/**
 * The website: Auth0 login, and the pages that tell who is visiting and show what they may see.
 * Everything else, the Poppy APIs and the discovery documents, goes to `rest`.
 */
export function createApp(rest: (request: Request, env: Env) => Promise<Response>, auth: MiddlewareHandler<{ Bindings: Env }> = webAuth) {
  const app = new Hono<{ Bindings: Env }>();
  const company = (c: AppContext) => c.env.COMPANY_NAME;

  for (const path of PAGES) app.use(path, auth);
  app.use("/auth/*", auth);

  app.get("/auth/login", login);

  app.get("/", async (c) => {
    const { visitor, link, stopped } = await visit(c);

    // Scripts and agents that don't ask for HTML get the Company's description, as before.
    if (!c.req.header("accept")?.includes("text/html")) {
      return c.json({
        name: c.env.COMPANY_NAME,
        poppy: "/.well-known/poppy.json",
        protocol_version: PROTOCOL_VERSION,
        visitor,
        poppy_session: { status: link.status },
      });
    }
    return html(c, renderHome(visitor, { companyName: company(c), loginEnabled: webAuthConfigured(c.env), notice: stopped }));
  });

  // The cart is the agent's Session's: the cart its API calls fill, for a guest or signed in.
  app.get("/cart", async (c) => {
    const { visitor, link, stopped } = await visit(c);
    if (visitor.kind !== "agent_guest" && visitor.kind !== "agent_for_user") {
      return html(
        c,
        renderMessage(visitor, {
          companyName: company(c),
          title: stopped ? "This Session has ended" : "No cart here",
          detail: stopped ?? "The cart belongs to an agent's Session. Join this browser to a Session to see it.",
        }),
        stopped ? 403 : 401,
      );
    }
    const cart = link.status === "active" ? cartSummary(link.record.sid, link.record.cart) : null;
    return html(c, renderCart(visitor, cart, { companyName: company(c) }));
  });

  // Orders are the account's: a person's, or the user's an agent acts for, within its scopes.
  app.get("/orders", async (c) => {
    const { visitor, stopped } = await visit(c);
    const deny = (title: string, detail: string, status: 401 | 403, scope?: string) =>
      html(c, renderMessage(visitor, { companyName: company(c), title, detail, scope }), status);

    if (stopped) return deny("This Session has ended", stopped, 403);
    if (visitor.kind === "agent_guest") {
      return deny("Orders need an account", "A guest has no account here. The agent signs the user in, then joins this browser again.", 403);
    }
    if (visitor.kind === "signed_out" || !visitor.subject) {
      return deny("Sign in to see orders", "Log in to see your orders.", 401);
    }
    if (lacksScope(visitor, "orders:read")) {
      // §6: say which scope is missing, so the agent can ask the user for it
      return deny("Missing scope: orders:read", "The user didn't approve this agent to see orders. It asks for the scope orders:read and joins again.", 403, "orders:read");
    }
    const orders = await loadOrders(c.env.SESSIONS, visitor.subject);
    return html(c, renderOrders(visitor, orders, { companyName: company(c) }));
  });

  app.all("*", (c) => rest(c.req.raw, c.env));
  return app;
}
