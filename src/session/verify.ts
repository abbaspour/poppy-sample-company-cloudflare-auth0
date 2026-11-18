import {
  type JWK,
  type JWTPayload,
  base64url,
  calculateJwkThumbprint,
  compactVerify,
  decodeProtectedHeader,
  importJWK,
} from "jose";
import { poppyError } from "../http";
import { ClientMetadataError, getClientKeys } from "./cimd";
import { type SessionRecord, type SessionStore, sessionKey } from "./store";

/** Who and what a verified Session header names. */
export interface VerifiedSession {
  clientId: string;
  sid: string;
  sub: string;
  agentId: string | null;
  /** the access token the request carried, already matched against ath; not yet validated */
  accessToken: string | null;
  /** the Session record, created by this request if its sid was new */
  record: SessionRecord;
  /** the key under which `record` is stored */
  key: string;
  isNew: boolean;
}

export type VerifyResult = { ok: true; session: VerifiedSession } | { ok: false; response: Response };

export interface VerifyOptions {
  /** the Company identifier: issuer, or https://{organization.domain} (§3.2) */
  companyId: string;
  store: SessionStore;
  fetch: typeof fetch;
  allowHttp: boolean;
  /** seconds; default Date.now() */
  now?: number;
  /** how far iat may be from now, in seconds (§5.3 step 2) */
  iatWindow?: number;
}

const ID = /^[A-Za-z0-9_-]{1,256}$/;
const MAX_DELEGATION_SECONDS = 24 * 60 * 60;

class SessionError extends Error {}

function fail(message: string): never {
  throw new SessionError(message);
}

function parseJson(bytes: Uint8Array): Record<string, unknown> {
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return value;
  } catch {
    // fall through
  }
  fail("JWT payload isn't a JSON object");
}

function unverifiedPayload(jwt: string): Record<string, unknown> {
  const part = jwt.split(".")[1];
  if (!part) fail("malformed JWT");
  try {
    return parseJson(base64url.decode(part));
  } catch (e) {
    if (e instanceof SessionError) throw e;
    fail("malformed JWT payload");
  }
}

function protectedHeader(jwt: string): Record<string, unknown> {
  try {
    return decodeProtectedHeader(jwt) as Record<string, unknown>;
  } catch {
    fail("malformed JWT header");
  }
}

/** RFC 9449 §4.3: compare without query and fragment, after syntax-based normalization. */
function sameHtu(htu: unknown, requestUrl: string): boolean {
  if (typeof htu !== "string") return false;
  try {
    const a = new URL(htu);
    const b = new URL(requestUrl);
    return a.protocol === b.protocol && a.host === b.host && a.pathname === b.pathname;
  } catch {
    return false;
  }
}

/** The access token in Authorization, for the Bearer or DPoP scheme (§4.5). */
export function accessTokenOf(request: Request): string | null {
  const auth = request.headers.get("authorization");
  if (!auth) return null;
  const m = /^(Bearer|DPoP)\s+(\S+)$/i.exec(auth.trim());
  return m?.[2] ?? null;
}

async function sha256b64url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64url.encode(new Uint8Array(digest));
}

/**
 * Verifies the delegation in a Session JWT's poppy_dlg header (§5.2, Delegated keys) and returns
 * the delegated public key it vouches for.
 */
async function verifyDelegation(
  dlg: string,
  iss: string,
  opts: VerifyOptions,
  now: number,
): Promise<JWK> {
  const header = protectedHeader(dlg);
  if (header.typ !== "poppy-delegation+jwt") fail("delegation typ isn't poppy-delegation+jwt");
  if (header.alg !== "ES256" && header.alg !== "PS384") fail("delegation alg must be ES256 or PS384");
  if (typeof header.kid !== "string") fail("delegation has no kid");

  // 1. the key in the Personal Agent's jwks_uri named by the delegation's kid
  let client;
  try {
    client = await getClientKeys(iss, { fetch: opts.fetch, allowHttp: opts.allowHttp });
    if (!client.keys.some((k) => k.kid === header.kid)) {
      // the Personal Agent may have rotated its keys since we cached them
      client = await getClientKeys(iss, { fetch: opts.fetch, allowHttp: opts.allowHttp, refresh: true });
    }
  } catch (e) {
    if (e instanceof ClientMetadataError) fail(`client metadata: ${e.message}`);
    throw e;
  }
  const jwk = client.keys.find((k) => k.kid === header.kid);
  if (!jwk) fail(`no key ${header.kid} in the client's jwks_uri`);

  let payload: Record<string, unknown>;
  try {
    const key = await importJWK(jwk, header.alg);
    const { payload: bytes } = await compactVerify(dlg, key, { algorithms: [header.alg] });
    payload = parseJson(bytes);
  } catch (e) {
    if (e instanceof SessionError) throw e;
    fail("delegation signature doesn't verify");
  }

  // 2. typ (above), iss, expiry, and a lifetime of at most 24 hours
  if (payload.iss !== iss) fail("delegation iss isn't the Session JWT's iss");
  if (typeof payload.iat !== "number" || typeof payload.exp !== "number") fail("delegation needs iat and exp");
  if (payload.exp <= now) fail("delegation has expired");
  if (payload.exp - payload.iat > MAX_DELEGATION_SECONDS) fail("delegation lasts more than 24 hours");

  const cnf = payload.cnf as { jwk?: JWK } | undefined;
  if (!cnf?.jwk || typeof cnf.jwk !== "object") fail("delegation has no cnf.jwk");
  if ("d" in cnf.jwk) fail("delegation cnf.jwk contains a private key");
  return cnf.jwk;
}

