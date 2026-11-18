import { type JWTVerifyGetKey, SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { handle } from "../src/index";
import { clearClientCache } from "../src/session/cimd";
import { type Agent, CLIENT_ID, type DelegatedKey, delegate, makeAgent, request } from "./agent";
import { type MemoryDurableObjects, makeEnv } from "./fakes";

const ISSUER = "https://issuer.example/";
const ORIGIN = "https://shop.example";
const EP = "/poppy/conversations";

let asKey: CryptoKey;
let jwks: JWTVerifyGetKey;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  asKey = privateKey;
  jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "as1", alg: "RS256" }] });
});

function accessToken(o: { scope?: string; sub?: string } = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ scope: o.scope ?? "orders:read orders:write", azp: CLIENT_ID })
    .setProtectedHeader({ alg: "RS256", kid: "as1" })
    .setIssuer(ISSUER)
    .setAudience(ORIGIN)
    .setSubject(o.sub ?? "auth0|alice")
    .setIssuedAt(now)
    .setExpirationTime(now + 600)
    .sign(asKey);
}

let agent: Agent;
let key: DelegatedKey;
let env: Env;
let dos: MemoryDurableObjects;

beforeEach(async () => {
  clearClientCache();
  agent = await makeAgent();
  key = await delegate(agent);
  ({ env, durableObjects: dos } = makeEnv(ISSUER));
});

afterEach(() => vi.restoreAllMocks());

interface Result {
  status: number;
  challenge: string | null;
  body: any;
}

async function call(
  method: string,
  path: string,
  o: { token?: string; body?: unknown; sub?: string; sid?: string } = {},
): Promise<Result> {
  const req = await request(key, { method, url: `${ORIGIN}${path}`, aud: ISSUER, accessToken: o.token, sub: o.sub, sid: o.sid });
  const withBody = o.body === undefined ? req : new Request(req, { body: JSON.stringify(o.body), headers: req.headers });
  const res = await handle(withBody, env, { fetch: agent.fetch, jwks });
  const text = await res.text();
  return { status: res.status, challenge: res.headers.get("www-authenticate"), body: text ? JSON.parse(text) : null };
}

const msg = (id: string, text: string, type = "agent") => ({ id, message: { author: { type }, text } });
const start = (id: string, text: string, o: { token?: string } = {}) => call("POST", EP, { ...o, body: msg(id, text) });
const events = (cid: string, o: { token?: string; cursor?: string; sub?: string; sid?: string } = {}) =>
  call("GET", `${EP}/${cid}/events${o.cursor ? `?cursor=${o.cursor}` : ""}`, o);
const send = (cid: string, id: string, text: string, o: { token?: string } = {}) =>
  call("POST", `${EP}/${cid}/messages`, { ...o, body: msg(id, text) });
const companyTexts = (r: Result) =>
  r.body.events.filter((e: any) => e.type === "message" && e.message.role === "company").map((e: any) => e.message.text);

