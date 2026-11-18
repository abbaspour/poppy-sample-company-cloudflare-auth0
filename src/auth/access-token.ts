import { type JWTVerifyGetKey, createRemoteJWKSet, customFetch, errors, jwtVerify } from "jose";

/** The account and scopes a validated access token grants (§4.5, §4.7). */
export interface Account {
  /** the account: the token's sub */
  sub: string;
  scopes: string[];
  /** the client the token was issued to */
  clientId: string;
}

export type TokenResult = { ok: true; account: Account } | { ok: false; description: string };

export interface AccessTokenOptions {
  /** the Company's issuer, compared character for character */
  issuer: string;
  /** the Company's default resource, https://{organization.domain} (§4.5) */
  audience: string;
  jwks: JWTVerifyGetKey;
  /** the Session JWT's iss: the token must have been issued to the same client (§5.3 step 3) */
  clientId: string;
}

/**
 * Validates an access token from the Company's issuer: signature, iss, aud, exp, and that it was
 * issued to the Personal Agent that signed the Session JWT. A copied token is then useless
 * without that agent's keys (§5.2).
 */
export async function validateAccessToken(token: string, opts: AccessTokenOptions): Promise<TokenResult> {
  let claims: Record<string, unknown>;
  try {
    ({ payload: claims } = await jwtVerify(token, opts.jwks, {
      issuer: opts.issuer,
      audience: opts.audience,
      algorithms: ["RS256", "PS256", "ES256"],
    }));
  } catch (e) {
    if (e instanceof errors.JWTExpired) return { ok: false, description: "the access token has expired" };
    if (e instanceof errors.JWTClaimValidationFailed) {
      return { ok: false, description: `the access token's ${e.claim} is wrong` };
    }
    return { ok: false, description: "the access token isn't valid" };
  }

  if (typeof claims.sub !== "string" || claims.sub === "") {
    return { ok: false, description: "the access token names no account" };
  }
  // RFC 9068 client_id, or OpenID Connect azp
  const clientId = typeof claims.client_id === "string" ? claims.client_id : claims.azp;
  if (typeof clientId !== "string") return { ok: false, description: "the access token names no client" };
  if (clientId !== opts.clientId) {
    return { ok: false, description: "the access token was issued to another client than the Session's" };
  }
  const scopes = typeof claims.scope === "string" ? claims.scope.split(" ").filter(Boolean) : [];
  return { ok: true, account: { sub: claims.sub, scopes, clientId } };
}

const jwksCache = new Map<string, JWTVerifyGetKey>();

/** The issuer's key set, from jwks_uri in its RFC 8414 metadata. Cached per isolate. */
export async function issuerJwks(issuer: string, fetchImpl: typeof fetch): Promise<JWTVerifyGetKey> {
  const cached = jwksCache.get(issuer);
  if (cached) return cached;
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/$/, "");
  const res = await fetchImpl(`${url.origin}/.well-known/oauth-authorization-server${path}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`issuer metadata returned HTTP ${res.status}`);
  const metadata = (await res.json()) as { jwks_uri?: string };
  if (!metadata.jwks_uri) throw new Error("issuer metadata has no jwks_uri");
  const jwks = createRemoteJWKSet(new URL(metadata.jwks_uri), { [customFetch]: fetchImpl });
  jwksCache.set(issuer, jwks);
  return jwks;
}
