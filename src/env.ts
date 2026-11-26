export interface Env {
  SESSIONS: KVNamespace;
  /** one Durable Object per conversation (§8) */
  CONVERSATIONS: DurableObjectNamespace;
  /** The Company's domain, host[:port]. poppy.json is served from exactly this host (§3.1). */
  COMPANY_DOMAIN: string;
  COMPANY_NAME: string;
  /** The Auth0 issuer, eg. https://tenant.us.auth0.com/. Empty: signed-out Sessions only (§3.2). */
  AUTH0_ISSUER?: string;
  /** Workers AI: the Company Agent's model. Without it the scripted agent answers. */
  AI?: { run(model: string, input: unknown): Promise<unknown> };
  /** The Workers AI model for the Company Agent (default: src/conversations/llm.ts). "off" uses the scripted agent. */
  AI_MODEL?: string;
  /** "true" only in local development: http and loopback URLs for the Company and Personal Agents. */
  DEV_ALLOW_HTTP?: string;
  /** The website's Auth0 Regular Web Application. The website's login is off until all three are set. */
  AUTH0_CLIENT_ID?: string;
  /** The API audience the website logs in with. Default: the Company's origin, which is the API's identifier. */
  AUTH0_AUDIENCE?: string;
  /** secret: `wrangler secret put`, or .dev.vars locally */
  AUTH0_CLIENT_SECRET?: string;
  /** secret, 32 characters or more: encrypts the website's session cookie */
  AUTH0_SESSION_ENCRYPTION_KEY?: string;
}

export const PROTOCOL_VERSION = "1.0";

export function devAllowHttp(env: Env): boolean {
  return env.DEV_ALLOW_HTTP === "true";
}

/** https://{organization.domain}, lowercase, no trailing slash (§3.2). */
export function companyOrigin(env: Env): string {
  const host = env.COMPANY_DOMAIN.toLowerCase();
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  return `${devAllowHttp(env) && local ? "http" : "https"}://${host}`;
}

export function issuer(env: Env): string | undefined {
  return env.AUTH0_ISSUER || undefined;
}

/** The Company identifier: Session JWTs use it as aud, and User IDs are scoped by it (§3.2). */
export function companyId(env: Env): string {
  return issuer(env) ?? companyOrigin(env);
}

/**
 * The Auth0-hosted browser join endpoint (§6), which ends in a login to the website. Undefined until
 * the Company has an issuer and the website's application: without one it offers no browser join.
 */
export function browserSessionEndpoint(env: Env): string | undefined {
  const iss = issuer(env);
  if (!iss || !env.AUTH0_CLIENT_ID) return undefined;
  return `${new URL(iss).origin}/poppy/${encodeURIComponent(env.AUTH0_CLIENT_ID)}/browser-session`;
}
