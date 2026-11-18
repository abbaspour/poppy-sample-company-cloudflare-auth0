import { type Env, companyOrigin, issuer } from "../env";
import { json, notFound } from "../http";
import { SCOPE_NAMES } from "../scopes";


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
    scopes_supported: SCOPE_NAMES,
  });
}
