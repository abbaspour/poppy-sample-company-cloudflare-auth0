import { base64url } from "jose";
import { companyOrigin } from "../env";
import { json } from "../http";
import type { Context } from "../router";
import type { Caller, Message, Op, ReadParams } from "./object";

/**
 * Personal Agent Protocol conversations (§8.2): the routes under the `poppy` entry's endpoint.
 * The router has verified the Session header and any access token; these handlers validate the
 * request and pass it to the conversation's Durable Object.
 */

export const CONVERSATIONS_PATH = "/poppy/conversations";

const ID = /^[A-Za-z0-9_-]{1,256}$/;

function invalid(description: string): Response {
  return json({ error: "invalid_request", error_description: description }, 400, { "cache-control": "no-store" });
}

function caller(ctx: Context): Caller {
  return {
    owner: { client_id: ctx.session.clientId, sub: ctx.session.sub },
    account: ctx.account ? { sub: ctx.account.sub, scopes: ctx.account.scopes } : null,
    resourceMetadata: `${companyOrigin(ctx.env)}/.well-known/oauth-protected-resource`,
  };
}

async function sha256(text: string): Promise<string> {
  return base64url.encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
}

/**
 * A new conversation's ID: derived from its owner and the request ID, which is unique for the User
 * (§8.3), so a retried first message reaches the conversation it already started. A Direct
 * Conversation the Company asked for derives from its parent and the user_requested event (§8.10).
 */
async function conversationId(...parts: string[]): Promise<string> {
  return `cnv_${(await sha256(parts.join("\n"))).slice(0, 22)}`;
}

function stub(ctx: Context, id: string): DurableObjectStub {
  return ctx.env.CONVERSATIONS.get(ctx.env.CONVERSATIONS.idFromName(id));
}

function send(ctx: Context, id: string, op: Op): Promise<Response> {
  return stub(ctx, id).fetch("https://conversation/", { method: "POST", body: JSON.stringify(op) });
}

/** cursor and wait (§8.5); Last-Event-ID wins over cursor (§8.6). */
function readParams(ctx: Context): ReadParams | string {
  const url = new URL(ctx.request.url);
  const waitParam = url.searchParams.get("wait");
  if (waitParam !== null && !/^\d+$/.test(waitParam)) return "wait must be a whole number of seconds";
  const cursor = ctx.request.headers.get("last-event-id") ?? url.searchParams.get("cursor");
  if (cursor !== null && !ID.test(cursor)) return "cursor isn't an ID";
  return { cursor, wait: waitParam === null ? 0 : Number(waitParam) };
}

/** A POST's ?wait (and ?cursor) ask for the Company's reply in the response (§8.3). */
function postRead(ctx: Context, params: ReadParams): ReadParams | null {
  return new URL(ctx.request.url).searchParams.has("wait") ? { ...params, untilIdle: true } : null;
}

/** §8.4: author.type, at least one of text, data, context, extensions. id and role are ignored. */
function parseMessage(value: unknown): Message | string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "message must be an object";
  const m = value as Record<string, unknown>;
  const author = m.author as Record<string, unknown> | undefined;
  if (typeof author !== "object" || author === null || typeof author.type !== "string") return "message.author.type is required";
  // an author.type a side doesn't recognize is treated as agent (§8.4)
  const type = author.type === "human" ? "human" : "agent";
  const isObject = (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v);
  if (m.text !== undefined && typeof m.text !== "string") return "message.text must be a string";
  for (const field of ["data", "context", "extensions"] as const) {
    if (m[field] !== undefined && !isObject(m[field])) return `message.${field} must be an object`;
  }
  if (m.text === undefined && m.data === undefined && m.context === undefined && m.extensions === undefined) {
    return "a message needs at least one of text, data, context or extensions";
  }
  const message: Message = { author: { type } };
  if (m.text !== undefined) message.text = m.text as string;
  for (const field of ["data", "context", "extensions"] as const) {
    if (m[field] !== undefined) message[field] = m[field] as Record<string, unknown>;
  }
  // only the Personal Agent's AI writes as_of_cursor, never a person (§8.4)
  if (type === "agent" && typeof m.as_of_cursor === "string") message.as_of_cursor = m.as_of_cursor;
  return message;
}

