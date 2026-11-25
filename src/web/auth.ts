import { KVSessionStore, auth0 } from "@auth0/auth0-hono";
import type { MiddlewareHandler } from "hono";
import { type Env, companyOrigin, issuer } from "../env";

type Config = NonNullable<Parameters<typeof auth0>[0]>;

/**
 * The website logs in with the Company's API audience and its scopes. Agents get their tokens for
 * the same audience, so after a browser join the website's tokens carry what the user approved for
 * the agent. offline_access is for people's logins: a join gets no refresh token.
 */
export const LOGIN_SCOPE = "openid profile email offline_access orders:read orders:write";

/** Login needs the issuer, the application's credentials, and a key for the session. */
export function webAuthConfigured(env: Env): boolean {
  return Boolean(issuer(env) && env.AUTH0_CLIENT_ID && env.AUTH0_CLIENT_SECRET && env.AUTH0_SESSION_ENCRYPTION_KEY);
}

/** auth0-hono's configuration, built from the Worker's bindings. */
export function authConfig(env: Env): Config {
  return {
    // the issuer's host: the tenant's custom domain, so ID tokens carry the issuer Poppy needs
    domain: new URL(issuer(env) as string).host,
    clientID: env.AUTH0_CLIENT_ID,
    clientSecret: env.AUTH0_CLIENT_SECRET,
    baseURL: companyOrigin(env),
    // `/` is public: it tells who is visiting, and doesn't require anyone to be signed in
    authRequired: false,
    authorizationParams: { audience: env.AUTH0_AUDIENCE || companyOrigin(env), scope: LOGIN_SCOPE },
    session: {
      secret: env.AUTH0_SESSION_ENCRYPTION_KEY as string,
      // An ID token and an access token don't fit in a cookie, so sessions live in KV. Its keys
      // (sid-index:, sub-index:, ...) don't collide with the Poppy Sessions' in the same namespace.
      // (cast: KVNamespace's overloads don't satisfy auth0-hono's structural type)
      store: new KVSessionStore(env.SESSIONS as unknown as ConstructorParameters<typeof KVSessionStore>[0]),
    },
  };
}

// auth0() reads its configuration once, from the first request. One instance per configuration.
const middlewares = new Map<string, MiddlewareHandler>();

/**
 * auth0-hono's middleware: the /auth/login, /auth/callback and /auth/logout routes, and
 * `c.var.auth0` for the pages. It does nothing until login is configured.
 */
export const webAuth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (!webAuthConfigured(c.env)) return next();
  const key = [issuer(c.env), c.env.AUTH0_CLIENT_ID, companyOrigin(c.env)].join("|");
  let middleware = middlewares.get(key);
  if (!middleware) {
    middleware = auth0(authConfig(c.env));
    middlewares.set(key, middleware);
  }
  return middleware(c, next);
};