describe("conversations (§8.2-8.7)", () => {
  it("starts a conversation and replies signed out", async () => {
    const started = await start("req_products_1", "What products do you sell?");
    expect(started.status).toBe(201);
    const cid = started.body.conversation_id;
    expect(cid).toMatch(/^cnv_/);

    const before = await events(cid);
    expect(before.body).toMatchObject({ working: true, handoff: "none", responder: "agent", closed: false, has_more: false });
    expect(before.body.events[0].message).toMatchObject({ id: "req_products_1", role: "user", author: { type: "agent" } });

    await dos.runAlarms(Date.now() + 1000);
    const after = await events(cid);
    expect(after.body.working).toBe(false);
    const reply = after.body.events[1];
    expect(reply.message).toMatchObject({ role: "company", author: { type: "agent" }, as_of_request: "req_products_1" });
    expect(reply.message.text).toMatch(/Poppy mug/);
    expect(after.body.cursor).toBe(reply.id);

    // reading from the cursor returns only what's new
    expect((await events(cid, { cursor: reply.id })).body.events).toEqual([]);
  });

  it("returns the Company's reply in the response with ?wait (§8.3)", async () => {
    const cid = (await start("req_wait_1", "hello")).body.conversation_id;
    await dos.runAlarms(Date.now() + 1000);
    const cursor = (await events(cid)).body.cursor;
    const pending = call("POST", `${EP}/${cid}/messages?cursor=${cursor}&wait=5`, { body: msg("req_wait_2", "any jackets?") });
    await new Promise((r) => setTimeout(r, 20));
    await dos.runAlarms(Date.now() + 1000);
    const r = await pending;
    expect(r.status).toBe(202);
    expect(r.body.events.map((e: any) => e.message.id)).toEqual(["req_wait_2", expect.stringMatching(/^msg_/)]);
    expect(r.body.working).toBe(false);
  });

  it("is idempotent per request id, and refuses a reused id with another body", async () => {
    const a = await start("req_same_1", "hello");
    const b = await start("req_same_1", "hello");
    expect(b).toMatchObject({ status: 201, body: { conversation_id: a.body.conversation_id } });
    expect((await events(a.body.conversation_id)).body.events).toHaveLength(1);
    expect((await start("req_same_1", "something else")).body).toEqual({ error: "request_id_conflict" });
  });

  it("asks for sign-in with an authorization event, then continues signed in (§8.11)", async () => {
    const cid = (await start("req_order_1", "Where is my order?")).body.conversation_id;
    await dos.runAlarms(Date.now() + 1000);
    const r = await events(cid);
    const auth = r.body.events.find((e: any) => e.type === "authorization");
    expect(auth).toMatchObject({ error: "insufficient_scope", scope: "orders:read" });

    const token = await accessToken();
    expect((await send(cid, "req_order_2", "Where is my order?", { token })).status).toBe(202);
    await dos.runAlarms(Date.now() + 1000);
    const signedIn = await events(cid, { token, cursor: r.body.cursor });
    expect(companyTexts(signedIn).join(" ")).toMatch(/latest order is ord_1042/);

    // the conversation now uses alice's account (§8.2): signed out, a challenge
    expect((await events(cid)).challenge).toMatch(/scope="orders:read"/);
    // another account in this Session ends the Session (§5.4) ...
    const bob = await accessToken({ sub: "auth0|bob" });
    expect((await events(cid, { token: bob })).body.error).toBe("session_ended");
    // ... and in a new Session, the conversation isn't bob's to see (§8.2)
    expect((await events(cid, { token: bob, sid: "aNewSessionForBob01" })).body).toEqual({ error: "conversation_not_found" });
  });

  it("belongs to its client and User ID (§8.2)", async () => {
    const cid = (await start("req_owner_1", "hello")).body.conversation_id;
    // the same client, another User ID: not found, exactly as for an unknown conversation
    expect((await events(cid, { sub: "usr_someone_else" })).body).toEqual({ error: "conversation_not_found" });
    // any Session of the same User continues it (§8.2)
    expect((await events(cid, { sid: "anotherSessionSameUser" })).status).toBe(200);
  });

  it("closes: no more messages, a second close changes nothing (§8.12)", async () => {
    const cid = (await start("req_close_1", "hello")).body.conversation_id;
    expect((await call("POST", `${EP}/${cid}/close`, { body: { id: "req_close_2" } })).status).toBe(202);
    const r = await events(cid);
    expect(r.body).toMatchObject({ closed: true, working: false });
    expect(r.body.events.at(-1)).toMatchObject({ type: "state", closed: true });
    expect((await send(cid, "req_close_3", "more")).body).toEqual({ error: "conversation_closed" });
    expect((await call("POST", `${EP}/${cid}/close`, { body: { id: "req_close_4" } })).status).toBe(202);
  });

  it("runs a handoff honestly: pending, then no one available (§8.9)", async () => {
    const cid = (await start("req_hand_1", "hello")).body.conversation_id;
    await call("POST", `${EP}/${cid}/handoff`, { body: { id: "req_hand_2" } });
    await dos.runAlarms(Date.now() + 1000);
    expect((await events(cid)).body.handoff).toBe("pending");

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10_000);
    await dos.runAlarms(Date.now());
    vi.restoreAllMocks();
    const r = await events(cid);
    expect(r.body).toMatchObject({ handoff: "none", responder: "agent" });
    expect(companyTexts(r).at(-1)).toMatch(/No one is available/);
  });

  it("rejects malformed requests (§8.13)", async () => {
    expect((await call("POST", EP, { body: { message: { author: { type: "agent" }, text: "x" } } })).body.error).toBe(
      "invalid_request",
    );
    expect((await call("POST", EP, { body: { id: "req_bad_1", message: { author: { type: "agent" } } } })).body.error).toBe(
      "invalid_request",
    );
    const cid = (await start("req_bad_2", "hello")).body.conversation_id;
    expect((await call("GET", `${EP}/${cid}/events?wait=soon`)).body.error).toBe("invalid_request");
    expect((await events(cid, { cursor: "evt_999" })).body.error).toBe("invalid_cursor");
    expect((await events("cnv_unknown")).body.error).toBe("conversation_not_found");
  });
});