async function parseBody(ctx: Context): Promise<{ raw: string; body: Record<string, unknown> } | Response> {
  const raw = await ctx.request.text();
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return invalid("body must be JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return invalid("body must be a JSON object");
  const id = (body as Record<string, unknown>).id;
  if (typeof id !== "string" || !ID.test(id)) return invalid("every POST needs a request id (§8.3)");
  return { raw, body: body as Record<string, unknown> };
}

/** POST {endpoint}: start a conversation, or a Direct Conversation (§8.3, §8.10). */
export async function startConversation(ctx: Context): Promise<Response> {
  const read = readParams(ctx);
  if (typeof read === "string") return invalid(read);
  const parsed = await parseBody(ctx);
  if (parsed instanceof Response) return parsed;
  const { raw, body } = parsed;
  const requestId = body.id as string;
  const path = new URL(ctx.request.url).pathname;
  const hash = await sha256(raw);
  const who = caller(ctx);

  const parentId = body.parent_conversation_id;
  const eventId = body.user_requested_event_id;
  if (parentId !== undefined && (typeof parentId !== "string" || !ID.test(parentId))) return invalid("bad parent_conversation_id");
  if (eventId !== undefined && (typeof eventId !== "string" || !ID.test(eventId))) return invalid("bad user_requested_event_id");
  if (eventId !== undefined && parentId === undefined) return invalid("user_requested_event_id needs parent_conversation_id");

  // a request without a message is valid only when accepting a user_requested event (§8.10)
  let message: Message | null = null;
  if (body.message !== undefined || eventId === undefined) {
    const m = parseMessage(body.message);
    if (typeof m === "string") return invalid(m);
    message = m;
  }

  if (parentId === undefined) {
    const id = await conversationId(who.owner.client_id, who.owner.sub, requestId);
    return send(ctx, id, { op: "start", id, caller: who, requestId, path, hash, read: postRead(ctx, read), message, direct: null });
  }

  // --- a Direct Conversation: the parent checks ownership and reserves it ---
  const childId = eventId
    ? await conversationId("direct", parentId as string, eventId as string)
    : await conversationId(who.owner.client_id, who.owner.sub, requestId);
  const opened = await send(ctx, parentId as string, {
    op: "open_direct",
    caller: who,
    childId,
    eventId: (eventId as string | undefined) ?? null,
  });
  if (!opened.ok) return opened;
  const parent = (await opened.json()) as { child_id: string; existing: boolean; account: string | null; reason: string | null };

  const started = await send(ctx, parent.child_id, {
    op: "start",
    id: parent.child_id,
    caller: who,
    requestId,
    path,
    hash,
    read: postRead(ctx, read),
    message,
    direct: {
      parentId: parentId as string,
      eventId: (eventId as string | undefined) ?? null,
      reason: parent.reason,
      account: parent.account,
    },
  });
  // release a reservation this request made if the child refused to start
  if (!started.ok && !parent.existing) await send(ctx, parentId as string, { op: "direct_closed", childId: parent.child_id });
  return started;
}

type Action = "message" | "handoff" | "handoff_cancel" | "close";

async function post(ctx: Context, action: Action): Promise<Response> {
  const read = readParams(ctx);
  if (typeof read === "string") return invalid(read);
  const parsed = await parseBody(ctx);
  if (parsed instanceof Response) return parsed;
  const base = {
    caller: caller(ctx),
    requestId: parsed.body.id as string,
    path: new URL(ctx.request.url).pathname,
    hash: await sha256(parsed.raw),
    read: postRead(ctx, read),
  };
  const id = ctx.params.id!;
  if (action === "message") {
    const message = parseMessage(parsed.body.message);
    if (typeof message === "string") return invalid(message);
    return send(ctx, id, { op: "message", ...base, message });
  }
  return send(ctx, id, { op: action, ...base });
}

export const sendMessage = (ctx: Context) => post(ctx, "message");
export const requestHandoff = (ctx: Context) => post(ctx, "handoff");
export const cancelHandoff = (ctx: Context) => post(ctx, "handoff_cancel");
export const closeConversation = (ctx: Context) => post(ctx, "close");

/** GET {endpoint}/{id}/events (§8.5). Streaming (§8.6) is optional; this Company always answers JSON. */
export async function readEvents(ctx: Context): Promise<Response> {
  const read = readParams(ctx);
  if (typeof read === "string") return invalid(read);
  return send(ctx, ctx.params.id!, { op: "events", caller: caller(ctx), read });
}
