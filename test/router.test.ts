import { type JWTVerifyGetKey, SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { handle } from "../src/index";
import { clearClientCache } from "../src/session/cimd";
import { type Agent, CLIENT_ID, type DelegatedKey, delegate, makeAgent, request } from "./agent";
import { makeEnv } from "./fakes";

const ISSUER = "https://issuer.example/";
const ORIGIN = "https://shop.example";

let asKey: CryptoKey;
let jwks: JWTVerifyGetKey;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  asKey = privateKey;
  jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "as1", alg: "RS256" }] });
});

/** An access token as Auth0 issues one for the Company's API. */
function accessToken(o: { scope?: string; sub?: string; azp?: string; aud?: string; exp?: number } = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ scope: o.scope ?? "orders:read orders:write", azp: o.azp ?? CLIENT_ID })
    .setProtectedHeader({ alg: "RS256", kid: "as1" })
    .setIssuer(ISSUER)
    .setAudience(o.aud ? [o.aud] : [ORIGIN, `${ISSUER}userinfo`])
    .setSubject(o.sub ?? "auth0|alice")
    .setIssuedAt(now)
    .setExpirationTime(o.exp ?? now + 600)
    .sign(asKey);
}

let agent: Agent;
let key: DelegatedKey;
let env: Env;

beforeEach(async () => {
  clearClientCache();
  agent = await makeAgent();
  key = await delegate(agent);
  env = makeEnv(ISSUER).env;
});

async function call(method: string, path: string, o: { token?: string; body?: unknown; sid?: string } = {}) {
  const req = await request(key, { method, url: `${ORIGIN}${path}`, aud: ISSUER, accessToken: o.token, sid: o.sid });
  const withBody = o.body === undefined ? req : new Request(req, { body: JSON.stringify(o.body), headers: req.headers });
  const res = await handle(withBody, env, { fetch: agent.fetch, jwks });
  const text = await res.text();
  return { status: res.status, challenge: res.headers.get("www-authenticate"), body: text ? JSON.parse(text) : null };
}

describe("signed-in APIs (§4.5, §7)", () => {
  it("challenges a signed-out request with the scope it needs", async () => {
    const r = await call("GET", "/api/orders");
    expect(r.status).toBe(401);
    expect(r.challenge).toBe(`Bearer scope="orders:read", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`);
  });

  it("serves the account's orders with orders:read", async () => {
    const r = await call("GET", "/api/orders", { token: await accessToken({ scope: "orders:read" }) });
    expect(r.status).toBe(200);
    expect(r.body.orders.map((o: { id: string }) => o.id)).toEqual(["ord_1042", "ord_1043"]);
  });

  it("answers insufficient_scope without orders:write", async () => {
    const r = await call("POST", "/api/orders", { token: await accessToken({ scope: "orders:read" }) });
    expect(r.status).toBe(403);
    expect(r.challenge).toBe('Bearer error="insufficient_scope", scope="orders:write"');
  });

  it("checks out a cart filled signed out, in the same Session", async () => {
    await call("POST", "/api/cart/items", { body: { sku: "mug", quantity: 2 } });
    const token = await accessToken();
    const placed = await call("POST", "/api/orders", { token });
    expect(placed.status).toBe(201);
    expect(placed.body).toMatchObject({ status: "placed", total: 24 });
    expect((await call("GET", "/api/cart")).body.items).toEqual([]);
    expect((await call("GET", "/api/orders", { token })).body.orders).toHaveLength(3);
  });

  it("records a return once per item", async () => {
    const token = await accessToken();
    const body = { sku: "stormline-insulated-m", reason: "not warm enough" };
    expect((await call("POST", "/api/orders/ord_1042/returns", { token, body })).status).toBe(201);
    expect((await call("POST", "/api/orders/ord_1042/returns", { token, body })).status).toBe(409);
    expect((await call("GET", "/api/orders/ord_1042", { token })).body.returns).toHaveLength(1);
  });

  const bad: [string, () => Promise<string>, RegExp][] = [
    ["issued to another client", () => accessToken({ azp: "https://other.example/cimd.json" }), /another client/],
    ["expired", () => accessToken({ exp: Math.floor(Date.now() / 1000) - 60 }), /expired/],
    ["for another resource", () => accessToken({ aud: "https://mcp.shop.example/mcp" }), /aud/],
  ];
  for (const [name, make, message] of bad) {
    it(`rejects a token ${name} with invalid_token`, async () => {
      const r = await call("GET", "/api/orders", { token: await make() });
      expect(r.status).toBe(401);
      expect(r.challenge).toMatch(/error="invalid_token"/);
      expect(r.challenge).toMatch(message);
    });
  }

  it("ends a Session that switches to another account (§5.4)", async () => {
    expect((await call("GET", "/api/orders", { token: await accessToken({ sub: "auth0|alice" }) })).status).toBe(200);
    const r = await call("GET", "/api/orders", { token: await accessToken({ sub: "auth0|bob" }) });
    expect(r).toMatchObject({ status: 400, body: { error: "session_ended" } });
  });

  it("shows sign-in on the Session", async () => {
    const r = await call("GET", "/api/session", { token: await accessToken({ scope: "orders:read" }) });
    expect(r.body).toMatchObject({ signed_in: true, account: "auth0|alice", scopes: ["orders:read"] });
  });

  it("refuses tokens when the Company has no issuer", async () => {
    env.AUTH0_ISSUER = "";
    const req = await request(key, { method: "GET", url: `${ORIGIN}/api/cart`, aud: ORIGIN, accessToken: "anything" });
    const res = await handle(req, env, { fetch: agent.fetch, jwks });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/no sign-in/);
  });
});

describe("Sessions and routes", () => {
  it("ends a Session on DELETE /api/session, so the next request gets session_ended (§5.5)", async () => {
    expect((await call("DELETE", "/api/session")).status).toBe(204);
    expect((await call("GET", "/api/cart")).body).toMatchObject({ error: "session_ended" });
  });

  it("answers 404 and 405 before verifying anything", async () => {
    expect((await handle(new Request(`${ORIGIN}/api/nope`), env, { fetch: agent.fetch, jwks })).status).toBe(404);
    expect((await handle(new Request(`${ORIGIN}/api/orders`, { method: "PUT" }), env, { fetch: agent.fetch, jwks })).status).toBe(405);
  });

  it("publishes auth.scopes and the protected resource metadata with an issuer", async () => {
    const poppy = (await (await handle(new Request(`${ORIGIN}/.well-known/poppy.json`), env, { fetch: agent.fetch })).json()) as {
      auth: { scopes: Record<string, string>; scope_hints: Record<string, unknown> };
    };
    expect(Object.keys(poppy.auth.scopes)).toEqual(["orders:read", "orders:write"]);
    expect(poppy.auth.scope_hints["orders:write"]).toEqual({ changes: "irreversible", personal_data: true });
    const prm = await (await handle(new Request(`${ORIGIN}/.well-known/oauth-protected-resource`), env, { fetch: agent.fetch })).json();
    expect(prm).toEqual({ resource: ORIGIN, authorization_servers: [ISSUER], scopes_supported: ["orders:read", "orders:write"] });
  });
});