/**
 * §5.3: verifies the Poppy-Session header of a request, and finds or starts its Session.
 * Also checks Poppy-Version (§3.4). Returns the error response to send when a check fails.
 */
export async function verifySession(request: Request, opts: VerifyOptions): Promise<VerifyResult> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const iatWindow = opts.iatWindow ?? 60;

  // §3.4: an endpoint that verifies the Session header also checks Poppy-Version
  const version = request.headers.get("poppy-version");
  if (!version || !/^1\.\d+$/.test(version.trim())) {
    return { ok: false, response: poppyError("version_unsupported", "this Company serves Poppy 1.x") };
  }

  const jwt = request.headers.get("poppy-session");
  if (!jwt) {
    return { ok: false, response: poppyError("invalid_session", "missing Poppy-Session header") };
  }

  try {
    const header = protectedHeader(jwt);
    if (header.typ !== "poppy-session+jwt") fail("typ isn't poppy-session+jwt");
    if (header.alg !== "ES256") fail("alg must be ES256");
    // a Session JWT signed directly with a jwks_uri key, without a delegation, is rejected (§5.2)
    if (typeof header.poppy_dlg !== "string") fail("no delegation in poppy_dlg");
    if (typeof header.kid !== "string") fail("no kid");

    const claimed = unverifiedPayload(jwt);
    if (typeof claimed.iss !== "string") fail("no iss");
    const iss = claimed.iss;

    // §5.2 Delegated keys, steps 1-3
    const delegatedJwk = await verifyDelegation(header.poppy_dlg, iss, opts, now);
    if ((await calculateJwkThumbprint(delegatedJwk)) !== header.kid) {
      fail("kid isn't the delegated key's thumbprint");
    }
    let claims: JWTPayload & Record<string, unknown>;
    try {
      const key = await importJWK(delegatedJwk, "ES256");
      const { payload } = await compactVerify(jwt, key, { algorithms: ["ES256"] });
      claims = parseJson(payload);
    } catch (e) {
      if (e instanceof SessionError) throw e;
      fail("signature doesn't verify with the delegated key");
    }

    // §5.3 step 2: claims
    if (claims.iss !== iss) fail("iss changed");
    if (claims.aud !== opts.companyId) fail(`aud must be ${opts.companyId}`);
    if (typeof claims.sid !== "string" || !ID.test(claims.sid)) fail("sid missing or not an ID (§8.2)");
    if (typeof claims.sub !== "string" || claims.sub === "") fail("no sub");
    if (claims.agent_id !== undefined && (typeof claims.agent_id !== "string" || claims.agent_id === "")) {
      fail("agent_id must be a string");
    }
    if (typeof claims.jti !== "string" || claims.jti === "") fail("no jti");
    if (claims.htm !== request.method) fail(`htm doesn't match the request method ${request.method}`);
    if (!sameHtu(claims.htu, request.url)) fail("htu doesn't match the request URL");
    if (typeof claims.iat !== "number" || Math.abs(now - claims.iat) > iatWindow) {
      fail("iat is outside the acceptance window; check the clock");
    }

    // §5.3 step 3: ath covers the access token, and is absent without one
    const accessToken = accessTokenOf(request);
    if (accessToken) {
      if (claims.ath !== (await sha256b64url(accessToken))) fail("ath doesn't match the access token");
    } else if (claims.ath !== undefined) {
      fail("ath present but the request has no access token");
    }

    // §5.3 step 4: find or start the Session by client_id, sid and User ID
    const agentId = (claims.agent_id as string | undefined) ?? null;
    const key = sessionKey(iss, claims.sid, claims.sub);
    let record = await opts.store.get(key);
    const isNew = record === null;
    if (record) {
      if (record.ended) {
        return { ok: false, response: poppyError("session_ended", "start a new Session with a new sid") };
      }
      // the same agent_id, or none, in every Session JWT of a Session (§5.2)
      if (record.agent_id !== agentId) fail("agent_id differs from earlier requests in this Session");
    } else {
      record = {
        client_id: iss,
        sid: claims.sid,
        sub: claims.sub,
        agent_id: agentId,
        protocol_version: version.trim(),
        created_at: new Date(now * 1000).toISOString(),
        last_seen_at: "",
        requests: 0,
        ended: false,
        account: null,
        cart: [],
      };
    }
    record.last_seen_at = new Date(now * 1000).toISOString();
    record.requests += 1;
    await opts.store.put(key, record);

    return {
      ok: true,
      session: { clientId: iss, sid: claims.sid, sub: claims.sub, agentId, accessToken, record, key, isNew },
    };
  } catch (e) {
    if (e instanceof SessionError) {
      return { ok: false, response: poppyError("invalid_session", e.message) };
    }
    throw e;
  }
}
