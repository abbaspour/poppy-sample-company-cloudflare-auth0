/**
 * Access token errors follow OAuth: they go in WWW-Authenticate (RFC 6750 §3), not in a Poppy
 * JSON error, so OAuth libraries handle them as they would anywhere (§7).
 */

function quote(value: string): string {
  return `"${value.replace(/["\\]/g, "")}"`;
}

function challenge(status: number, params: Record<string, string>): Response {
  const header = `Bearer ${Object.entries(params)
    .map(([k, v]) => `${k}=${quote(v)}`)
    .join(", ")}`;
  return new Response(null, { status, headers: { "www-authenticate": header, "cache-control": "no-store" } });
}

/** 401 without an error code: the request needs the User's account, with these scopes (§7). */
export function signInRequired(scopes: string[], resourceMetadata: string): Response {
  return challenge(401, { scope: scopes.join(" "), resource_metadata: resourceMetadata });
}

/** 401 invalid_token: expired, revoked or otherwise invalid. The agent refreshes it (§7). */
export function invalidToken(description: string): Response {
  return challenge(401, { error: "invalid_token", error_description: description });
}

/** 403 insufficient_scope, naming the scopes the request needs (§7). */
export function insufficientScope(scopes: string[]): Response {
  return challenge(403, { error: "insufficient_scope", scope: scopes.join(" ") });
}
