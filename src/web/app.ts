import { handleLogin } from "@auth0/auth0-hono";
import { Hono, type MiddlewareHandler } from "hono";
import { type Env, PROTOCOL_VERSION, companyOrigin, issuer } from "../env";
import { webAuth, webAuthConfigured } from "./auth";
import { classifyVisitor } from "./identity";
import { LoginInitiationError, parseLoginInitiation } from "./join";
import { renderHome } from "./page";

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

/**
 * The website: Auth0 login, and the page at `/` that tells who is visiting. Everything else, the
 * Poppy APIs and the discovery documents, goes to `rest`.
 */
export function createApp(rest: (request: Request, env: Env) => Promise<Response>) {
  const app = new Hono<{ Bindings: Env }>();

  // Only the website's paths see the session: the APIs and discovery documents never do.
  app.use("/", webAuth);
  app.use("/auth/*", webAuth);

  app.get("/auth/login", login);

  app.get("/", (c) => {
    const session = c.var.auth0?.session;
    // the access token for the Company's API carries the scopes the user approved for an agent
    const scope = session?.tokenSets?.find((t) => t.audience === (c.env.AUTH0_AUDIENCE || companyOrigin(c.env)))?.scope;
    const visitor = classifyVisitor(c.var.auth0?.user ?? null, { scope });

    // Scripts and agents that don't ask for HTML get the Company's description, as before.
    if (!c.req.header("accept")?.includes("text/html")) {
      return c.json({
        name: c.env.COMPANY_NAME,
        poppy: "/.well-known/poppy.json",
        protocol_version: PROTOCOL_VERSION,
        visitor,
      });
    }

    c.header("cache-control", "no-store");
    c.header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
    c.header("x-content-type-options", "nosniff");
    return c.html(renderHome(visitor, { companyName: c.env.COMPANY_NAME, loginEnabled: webAuthConfigured(c.env) }));
  });

  app.all("*", (c) => rest(c.req.raw, c.env));
  return app;
}
