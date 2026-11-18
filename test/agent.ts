import { type JWK, SignJWT, base64url, calculateJwkThumbprint, exportJWK, generateKeyPair } from "jose";

/**
 * A minimal Personal Agent for tests: a CIMD document, a jwks_uri key, delegations and Session
 * JWTs built as Poppy §4.1 and §5.2 describe. Each knob lets a test break one rule.
 */
export const CLIENT_ID = "https://agent.example/cimd.json";
export const JWKS_URI = "https://agent.example/jwks.json";
export const COMPANY_ID = "https://shop.example";

export interface Agent {
  rootPrivate: CryptoKey;
  rootJwk: JWK;
  fetch: typeof fetch;
}

export async function makeAgent(): Promise<Agent> {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const pub = await exportJWK(publicKey);
  const rootJwk = { ...pub, kid: await calculateJwkThumbprint(pub), alg: "ES256", use: "sig" };
  const docs: Record<string, unknown> = {
    [CLIENT_ID]: { client_id: CLIENT_ID, client_name: "test agent", jwks_uri: JWKS_URI, redirect_uris: [] },
    [JWKS_URI]: { keys: [rootJwk] },
  };
  const fakeFetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    const doc = docs[url];
    return doc ? Response.json(doc) : new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { rootPrivate: privateKey, rootJwk, fetch: fakeFetch };
}

export interface DelegatedKey {
  privateKey: CryptoKey;
  jwk: JWK;
  thumbprint: string;
  delegation: string;
}

export async function delegate(
  agent: Agent,
  opts: { iat?: number; exp?: number; typ?: string; iss?: string; kid?: string } = {},
): Promise<DelegatedKey> {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  const now = Math.floor(Date.now() / 1000);
  const delegation = await new SignJWT({ cnf: { jwk } })
    .setProtectedHeader({ alg: "ES256", typ: opts.typ ?? "poppy-delegation+jwt", kid: opts.kid ?? agent.rootJwk.kid })
    .setIssuer(opts.iss ?? CLIENT_ID)
    .setIssuedAt(opts.iat ?? now)
    .setExpirationTime(opts.exp ?? now + 3600)
    .setJti(crypto.randomUUID())
    .sign(agent.rootPrivate);
  return { privateKey, jwk, thumbprint: await calculateJwkThumbprint(jwk), delegation };
}

export interface SessionJwtOptions {
  method: string;
  url: string;
  sid?: string;
  sub?: string;
  agentId?: string;
  aud?: string;
  accessToken?: string;
  ath?: string;
  iat?: number;
  typ?: string;
  kid?: string;
  noDelegation?: boolean;
  signWith?: CryptoKey;
}

export async function sessionJwt(key: DelegatedKey, o: SessionJwtOptions): Promise<string> {
  const claims: Record<string, unknown> = {
    sid: o.sid ?? "Yx2b7Qd_Kp8mR3vT1nWc4A",
    sub: o.sub ?? "usr_Q7c1vK",
    htm: o.method,
    htu: o.url.split(/[?#]/)[0],
    jti: crypto.randomUUID(),
  };
  if (o.agentId) claims.agent_id = o.agentId;
  if (o.ath) claims.ath = o.ath;
  else if (o.accessToken) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(o.accessToken));
    claims.ath = base64url.encode(new Uint8Array(digest));
  }
  const header: Record<string, unknown> = { typ: o.typ ?? "poppy-session+jwt", alg: "ES256", kid: o.kid ?? key.thumbprint };
  if (!o.noDelegation) header.poppy_dlg = key.delegation;
  return new SignJWT(claims)
    .setProtectedHeader(header as { alg: string })
    .setIssuer(CLIENT_ID)
    .setAudience(o.aud ?? COMPANY_ID)
    .setIssuedAt(o.iat ?? Math.floor(Date.now() / 1000))
    .sign(o.signWith ?? key.privateKey);
}

export async function request(
  key: DelegatedKey,
  o: SessionJwtOptions & { version?: string | null; headers?: Record<string, string> },
): Promise<Request> {
  const headers: Record<string, string> = { "poppy-session": await sessionJwt(key, o), ...o.headers };
  if (o.version !== null) headers["poppy-version"] = o.version ?? "1.0";
  if (o.accessToken) headers.authorization = `Bearer ${o.accessToken}`;
  return new Request(o.url, { method: o.method, headers });
}
