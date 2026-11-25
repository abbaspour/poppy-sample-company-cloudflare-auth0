import { type SessionRecord, KvSessionStore, sessionKey } from "../session/store";
import type { Env } from "../env";
import type { AgentInfo, Visitor } from "./identity";

/**
 * How the website's session for an agent relates to the Poppy Session the agent works in at the
 * APIs (§6: the Company sees one Session, whether the agent uses its APIs or its browser).
 */
export type SessionLink =
  /** not an agent's session */
  | { status: "not_agent" }
  /** the ID token doesn't name the agent's client metadata URL, so its Session record can't be found */
  | { status: "unlinked" }
  /** the agent hasn't called the APIs in this Session yet, so the Company has no record of it */
  | { status: "no_record" }
  | { status: "active"; record: SessionRecord }
  /** the Company ended the Session (§5.5): the website stops acting for it */
  | { status: "ended" }
  /** the Session acts for another account than this login (§5.4) */
  | { status: "account_mismatch" };

/** The agent's client metadata URL, which is the `client_id` its Session JWTs carry (§5.2). */
function agentClientId(agent: AgentInfo): string | undefined {
  // Auth0 puts the agent's CIMD URL in act.sub when the agent's application isn't linked to an
  // agent; a linked one has an Auth0 agent ID there, which the Poppy Session's key can't be built from.
  try {
    const url = new URL(agent.id);
    return url.protocol === "https:" || url.protocol === "http:" ? agent.id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Finds the Poppy Session record for an agent's website session. Both surfaces key it by the
 * agent, the Session ID and the User ID together: Session IDs are the agents' own, so another
 * agent's, or another user's, can be the same.
 */
export async function linkPoppySession(env: Env, visitor: Visitor): Promise<SessionLink> {
  const agent = visitor.agent;
  if (!agent) return { status: "not_agent" };
  const clientId = agentClientId(agent);
  if (!clientId || !agent.userId) return { status: "unlinked" };

  const record = await new KvSessionStore(env.SESSIONS).get(sessionKey(clientId, agent.sessionId, agent.userId));
  if (!record) return { status: "no_record" };
  if (record.ended) return { status: "ended" };
  // A signed-in login is for one account, and so is a Session (§5.4)
  if (visitor.kind === "agent_for_user" && record.account && record.account !== visitor.subject) {
    return { status: "account_mismatch" };
  }
  return { status: "active", record };
}

/** Why the website no longer honors an agent's session, for the page that says so. */
export const STOPPED: Record<string, string> = {
  ended: "The Company ended this Session, so the website no longer acts for it. The agent starts a new Session and joins again.",
  account_mismatch: "This Session is signed in to another account than this login. The agent starts a new Session and joins again.",
};
