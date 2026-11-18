import { beforeEach, describe, expect, it } from "vitest";
import { checkUrl, clearClientCache } from "../src/session/cimd";
import { MemorySessionStore, sessionKey } from "../src/session/store";
import { type VerifyOptions, verifySession } from "../src/session/verify";
import { type Agent, CLIENT_ID, COMPANY_ID, type DelegatedKey, delegate, makeAgent, request } from "./agent";

const URL_ = "https://shop.example/api/cart";

let agent: Agent;
let key: DelegatedKey;
let store: MemorySessionStore;
let opts: VerifyOptions;

async function errorOf(req: Request): Promise<{ status: number; error: string; description?: string }> {
  const result = await verifySession(req, opts);
  if (result.ok) return { status: 200, error: "" };
  const body = (await result.response.json()) as { error: string; error_description?: string };
  return { status: result.response.status, error: body.error, description: body.error_description };
}

beforeEach(async () => {
  clearClientCache();
  agent = await makeAgent();
  key = await delegate(agent);
  store = new MemorySessionStore();
  opts = { companyId: COMPANY_ID, store, fetch: agent.fetch, allowHttp: false };
});

describe("verifySession (§5.3)", () => {
  it("starts a Session for a new sid, then continues it", async () => {
    const first = await verifySession(await request(key, { method: "GET", url: URL_ }), opts);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.session).toMatchObject({ clientId: CLIENT_ID, sub: "usr_Q7c1vK", isNew: true, accessToken: null });

    // a new delegated key for the same User is fine: nothing depends on the key (§5.2)
    const other = await delegate(agent);
    const second = await verifySession(await request(other, { method: "GET", url: `${URL_}?x=1` }), opts);
    expect(second.ok && second.session.isNew).toBe(false);
    expect(second.ok && second.session.record.requests).toBe(2);
  });

  it("accepts an access token covered by ath", async () => {
    const result = await verifySession(await request(key, { method: "GET", url: URL_, accessToken: "at_123" }), opts);
    expect(result.ok && result.session.accessToken).toBe("at_123");
  });

  it("checks Poppy-Version (§3.4)", async () => {
    expect(await errorOf(await request(key, { method: "GET", url: URL_, version: null }))).toMatchObject({
      status: 400,
      error: "version_unsupported",
    });
    expect((await errorOf(await request(key, { method: "GET", url: URL_, version: "2.0" }))).error).toBe(
      "version_unsupported",
    );
    expect((await errorOf(await request(key, { method: "GET", url: URL_, version: "1.1" }))).error).toBe("");
  });

  const invalid: [string, () => Promise<Request>, RegExp][] = [
    ["missing header", async () => new Request(URL_, { headers: { "poppy-version": "1.0" } }), /missing/],
    ["wrong typ", () => request(key, { method: "GET", url: URL_, typ: "JWT" }), /typ/],
    ["no delegation", () => request(key, { method: "GET", url: URL_, noDelegation: true }), /delegation/],
    [
      "signed directly with the jwks key",
      () => request(key, { method: "GET", url: URL_, noDelegation: true, signWith: agent.rootPrivate }),
      /delegation/,
    ],
    ["kid not the delegated key's thumbprint", () => request(key, { method: "GET", url: URL_, kid: "nope" }), /thumbprint/],
    ["wrong aud", () => request(key, { method: "GET", url: URL_, aud: "https://other.example" }), /aud/],
    ["wrong htm", async () => {
      const r = await request(key, { method: "GET", url: URL_ });
      return new Request(r, { method: "DELETE" });
    }, /htm/],
    ["wrong htu", async () => {
      const r = await request(key, { method: "GET", url: URL_ });
      return new Request("https://shop.example/api/products", { headers: r.headers });
    }, /htu/],
    ["stale iat", () => request(key, { method: "GET", url: URL_, iat: Math.floor(Date.now() / 1000) - 600 }), /iat/],
    ["ath without a token", () => request(key, { method: "GET", url: URL_, ath: "abc" }), /ath/],
    ["ath for another token", async () => {
      const r = await request(key, { method: "GET", url: URL_, accessToken: "at_123" });
      const h = new Headers(r.headers);
      h.set("authorization", "Bearer at_456");
      return new Request(URL_, { headers: h });
    }, /ath/],
    ["sid not an ID", () => request(key, { method: "GET", url: URL_, sid: "has spaces" }), /sid/],
  ];

  for (const [name, make, message] of invalid) {
    it(`rejects ${name} with invalid_session`, async () => {
      const e = await errorOf(await make());
      expect(e.status).toBe(400);
      expect(e.error).toBe("invalid_session");
      expect(e.description).toMatch(message);
    });
  }

  it("rejects an expired delegation", async () => {
    const now = Math.floor(Date.now() / 1000);
    const expired = await delegate(agent, { iat: now - 7200, exp: now - 60 });
    expect((await errorOf(await request(expired, { method: "GET", url: URL_ }))).description).toMatch(/expired/);
  });

  it("rejects a delegation longer than 24 hours", async () => {
    const now = Math.floor(Date.now() / 1000);
    const long = await delegate(agent, { iat: now, exp: now + 25 * 3600 });
    expect((await errorOf(await request(long, { method: "GET", url: URL_ }))).description).toMatch(/24 hours/);
  });

  it("rejects a delegation with the wrong typ or iss", async () => {
    const badTyp = await delegate(agent, { typ: "poppy-session+jwt" });
    expect((await errorOf(await request(badTyp, { method: "GET", url: URL_ }))).description).toMatch(/typ/);
    const badIss = await delegate(agent, { iss: "https://evil.example/cimd.json" });
    expect((await errorOf(await request(badIss, { method: "GET", url: URL_ }))).description).toMatch(/iss/);
  });

  it("rejects a delegation from a key that isn't in jwks_uri", async () => {
    const stranger = await makeAgent();
    const foreign = await delegate(stranger);
    expect((await errorOf(await request(foreign, { method: "GET", url: URL_ }))).description).toMatch(/no key/);
  });

  it("rejects an agent_id change within a Session (§5.2)", async () => {
    expect((await errorOf(await request(key, { method: "GET", url: URL_, agentId: "agt_a" }))).error).toBe("");
    expect((await errorOf(await request(key, { method: "GET", url: URL_, agentId: "agt_b" }))).description).toMatch(
      /agent_id/,
    );
  });

  it("answers session_ended for an ended Session (§5.5)", async () => {
    await verifySession(await request(key, { method: "GET", url: URL_ }), opts);
    const k = sessionKey(CLIENT_ID, "Yx2b7Qd_Kp8mR3vT1nWc4A", "usr_Q7c1vK");
    const record = (await store.get(k))!;
    record.ended = true;
    await store.put(k, record);
    expect(await errorOf(await request(key, { method: "GET", url: URL_ }))).toMatchObject({
      status: 400,
      error: "session_ended",
    });
  });

});

describe("checkUrl (§3)", () => {
  it("allows only public HTTPS URLs, unless in dev mode", () => {
    expect(() => checkUrl("https://agent.example/cimd.json", false)).not.toThrow();
    expect(() => checkUrl("http://agent.example/cimd.json", false)).toThrow(/HTTPS/);
    expect(() => checkUrl("https://127.0.0.1/cimd.json", false)).toThrow(/loopback/);
    expect(() => checkUrl("https://10.0.0.5/cimd.json", false)).toThrow(/private/);
    expect(() => checkUrl("http://localhost:1990/cimd.json", true)).not.toThrow();
    expect(() => checkUrl("http://agent.example/cimd.json", true)).toThrow(/HTTPS/);
  });
});
