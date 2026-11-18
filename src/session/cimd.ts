import type { JWK } from "jose";

/** A Personal Agent's client metadata document (§4.1, CIMD draft) and its public keys. */
export interface ClientMetadata {
  client_id: string;
  client_name?: string;
  jwks_uri: string;
  redirect_uris?: string[];
  [key: string]: unknown;
}

export interface ClientKeys {
  metadata: ClientMetadata;
  keys: JWK[];
}

export interface FetchOptions {
  fetch: typeof fetch;
  /** local development only: allow http to loopback hosts */
  allowHttp: boolean;
  /** skip the cache, eg. when a delegation names a kid the cached key set doesn't have */
  refresh?: boolean;
}

export class ClientMetadataError extends Error {}

const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { expires: number; value: ClientKeys }>();

/** For tests. */
export function clearClientCache(): void {
  cache.clear();
}

const PRIVATE_HOST =
  /^(localhost|127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[)/i;

/**
 * §3: every URL must be HTTPS, and a Company must not connect to loopback, private or link-local
 * addresses a Personal Agent gave it unless configured to on purpose.
 */
export function checkUrl(raw: string, allowHttp: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ClientMetadataError(`not a URL: ${raw}`);
  }
  const local = /^(localhost|127\.0\.0\.1)$/.test(url.hostname);
  if (url.protocol === "https:") {
    if (PRIVATE_HOST.test(url.hostname) && !allowHttp) {
      throw new ClientMetadataError(`refusing a private or loopback address: ${raw}`);
    }
  } else if (!(url.protocol === "http:" && allowHttp && local)) {
    throw new ClientMetadataError(`not an HTTPS URL: ${raw}`);
  }
  if (url.username || url.password || url.hash) {
    throw new ClientMetadataError(`URL has credentials or a fragment: ${raw}`);
  }
  return url;
}

function sameDomain(a: URL, b: URL): boolean {
  const x = a.hostname.toLowerCase();
  const y = b.hostname.toLowerCase();
  return x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`);
}

async function getJson(url: URL, opts: FetchOptions): Promise<unknown> {
  // CIMD §5 and Poppy §5.3: fetch without following redirects
  const res = await opts.fetch(url.toString(), {
    headers: { accept: "application/json" },
    redirect: "manual",
  });
  if (res.status !== 200) {
    throw new ClientMetadataError(`GET ${url} returned HTTP ${res.status}`);
  }
  try {
    return await res.json();
  } catch {
    throw new ClientMetadataError(`GET ${url} didn't return JSON`);
  }
}

/** Fetches and checks the client metadata at clientId and the key set at its jwks_uri (§4.1). */
export async function getClientKeys(clientId: string, opts: FetchOptions): Promise<ClientKeys> {
  const cached = cache.get(clientId);
  if (cached && !opts.refresh && cached.expires > Date.now()) return cached.value;

  const clientUrl = checkUrl(clientId, opts.allowHttp);
  const metadata = (await getJson(clientUrl, opts)) as ClientMetadata;
  if (typeof metadata !== "object" || metadata === null) {
    throw new ClientMetadataError("client metadata isn't a JSON object");
  }
  if (metadata.client_id !== clientId) {
    throw new ClientMetadataError(`client_id in the metadata isn't the URL it was fetched from`);
  }
  if (typeof metadata.jwks_uri !== "string") {
    throw new ClientMetadataError("client metadata has no jwks_uri");
  }
  const jwksUrl = checkUrl(metadata.jwks_uri, opts.allowHttp);
  if (!sameDomain(jwksUrl, clientUrl)) {
    throw new ClientMetadataError("jwks_uri isn't on the same domain as client_id");
  }

  const jwks = (await getJson(jwksUrl, opts)) as { keys?: JWK[] };
  if (!Array.isArray(jwks?.keys)) {
    throw new ClientMetadataError("jwks_uri didn't return a key set");
  }
  // the key set contains only public keys (§4.1); ignore anything else
  const keys = jwks.keys.filter((k) => typeof k === "object" && k !== null && !("d" in k));

  const value = { metadata, keys };
  cache.set(clientId, { expires: Date.now() + TTL_MS, value });
  return value;
}