describe("Direct Conversations (§8.10)", () => {
  it("follows a user_requested event into a Direct Conversation and back", async () => {
    const parent = (await start("req_dir_1", "Please cancel my order")).body.conversation_id;
    await dos.runAlarms(Date.now() + 1000);
    const asked = (await events(parent)).body.events.find((e: any) => e.type === "user_requested");
    expect(asked.reason).toMatch(/confirmation/);

    const accept = { id: "req_dir_2", parent_conversation_id: parent, user_requested_event_id: asked.id };
    const opened = await call("POST", EP, { body: accept });
    expect(opened.status).toBe(201);
    const child = opened.body.conversation_id;
    expect(child).not.toBe(parent);

    // the parent shows the Direct Conversation and takes no messages meanwhile
    const p = await events(parent);
    expect(p.body.events.at(-1)).toMatchObject({ type: "direct_opened", conversation_id: child });
    expect((await send(parent, "req_dir_3", "still there?")).body).toEqual({
      error: "direct_conversation_open",
      conversation_id: child,
    });

    // the Company speaks first, then answers the User's own words
    await dos.runAlarms(Date.now() + 1000);
    expect(companyTexts(await events(child))[0]).toMatch(/Thanks for joining/);
    await call("POST", `${EP}/${child}/messages`, { body: msg("req_dir_4", "Yes, please cancel it", "human") });
    await dos.runAlarms(Date.now() + 1000);
    expect(companyTexts(await events(child)).at(-1)).toMatch(/can't be cancelled/);

    // accepting the same event again returns the same Direct Conversation
    expect((await call("POST", EP, { body: { ...accept, id: "req_dir_5" } })).body.conversation_id).toBe(child);

    // closing it reopens the parent
    await call("POST", `${EP}/${child}/close`, { body: { id: "req_dir_6" } });
    expect((await events(parent)).body.events.at(-1)).toMatchObject({ type: "direct_closed", conversation_id: child });
    expect((await send(parent, "req_dir_7", "thanks")).status).toBe(202);
  });

  it("refuses an event id that isn't a user_requested event", async () => {
    const parent = (await start("req_dir_8", "hello")).body.conversation_id;
    const r = await call("POST", EP, { body: { id: "req_dir_9", parent_conversation_id: parent, user_requested_event_id: "evt_1" } });
    expect(r.body.error).toBe("invalid_request");
  });
});

describe("tasks and feedback (§9)", () => {
  it("lists excluded tasks, a skill whose digest matches, and the feedback endpoint", async () => {
    const r = await call("GET", "/poppy/tasks");
    expect(r.status).toBe(200);
    expect(r.body.excluded_tasks.map((t: any) => t.task)).toContain("Close an account");
    expect(r.body.feedback.endpoint).toBe(`${ORIGIN}/poppy/feedback`);
    const skill = r.body.skill_index.skills[0];
    const url = new URL(skill.url, `${ORIGIN}/poppy/tasks`);
    expect(url.href).toBe(`${ORIGIN}/skills/return-an-item/SKILL.md`);
    const artifact = await (await handle(new Request(url), env, { fetch: agent.fetch })).text();
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(artifact))))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(skill.digest).toBe(`sha256:${digest}`);
  });

  it("accepts feedback with 202, or answers with an alternative", async () => {
    const report = { task: "Pay with a gift card", description: "The User wanted to pay with a gift card; no API takes one." };
    expect((await call("POST", "/poppy/feedback", { body: report })).status).toBe(202);
    const alt = await call("POST", "/poppy/feedback", { body: { task: "Return a jacket", description: "Couldn't find how." } });
    expect(alt.status).toBe(200);
    expect(alt.body.references[0]).toMatchObject({ type: "openapi", operation_id: "requestReturn" });
    expect((await call("POST", "/poppy/feedback", { body: { task: "x".repeat(201), description: "d" } })).body.error).toBe(
      "invalid_request",
    );
  });

  it("lists the conversation endpoint and tasks in poppy.json", async () => {
    const poppy = (await (await handle(new Request(`${ORIGIN}/.well-known/poppy.json`), env, { fetch: agent.fetch })).json()) as {
      agent: { protocols: { type: string; endpoint: string }[] };
      tasks: { endpoint: string };
    };
    expect(poppy.agent.protocols[0]).toMatchObject({ type: "poppy", endpoint: `${ORIGIN}${EP}` });
    expect(poppy.tasks.endpoint).toBe(`${ORIGIN}/poppy/tasks`);
  });
});
