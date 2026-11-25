import { Hono } from "hono";
import { type Env, PROTOCOL_VERSION } from "../env";
import { webAuth, webAuthConfigured } from "./auth";
import { classifyVisitor } from "./identity";
import { renderHome } from "./page";

/**
 * The website: Auth0 login, and the page at `/` that tells who is visiting. Everything else, the
 * Poppy APIs and the discovery documents, goes to `rest`.
 */
export function createApp(rest: (request: Request, env: Env) => Promise<Response>) {
  const app = new Hono<{ Bindings: Env }>();

  // Only the website's paths see the session: the APIs and discovery documents never do.
  app.use("/", webAuth);
  app.use("/auth/*", webAuth);

  app.get("/", (c) => {
    const visitor = classifyVisitor(c.var.auth0?.user ?? null);

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
