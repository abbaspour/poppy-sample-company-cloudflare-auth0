/**
 * The end of a browser join. Auth0 hosts the join (§6): once the agent has authorized its code and
 * the browser has submitted it, Auth0 sends the browser to this website's Application Login URI
 * (`/auth/login`) with `iss` and `target_link_uri`. The website then starts a normal login, which
 * Auth0 completes without prompts, and the tokens name the agent in `act`.
 */
export class LoginInitiationError extends Error {}

/**
 * Checks the request that starts a login before anything is started or written.
 *
 * - `iss` that is empty, repeated or not our issuer is refused: it names another authorization
 *   server, and a login we start must be with ours. Without `iss` it's an ordinary login.
 * - `target_link_uri` is where to go afterwards, and only on our own origin. Anything else is
 *   dropped, never followed, so the login can't be used as an open redirect.
 *
 * Returns where to go after the login, as a path, if the request asked for one.
 */
export function parseLoginInitiation(url: URL, o: { issuer: string; appOrigin: string }): { returnTo?: string } {
  const issuers = url.searchParams.getAll("iss");
  if (issuers.length > 1) throw new LoginInitiationError("iss is repeated");
  if (issuers.length === 1 && issuers[0] !== o.issuer) {
    throw new LoginInitiationError(issuers[0] === "" ? "iss is empty" : "iss is not this website's issuer");
  }

  const target = url.searchParams.get("target_link_uri");
  if (!target) return {};
  let parsed: URL;
  try {
    parsed = new URL(target, o.appOrigin);
  } catch {
    return {};
  }
  if (parsed.origin !== o.appOrigin) return {};
  return { returnTo: `${parsed.pathname}${parsed.search}` };
}
