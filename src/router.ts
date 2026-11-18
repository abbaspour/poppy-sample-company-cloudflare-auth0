import type { JWTVerifyGetKey } from "jose";
import { type Account, issuerJwks, validateAccessToken } from "./auth/access-token";
import { insufficientScope, invalidToken, signInRequired } from "./auth/challenge";
import { type Env, companyId, companyOrigin, devAllowHttp, issuer } from "./env";
import { methodNotAllowed, notFound, poppyError } from "./http";
import { KvSessionStore } from "./session/store";
import { type VerifiedSession, verifySession } from "./session/verify";

/** What a handler gets: a verified Session, and the account when the request is signed in. */
export interface Context {
  request: Request;
  env: Env;
  session: VerifiedSession;
  store: KvSessionStore;
  /** the validated access token's account and scopes; null when signed out */
  account: Account | null;
  params: Record<string, string>;
}

export interface Route {
  method: string;
  /** path pattern; :name segments become params */
  path: string;
  /** the scope the request needs, which also means it needs the account; absent: signed out works */
  scope?: string;
  handler: (ctx: Context) => Response | Promise<Response>;
}

export interface Deps {
  fetch: typeof fetch;
  /** the issuer's key set; default: from its metadata's jwks_uri */
  jwks?: JWTVerifyGetKey;
}

function compile(path: string): RegExp {
  return new RegExp(`^${path.replace(/:(\w+)/g, "(?<$1>[A-Za-z0-9_-]+)")}$`);
}

/**
 * Runs an API request: verifies the Session header (§5.3), validates any access token and binds
 * the Session to its account (§5.4), checks the route's scope (§7), then calls the handler.
 */
export async function route(routes: Route[], request: Request, env: Env, path: string, deps: Deps): Promise<Response> {
  let matched: { route: Route; params: Record<string, string> } | undefined;
  const allowed: string[] = [];
  for (const r of routes) {
    const m = compile(r.path).exec(path);
    if (!m) continue;
    allowed.push(r.method);
    if (r.method === request.method) matched = { route: r, params: { ...m.groups } };
  }
  if (!matched) return allowed.length ? methodNotAllowed(allowed) : notFound();

  const store = new KvSessionStore(env.SESSIONS);
  const result = await verifySession(request, {
    companyId: companyId(env),
    store,
    fetch: deps.fetch,
    allowHttp: devAllowHttp(env),
  });
  if (!result.ok) return result.response;
  const session = result.session;

  let account: Account | null = null;
  if (session.accessToken) {
    const iss = issuer(env);
    if (!iss) return invalidToken("this Company offers no sign-in");
    const checked = await validateAccessToken(session.accessToken, {
      issuer: iss,
      audience: companyOrigin(env),
      jwks: deps.jwks ?? (await issuerJwks(iss, deps.fetch)),
      clientId: session.clientId,
    });
    if (!checked.ok) return invalidToken(checked.description);
    account = checked.account;

    // §5.4: a Session acts for one account; a request for another one gets session_ended
    if (session.record.account && session.record.account !== account.sub) {
      return poppyError("session_ended", "this Session was signed in to another account; start a new Session");
    }
    if (!session.record.account) {
      session.record.account = account.sub;
      await store.put(session.key, session.record);
    }
  }

  const scope = matched.route.scope;
  if (scope) {
    const metadata = `${companyOrigin(env)}/.well-known/oauth-protected-resource`;
    if (!account) return signInRequired([scope], metadata);
    if (!account.scopes.includes(scope)) return insufficientScope([scope]);
  }

  return matched.route.handler({ request, env, session, store, account, params: matched.params });
}
