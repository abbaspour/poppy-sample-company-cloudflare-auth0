import { loadOrders } from "../api/orders";
import { signInRequired } from "../auth/challenge";
import type { Env } from "../env";
import { json } from "../http";
import { directGreeting, respond } from "./agent";
import { DEFAULT_MODEL } from "./llm";

/**
 * One conversation (§8), in a Durable Object: its events are strictly ordered, requests are acted
 * on in the order they're accepted (§8.3), and a read can wait for the next event (§8.5). The
 * Worker verifies the Session and the access token, then sends the conversation an Op.
 */

export interface Owner {
  client_id: string;
  /** the User ID */
  sub: string;
}

export interface Caller {
  owner: Owner;
  /** the validated access token's account and scopes; null when signed out */
  account: { sub: string; scopes: string[] } | null;
  /** for the challenge a signed-out request gets once the conversation uses an account */
  resourceMetadata: string;
}

export interface Message {
  author: { type: string; [key: string]: unknown };
  text?: string;
  data?: Record<string, unknown>;
  context?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
  as_of_cursor?: string;
}

export interface ReadParams {
  cursor: string | null;
  wait: number;
  /** a POST's read: hold until the Company has acted on it, not just until the next event (§8.3) */
  untilIdle?: boolean;
}

interface Request_ {
  caller: Caller;
  requestId: string;
  path: string;
  hash: string;
  read: ReadParams | null;
}

export type Op =
  | (Request_ & {
      op: "start";
      id: string;
      message: Message | null;
      /** set when this is a Direct Conversation (§8.10) */
      direct: { parentId: string; eventId: string | null; reason: string | null; account: string | null } | null;
    })
  | (Request_ & { op: "message"; message: Message })
  | (Request_ & { op: "handoff" | "handoff_cancel" | "close" })
  | { op: "events"; caller: Caller; read: ReadParams }
  /** on the parent: reserve a Direct Conversation, or find the one an earlier acceptance started */
  | { op: "open_direct"; caller: Caller; childId: string; eventId: string | null }
  /** on the parent: its Direct Conversation closed */
  | { op: "direct_closed"; childId: string }
  /** on a Direct Conversation: its parent closed */
  | { op: "close_child" };

type Event = { id: string; type: string; created_at: string; [key: string]: unknown };

type QueueItem =
  | { kind: "message"; requestId: string; text: string; account: Caller["account"] }
  | { kind: "handoff" | "handoff_cancel"; requestId: string }
  | { kind: "greeting"; reason: string | null };

interface Meta {
  id: string;
  owner: Owner;
  /** the account the conversation uses, once it has used one (§8.2) */
  account: string | null;
  /** the scope a signed-out request is challenged for, once the conversation uses an account */
  neededScope: string;
  createdAt: string;
  parentId: string | null;
  openDirect: string | null;
  directByEvent: Record<string, string>;
  userRequestedEvents: Record<string, string>;
  closed: boolean;
  handoff: "none" | "pending";
  responder: "agent" | "human";
  context: Record<string, unknown>;
  requests: Record<string, { path: string; hash: string; status: number }>;
  queue: QueueItem[];
  handoffDue: number | null;
  seq: number;
}

const AGENT_DELAY_MS = 800;
const HANDOFF_DELAY_MS = 3000;
const MAX_WAIT_SECONDS = 20;
const PAGE = 100;
const AUTHOR = { type: "agent", name: "Poppy Shop Assistant" };

function error(status: number, code: string, extra: Record<string, unknown> = {}): Response {
  return json({ error: code, ...extra }, status, { "cache-control": "no-store" });
}

