import type { Auth0Context } from "@auth0/auth0-hono";
import type { MiddlewareHandler } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { type SessionRecord, sessionKey } from "../src/session/store";
import { createApp } from "../src/web/app";
import { makeEnv } from "./fakes";

const ORIGIN = "https://shop.example";
const AGENT = "https://agent.example/cimd.json";
const SID = "g4B43922Ut9eOkjgDb7xFA";
const USER_ID = "usr_n9YYwSTyEXoeF1tr3Yr";
const ACCOUNT = "auth0|alice";

const rest = async () => new Response("rest", { status: 202 });

let env: Env;
let kv: { data: Map<string, string> };

beforeEach(() => {
  const made = makeEnv("https://auth.shop.example/");
  env = made.env;
  kv = env.SESSIONS as unknown as { data: Map<string, string> };
});

function actFor(o: { sub?: string; sid?: string; userId?: string } = {}) {
  return {
    sub: o.sub ?? AGENT,
    client_id: "tpc_x",
    poppy_sid: o.sid ?? SID,
    poppy_user_id: o.userId ?? USER_ID,
  };
}

/** What auth0-hono's middleware would put in c.var.auth0 for a session with these ID token claims. */
function as(claims: Record<string, unknown> | null, scope?: string): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const context = claims
      ? { user: claims, session: { user: claims, tokenSets: scope ? [{ audience: ORIGIN, scope }] : [] }, org: null }
      : { user: null, session: null, org: null };
    c.set("auth0", context as unknown as Auth0Context);
    await next();
  };
}

const forUser = (extra: Record<string, unknown> = {}) => ({ sub: ACCOUNT, email: "alice@example.com", act: actFor(), ...extra });
const guest = () => ({ sub: "anon_poppy@x", sub_profile: "user urn:auth0:anonymous_user", act: actFor() });

function putRecord(o: Partial<SessionRecord> = {}, key = sessionKey(AGENT, SID, USER_ID)) {
  const record: SessionRecord = {
    client_id: AGENT,
    sid: SID,
    sub: USER_ID,
    agent_id: null,
    protocol_version: "1.0",
    created_at: "2026-11-25T00:00:00Z",
    last_seen_at: "2026-11-25T00:00:00Z",
    requests: 3,
    ended: false,
    account: null,
    cart: [{ sku: "tee-m", quantity: 2 }, { sku: "mug", quantity: 1 }],
    ...o,
  };
  kv.data.set(key, JSON.stringify(record));
}

async function get(auth: MiddlewareHandler<{ Bindings: Env }>, path: string, accept = "text/html") {
  const res = await createApp(rest, auth).fetch(new Request(`${ORIGIN}${path}`, { headers: { accept } }), env);
  return { status: res.status, body: await res.text(), headers: res.headers };
}

describe("the cart is the agent's Session's", () => {
  it("shows what the agent put in its cart through the API, for a guest", async () => {
    putRecord();
    const r = await get(as(guest()), "/cart");
    expect(r.status).toBe(200);
    expect(r.body).toContain("Poppy T-shirt, medium");
    expect(r.body).toContain("USD 62.00"); // 2 x 25 + 12
    expect(r.body).toContain(SID);
  });

  it("shows it to the signed-in agent too", async () => {
    putRecord();
    expect((await get(as(forUser(), "openid"), "/cart")).body).toContain("Poppy mug");
  });

  it("finds a Session by the agent, the Session ID and the User ID together", async () => {
    putRecord({}, sessionKey(AGENT, SID, "usr_someone_else"));
    putRecord({}, sessionKey("https://other.example/cimd.json", SID, USER_ID));
    const r = await get(as(guest()), "/cart");
    expect(r.body).not.toContain("Poppy mug");
    expect(r.body).toContain("hasn't used the APIs in this Session yet");
  });

  it("says so when the agent's Session can't be found from its login", async () => {
    putRecord();
    const linked = guest();
    linked.act = actFor({ sub: "agt_gZameUasxQq5wLiFTW7rxF" }); // an Auth0 agent ID, not its metadata URL
    expect((await get(as(linked), "/cart")).body).toContain("hasn't used the APIs");
  });

  it("isn't for a person or a signed-out visitor", async () => {
    expect((await get(as({ sub: ACCOUNT }), "/cart")).status).toBe(401);
    expect((await get(as(null), "/cart")).status).toBe(401);
  });
});

