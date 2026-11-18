export function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * Poppy's JSON errors (§5.3, §3.4, §3.3). Session errors are 400, not 401, so OAuth libraries
 * don't throw away a valid access token.
 */
export type PoppyError = "invalid_session" | "session_ended" | "version_unsupported" | "invalid_request";

export function poppyError(error: PoppyError, description?: string, status = 400): Response {
  return json(description ? { error, error_description: description } : { error }, status, {
    "cache-control": "no-store",
  });
}

export function notFound(): Response {
  return json({ error: "not_found" }, 404);
}

export function methodNotAllowed(allow: string[]): Response {
  return json({ error: "method_not_allowed" }, 405, { allow: allow.join(", ") });
}
