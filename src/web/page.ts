import type { AgentInfo, Visitor, VisitorKind } from "./identity";

const HEADLINES: Record<VisitorKind, { title: string; detail: string }> = {
  signed_out: { title: "You are signed out", detail: "Nobody is signed in to this browser." },
  user: { title: "You are signed in as a user", detail: "A person signed in with their own account." },
  agent_guest: {
    title: "An agent is browsing as a guest",
    detail: "A personal agent joined this browser to its Session signed out. It has no account here.",
  },
  agent_for_user: {
    title: "An agent is acting on behalf of a user",
    detail: "A personal agent joined this browser to its Session and is signed in as the user who approved it.",
  },
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function rows(entries: [string, string | undefined][]): string {
  return entries
    .filter((e): e is [string, string] => e[1] !== undefined)
    .map(([k, v]) => `<tr><th scope="row">${escapeHtml(k)}</th><td><code>${escapeHtml(v)}</code></td></tr>`)
    .join("\n");
}

function agentRows(agent: AgentInfo): [string, string | undefined][] {
  return [
    ["Agent", agent.id],
    ["Agent application", agent.clientId],
    ["Poppy Agent ID", agent.agentId],
    ["Poppy Session ID", agent.sessionId],
    ["Poppy User ID", agent.userId],
  ];
}

/** The page at `/`. Every value that comes from a token is escaped. */
export function renderHome(visitor: Visitor, o: { companyName: string; loginEnabled: boolean }): string {
  const { title, detail } = HEADLINES[visitor.kind];
  const details = rows([
    ["Subject", visitor.subject],
    ["Name", visitor.name],
    ["Email", visitor.email],
    ...(visitor.agent ? agentRows(visitor.agent) : []),
    ["Approved scopes", visitor.scopes ? (visitor.scopes.length ? visitor.scopes.join(" ") : "none") : undefined],
    ["Session ends", visitor.expiresAt ? new Date(visitor.expiresAt * 1000).toISOString() : undefined],
  ]);

  // A guest can't sign in from here: it signs in through its agent, which joins the browser again.
  let actions = "";
  if (visitor.kind === "signed_out") {
    actions = o.loginEnabled ? `<a href="/auth/login">Log in</a>` : `<span class="note">Login isn't configured on this server.</span>`;
  } else {
    actions = `<a href="/auth/logout">${visitor.kind === "user" ? "Log out" : "End this session"}</a>`;
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(o.companyName)}</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; color: #1a1a1a; }
  h1 { font-size: 1.1rem; margin: 0 0 2rem; color: #555; font-weight: 600; }
  h2 { font-size: 1.6rem; margin: 0 0 .25rem; }
  .status { padding: 1rem 1.25rem; border-radius: .5rem; background: #f3f4f6; border-left: .35rem solid #6b7280; }
  .status.user { border-color: #2563eb; } .status.agent_guest { border-color: #d97706; } .status.agent_for_user { border-color: #7c3aed; }
  table { border-collapse: collapse; margin: 1.5rem 0; width: 100%; }
  th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
  th { width: 11rem; font-weight: 600; color: #444; } code { word-break: break-all; }
  a { color: #2563eb; } .note { color: #666; }
</style>
</head>
<body>
<h1>${escapeHtml(o.companyName)}</h1>
<div class="status ${visitor.kind}" role="status" data-visitor-kind="${visitor.kind}">
  <h2>${escapeHtml(title)}</h2>
  <p>${escapeHtml(detail)}</p>
</div>
${details ? `<table>\n${details}\n</table>` : ""}
<p>${actions}</p>
</body>
</html>
`;
}