describe("orders are the account's, within the agent's scopes (§6)", () => {
  it("shows a person their orders", async () => {
    const r = await get(as({ sub: ACCOUNT }), "/orders");
    expect(r.status).toBe(200);
    expect(r.body).toContain("ord_1042");
  });

  it("shows the user's orders to an agent they approved orders:read for", async () => {
    putRecord();
    const r = await get(as(forUser(), "openid orders:read"), "/orders");
    expect(r.status).toBe(200);
    expect(r.body).toContain("ord_1043");
  });

  it("refuses an agent without orders:read, and names the scope", async () => {
    putRecord();
    const r = await get(as(forUser(), "openid cart:write"), "/orders");
    expect(r.status).toBe(403);
    expect(r.body).toContain("Missing scope: orders:read");
    expect(r.body).toContain('data-missing-scope="orders:read"');
    expect(r.body).not.toContain("ord_1042");
  });

  it("refuses a guest, which has no account", async () => {
    putRecord();
    const r = await get(as(guest()), "/orders");
    expect(r.status).toBe(403);
    expect(r.body).not.toContain("ord_1042");
  });

  it("asks a signed-out visitor to log in", async () => {
    expect((await get(as(null), "/orders")).status).toBe(401);
  });
});

describe("the website stops acting for a Session the Company has ended (§5.5, §5.4)", () => {
  it("treats an agent whose Session ended as signed out, and says why", async () => {
    putRecord({ ended: true });
    const home = await get(as(forUser(), "openid orders:read"), "/");
    expect(home.body).toContain('data-visitor-kind="signed_out"');
    expect(home.body).toContain("ended this Session");
    expect((await get(as(forUser(), "openid orders:read"), "/cart")).status).toBe(403);
    const orders = await get(as(forUser(), "openid orders:read"), "/orders");
    expect(orders.status).toBe(403);
    expect(orders.body).not.toContain("ord_1042");
  });

  it("applies to a guest too", async () => {
    putRecord({ ended: true });
    expect((await get(as(guest()), "/cart")).status).toBe(403);
  });

  it("refuses a login for another account than the Session is signed in to", async () => {
    putRecord({ account: "auth0|bob" });
    const home = await get(as(forUser(), "openid orders:read"), "/");
    expect(home.body).toContain('data-visitor-kind="signed_out"');
    expect((await get(as(forUser(), "openid orders:read"), "/orders")).status).toBe(403);
  });

  it("keeps acting for the account the Session is signed in to", async () => {
    putRecord({ account: ACCOUNT });
    expect((await get(as(forUser(), "openid orders:read"), "/orders")).status).toBe(200);
  });

  it("doesn't touch a person's session", async () => {
    putRecord({ ended: true });
    expect((await get(as({ sub: ACCOUNT }), "/orders")).status).toBe(200);
  });

  it("reports the link in the JSON description", async () => {
    putRecord({ ended: true });
    const r = await get(as(forUser()), "/", "application/json");
    expect(JSON.parse(r.body)).toMatchObject({ visitor: { kind: "signed_out" }, poppy_session: { status: "ended" } });
    putRecord({ ended: false });
    expect(JSON.parse((await get(as(forUser()), "/", "application/json")).body)).toMatchObject({
      visitor: { kind: "agent_for_user" },
      poppy_session: { status: "active" },
    });
  });
});

describe("pages never reach the APIs' code, and the APIs never see the session", () => {
  it("sends pages' security headers", async () => {
    const r = await get(as(null), "/orders");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });
});
