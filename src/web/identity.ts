/**
 * Who is driving the browser: nobody signed in, a person, an agent browsing as a guest, or an agent
 * signed in as a user. Auth0 puts the agent in the `act` claim of the ID token after a browser join
 * (Poppy session joining). Only a Poppy `act`, one with `poppy_sid`, makes the visitor an agent.
 */
export type VisitorKind = "signed_out" | "user" | "agent_guest" | "agent_for_user";

export interface AgentInfo {
  /** the agent's Auth0 agent ID, or its CIMD URL if its application isn't linked to an agent */
  id: string;
  /** the Auth0 client ID of the agent's application */
  clientId?: string;
  /** the Poppy Session ID the agent chose. Agents choose these, so key state by it and `userId` together. */
  sessionId: string;
  /** the Poppy User ID the agent gave its user for this Company. Not an account identifier. */
  userId?: string;
  /** the Poppy Agent ID, when the agent sent one */
  agentId?: string;
}

export interface Visitor {
  kind: VisitorKind;
  /** the ID token's `sub`. For a guest it is an anonymous subject, not an account. */
  subject?: string;
  name?: string;
  email?: string;
  agent?: AgentInfo;
  /** For an agent signed in as a user: the scopes the user approved for it, as its access token carries them */
  scopes?: string[];
  /** For an agent: when its session ends, as an ID token expiry in seconds. A join lasts at most 2 hours. */
  expiresAt?: number;
}

const ANONYMOUS_PROFILE = "urn:auth0:anonymous_user";

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The agent in a Poppy `act` claim; undefined for an `act` that isn't Poppy's (no `poppy_sid`). */
export function agentFromAct(act: unknown): AgentInfo | undefined {
  if (!isRecord(act)) return undefined;
  const sessionId = str(act.poppy_sid);
  if (!sessionId) return undefined;
  return {
    id: str(act.sub) ?? "unknown",
    clientId: str(act.client_id),
    sessionId,
    userId: str(act.poppy_user_id),
    agentId: str(act.poppy_agent_id),
  };
}

/**
 * Classifies the session's ID token claims. A guest has an anonymous subject, so it is told by
 * `sub_profile`, never by parsing `sub`, and it is never a user.
 */
export function classifyVisitor(
  claims: Record<string, unknown> | null | undefined,
  o: { now?: number; scope?: string } = {},
): Visitor {
  if (!claims) return { kind: "signed_out" };

  const profile = str(claims.sub_profile)?.split(/\s+/) ?? [];
  const guest = profile.includes(ANONYMOUS_PROFILE);
  const agent = agentFromAct(claims.act);
  const subject = str(claims.sub);

  // A join's session lasts as long as its ID token, and gets no refresh token. The cookie outlives
  // it, so the website stops honoring it. A person's session is the SDK's to expire.
  const expiresAt = typeof claims.exp === "number" ? claims.exp : undefined;
  if (agent && expiresAt !== undefined && expiresAt <= (o.now ?? Math.floor(Date.now() / 1000))) {
    return { kind: "signed_out" };
  }

  if (guest) {
    // An anonymous session without a Poppy agent isn't a person either: nobody has signed in.
    return agent ? { kind: "agent_guest", subject, agent, expiresAt } : { kind: "signed_out" };
  }
  if (!subject) return { kind: "signed_out" };

  return {
    kind: agent ? "agent_for_user" : "user",
    subject,
    name: str(claims.name),
    email: str(claims.email),
    ...(agent && { agent, expiresAt, scopes: o.scope?.split(/\s+/).filter(Boolean) ?? [] }),
  };
}
