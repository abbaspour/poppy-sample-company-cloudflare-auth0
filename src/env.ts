export interface Env {
  SESSIONS: KVNamespace;
  /** one Durable Object per conversation (§8) */
  CONVERSATIONS: DurableObjectNamespace;
  /** The Company's domain, host[:port]. poppy.json is served from exactly this host (§3.1). */
  COMPANY_DOMAIN: string;
  COMPANY_NAME: string;
  /** The Auth0 issuer, eg. https://tenant.us.auth0.com/. Empty: signed-out Sessions only (§3.2). */
  AUTH0_ISSUER?: string;
  /** "true" only in local development: http and loopback URLs for the Company and Personal Agents. */
  DEV_ALLOW_HTTP?: string;
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
