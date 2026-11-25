import { type Env, PROTOCOL_VERSION, browserSessionEndpoint, companyOrigin, issuer } from "../env";
import { CONVERSATIONS_PATH } from "../conversations/routes";
import { BROWSER_SIGN_IN, SCOPES } from "../scopes";

/**
 * GET /.well-known/poppy.json (§3). organization.domain is the host that serves it, with its port
 * when that isn't 443 (§3.1). The `auth` block describes the scopes once the Company has an issuer.
 */
export function poppyJson(env: Env): Record<string, unknown> {
  const origin = companyOrigin(env);
  const doc: Record<string, unknown> = {
    protocol_version: PROTOCOL_VERSION,
    organization: {
      name: env.COMPANY_NAME,
      domain: env.COMPANY_DOMAIN.toLowerCase(),
    },
    apis: [
      {
        type: "openapi",
        url: `${origin}/openapi.json`,
        description: "Products, a shopping cart for the Session, and, signed in, the account's orders and returns",
      },
    ],
    agent: {
      protocols: [
        {
          type: "poppy",
          endpoint: `${origin}${CONVERSATIONS_PATH}`,
          description: "Questions about products, the status of orders, and returns",
        },
      ],
    },
    tasks: { endpoint: `${origin}/poppy/tasks` },
  };
  if (issuer(env)) {
    const scopes: Record<string, string> = Object.fromEntries(Object.entries(SCOPES).map(([name, s]) => [name, s.description]));
    const browserSession = browserSessionEndpoint(env);
    if (browserSession) scopes[BROWSER_SIGN_IN.name] = BROWSER_SIGN_IN.description;
    doc.auth = {
      scopes,
      scope_hints: Object.fromEntries(Object.entries(SCOPES).map(([name, s]) => [name, s.hints])),
    };
    // §6: the browser joins through Auth0's endpoint, which ends in a login to the website. The
    // website applies the agent's scopes rather than treating the join as the account's full access.
    if (browserSession) doc.web = { browser_session_endpoint: browserSession, unscoped: false };
  }
  return doc;
}