function randomId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return prefix + btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export class ConversationObject {
  private meta: Meta | null = null;
  private events: Event[] = [];
  private loaded = false;
  private readonly waiters = new Set<() => void>();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const op = (await request.json()) as Op;
    await this.load();
    switch (op.op) {
      case "start":
        return this.start(op);
      case "message":
      case "handoff":
      case "handoff_cancel":
      case "close":
        return this.request(op);
      case "events": {
        const denied = this.authorize(op.caller);
        if (denied) return denied;
        await this.save(); // a signed-in read can bind the account (§8.2)
        return this.read(op.read, 200);
      }
      case "open_direct":
        return this.openDirect(op);
      case "direct_closed":
        return this.directClosed(op.childId);
      case "close_child":
        await this.close();
        return new Response(null, { status: 204 });
    }
  }

  /** The Company Agent acts on accepted requests, in order (§8.3), and ends a pending handoff. */
  async alarm(): Promise<void> {
    await this.load();
    const meta = this.meta;
    if (!meta) return;
    while (meta.queue.length > 0) {
      const item = meta.queue.shift()!;
      await this.act(item);
      await this.save();
    }
    if (meta.handoffDue !== null && Date.now() >= meta.handoffDue) {
      // this demo has no staff: say so, and stop looking (§8.9)
      meta.handoffDue = null;
      meta.handoff = "none";
      this.stateEvent();
      this.companyMessage({ text: "No one is available to join right now. I can keep helping here." }, null);
    }
    if (meta.handoffDue !== null) await this.state.storage.setAlarm(meta.handoffDue);
    await this.save();
    this.notify();
  }

  // --- storage ---

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.meta = (await this.state.storage.get<Meta>("meta")) ?? null;
    this.events = (await this.state.storage.get<Event[]>("events")) ?? [];
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await this.state.storage.put({ meta: this.meta, events: this.events });
  }

  private notify(): void {
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  private async schedule(): Promise<void> {
    await this.state.storage.setAlarm(Date.now() + AGENT_DELAY_MS);
  }

  private get working(): boolean {
    return (this.meta?.queue.length ?? 0) > 0;
  }

  // --- events ---

  private append(type: string, fields: Record<string, unknown>): Event {
    const meta = this.meta!;
    meta.seq += 1;
    const event = { id: `evt_${meta.seq}`, type, created_at: new Date().toISOString(), ...fields };
    this.events.push(event);
    return event;
  }

  private stateEvent(): void {
    const m = this.meta!;
    this.append("state", { handoff: m.handoff, responder: m.responder, closed: m.closed });
  }

  private companyMessage(reply: { text: string; data?: Record<string, unknown> }, asOfRequest: string | null): void {
    this.append("message", {
      message: {
        id: randomId("msg_"),
        role: "company",
        author: AUTHOR,
        ...(asOfRequest ? { as_of_request: asOfRequest } : {}),
        text: reply.text,
        ...(reply.data ? { data: reply.data } : {}),
      },
    });
  }

  // --- ownership (§8.2) ---

  /**
   * A conversation belongs to the client_id and User ID that started it, and to an account once it
   * uses one. Any other request gets conversation_not_found, or a challenge when it's the same User
   * signed out of the account the conversation uses.
   */
  private authorize(caller: Caller): Response | null {
    const meta = this.meta;
    if (!meta || meta.owner.client_id !== caller.owner.client_id || meta.owner.sub !== caller.owner.sub) {
      return error(404, "conversation_not_found");
    }
    if (meta.account) {
      if (!caller.account) return signInRequired([meta.neededScope], caller.resourceMetadata);
      if (caller.account.sub !== meta.account) return error(404, "conversation_not_found");
    } else if (caller.account) {
      // the conversation now uses this account (§8.11)
      meta.account = caller.account.sub;
    }
    return null;
  }

  /** §8.3: the same ID, path and body get the original response; a different path or body a conflict. */
  private replayed(requestId: string, path: string, hash: string): Response | "new" {
    const seen = this.meta!.requests[requestId];
    if (!seen) return "new";
    if (seen.path !== path || seen.hash !== hash) return error(409, "request_id_conflict");
    return new Response(JSON.stringify({ conversation_id: this.meta!.id }), {
      status: seen.status,
      headers: { "content-type": "application/json" },
    });
  }

  // --- requests ---

  private async start(op: Extract<Op, { op: "start" }>): Promise<Response> {
    if (this.meta) {
      const denied = this.authorize(op.caller);
      if (denied) return denied;
      // the same parent and user_requested event return the same Direct Conversation (§8.10)
      if (op.direct?.eventId) return this.respondTo(op.read, 201);
      const replay = this.replayed(op.requestId, op.path, op.hash);
      if (replay !== "new") return op.read && replay.ok ? this.read(op.read, replay.status) : replay;
      return error(409, "request_id_conflict");
    }

    this.meta = {
      id: op.id,
      owner: op.caller.owner,
      account: op.direct ? op.direct.account : (op.caller.account?.sub ?? null),
      neededScope: "orders:read",
      createdAt: new Date().toISOString(),
      parentId: op.direct?.parentId ?? null,
      openDirect: null,
      directByEvent: {},
      userRequestedEvents: {},
      closed: false,
      handoff: "none",
      responder: "agent",
      context: {},
      requests: { [op.requestId]: { path: op.path, hash: op.hash, status: 201 } },
      queue: [],
      handoffDue: null,
      seq: 0,
    };
    if (op.message) this.accept(op.requestId, op.message, op.caller);
    else this.meta.queue.push({ kind: "greeting", reason: op.direct?.reason ?? null });
    await this.save();
    await this.schedule();
    return this.respondTo(op.read, 201);
  }

  private async request(op: Extract<Op, { op: "message" | "handoff" | "handoff_cancel" | "close" }>): Promise<Response> {
    const denied = this.authorize(op.caller);
    if (denied) return denied;
    const meta = this.meta!;

    const replay = this.replayed(op.requestId, op.path, op.hash);
    if (replay !== "new") return op.read && replay.ok ? this.read(op.read, replay.status) : replay;

    if (op.op === "close") {
      meta.requests[op.requestId] = { path: op.path, hash: op.hash, status: 202 };
      // a close to a closed conversation changes nothing (§8.12)
      if (!meta.closed) await this.close();
      else await this.save();
      return this.respondTo(op.read, 202);
    }
    if (meta.closed) return error(409, "conversation_closed");
    if (meta.openDirect) return error(409, "direct_conversation_open", { conversation_id: meta.openDirect });

    meta.requests[op.requestId] = { path: op.path, hash: op.hash, status: 202 };
    if (op.op === "message") this.accept(op.requestId, op.message, op.caller);
    else meta.queue.push({ kind: op.op, requestId: op.requestId });
    await this.save();
    await this.schedule();
    this.notify();
    return this.respondTo(op.read, 202);
  }

  /** Records a message as sent, with role user, and queues it for the Company Agent (§8.3-8.4). */
  private accept(requestId: string, message: Message, caller: Caller): void {
    const meta = this.meta!;
    if (message.context) {
      for (const [k, v] of Object.entries(message.context)) {
        if (v === null) delete meta.context[k];
        else meta.context[k] = v;
      }
    }
    this.append("message", { message: { ...message, id: requestId, role: "user" } });
    meta.queue.push({ kind: "message", requestId, text: message.text ?? "", account: caller.account });
  }

  /** The conversation's messages before a request, oldest first, for the model. A few are enough. */
  private historyBefore(requestId: string): { role: "user" | "assistant"; text: string }[] {
    const history: { role: "user" | "assistant"; text: string }[] = [];
    for (const e of this.events) {
      const m = e.type === "message" ? (e.message as { id?: string; role?: string; text?: string }) : null;
      if (m?.id === requestId) break; // this message, and anything after it, isn't history
      if (m?.text && (m.role === "user" || m.role === "company")) {
        history.push({ role: m.role === "company" ? "assistant" : "user", text: m.text });
      }
    }
    return history.slice(-8);
  }

  private async act(item: QueueItem): Promise<void> {
    const meta = this.meta!;
    if (meta.closed) return;
    switch (item.kind) {
      case "message": {
        if (item.text.trim() === "") return; // a context-only or data-only message needs no reply
        const out = await respond({
          text: item.text,
          account: item.account,
          direct: meta.parentId !== null,
          userAvailable: typeof meta.context.user_available === "boolean" ? meta.context.user_available : null,
          loadOrders: (account) => loadOrders(this.env.SESSIONS, account),
          llm: this.env.AI && this.env.AI_MODEL !== "off" ? { ai: this.env.AI, model: this.env.AI_MODEL || DEFAULT_MODEL } : undefined,
          history: this.historyBefore(item.requestId),
        });
        if (out.authorization) {
          meta.neededScope = out.authorization.join(" ");
          this.append("authorization", { error: "insufficient_scope", scope: meta.neededScope });
        }
        if (out.userRequested && meta.parentId === null) {
          const event = this.append("user_requested", { reason: out.userRequested });
          meta.userRequestedEvents[event.id] = out.userRequested;
        }
        for (const reply of out.replies) this.companyMessage(reply, item.requestId);
        return;
      }
      case "handoff":
        // already pending, or a person is handling it: nothing changes (§8.9)
        if (meta.handoff === "pending" || meta.responder === "human") return;
        meta.handoff = "pending";
        meta.handoffDue = Date.now() + HANDOFF_DELAY_MS;
        this.stateEvent();
        return;
      case "handoff_cancel":
        if (meta.handoff !== "pending") return;
        meta.handoff = "none";
        meta.handoffDue = null;
        this.stateEvent();
        return;
      case "greeting":
        this.companyMessage(directGreeting(item.reason), null);
        return;
    }
  }

  /** §8.12: closed, no handoff, requests not yet acted on dropped; the parent or child follows. */
  private async close(): Promise<void> {
    const meta = this.meta;
    if (!meta || meta.closed) return;
    meta.closed = true;
    meta.handoff = "none";
    meta.handoffDue = null;
    meta.queue = [];
    this.stateEvent();
    await this.save();
    this.notify();
    if (meta.openDirect) await this.send(meta.openDirect, { op: "close_child" });
    if (meta.parentId) await this.send(meta.parentId, { op: "direct_closed", childId: meta.id });
  }

  // --- Direct Conversations (§8.10) ---

  private async openDirect(op: Extract<Op, { op: "open_direct" }>): Promise<Response> {
    const denied = this.authorize(op.caller);
    if (denied) return denied;
    const meta = this.meta!;
    if (meta.parentId) return error(400, "invalid_request", { error_description: "a Direct Conversation can't be a parent" });

    let reason: string | null = null;
    if (op.eventId) {
      reason = meta.userRequestedEvents[op.eventId] ?? null;
      if (reason === null) {
        return error(400, "invalid_request", { error_description: "user_requested_event_id names no user_requested event here" });
      }
      const earlier = meta.directByEvent[op.eventId];
      if (earlier) return json({ child_id: earlier, existing: true, account: meta.account, reason });
    }
    // a retry of the request that opened it
    if (meta.openDirect === op.childId) return json({ child_id: op.childId, existing: true, account: meta.account, reason });
    if (meta.closed) return error(409, "conversation_closed");
    if (meta.openDirect) return error(409, "direct_conversation_open", { conversation_id: meta.openDirect });

    meta.openDirect = op.childId;
    if (op.eventId) meta.directByEvent[op.eventId] = op.childId;
    this.append("direct_opened", { conversation_id: op.childId });
    await this.save();
    this.notify();
    return json({ child_id: op.childId, existing: false, account: meta.account, reason });
  }

  private async directClosed(childId: string): Promise<Response> {
    const meta = this.meta;
    if (meta && meta.openDirect === childId) {
      meta.openDirect = null;
      this.append("direct_closed", { conversation_id: childId });
      await this.save();
      this.notify();
    }
    return new Response(null, { status: 204 });
  }

  private async send(id: string, op: Op): Promise<void> {
    const stub = this.env.CONVERSATIONS.get(this.env.CONVERSATIONS.idFromName(id));
    await stub.fetch("https://conversation/", { method: "POST", body: JSON.stringify(op) });
  }

  // --- reads (§8.5) ---

  private respondTo(read: ReadParams | null, status: number): Promise<Response> | Response {
    if (read) return this.read(read, status);
    return new Response(JSON.stringify({ conversation_id: this.meta!.id }), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  /**
   * Events after the cursor, with the state when the Company responds. With wait, holds the
   * request until there is an event to return or working turns false, for up to wait seconds.
   */
  private async read(params: ReadParams, status: number): Promise<Response> {
    let start = 0;
    if (params.cursor) {
      const i = this.events.findIndex((e) => e.id === params.cursor);
      if (i < 0) return error(400, "invalid_cursor");
      start = i + 1;
    }
    const deadline = Date.now() + Math.min(params.wait, MAX_WAIT_SECONDS) * 1000;
    const wasWorking = this.working;
    const done = () =>
      params.untilIdle ? !this.working : this.events.length > start || (wasWorking && !this.working);
    while (!done() && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        this.waiters.add(resolve);
        setTimeout(resolve, Math.max(0, deadline - Date.now()));
      });
    }
    const page = this.events.slice(start, start + PAGE);
    const meta = this.meta!;
    return json(
      {
        conversation_id: meta.id,
        events: page,
        cursor: page.length ? page[page.length - 1]!.id : params.cursor,
        has_more: this.events.length > start + PAGE,
        working: this.working,
        handoff: meta.handoff,
        responder: meta.responder,
        closed: meta.closed,
      },
      status,
      { "cache-control": "no-store" },
    );
  }
}
