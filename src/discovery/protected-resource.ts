import { type Env, browserSessionEndpoint, companyOrigin, issuer } from "../env";
import { json, notFound } from "../http";
import { BROWSER_SIGN_IN, SCOPE_NAMES } from "../scopes";


/**
 * GET /.well-known/oauth-protected-resource (RFC 9728, §3.2). Its resource is exactly
 * https://{organization.domain}, and authorization_servers names the issuer. A Company without
 * an issuer answers 404, which tells Personal Agents it offers signed-out Sessions only.
 */
export function protectedResource(env: Env): Response {
  const iss = issuer(env);
  if (!iss) return notFound();
  return json({
    resource: companyOrigin(env),
    authorization_servers: [iss],
    scopes_supported: browserSessionEndpoint(env) ? [...SCOPE_NAMES, BROWSER_SIGN_IN.name] : SCOPE_NAMES,
  });
}
