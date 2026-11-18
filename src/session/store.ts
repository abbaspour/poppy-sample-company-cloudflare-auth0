/**
 * A Session record (§5.3 step 4), found by client_id, sid and User ID. The Company decides how
 * long a Session lasts (§5.5); here, a day after its last request.
 */
export interface SessionRecord {
  client_id: string;
  sid: string;
  sub: string;
  agent_id: string | null;
  protocol_version: string;
  created_at: string;
  last_seen_at: string;
  requests: number;
  ended: boolean;
  /** the account a signed-in request used, so a second account can be refused (§5.4) */
  account: string | null;
  cart: CartItem[];
}

export interface CartItem {
  sku: string;
  quantity: number;
}

export interface SessionStore {
  get(key: string): Promise<SessionRecord | null>;
  put(key: string, record: SessionRecord): Promise<void>;
}

export const SESSION_TTL_SECONDS = 24 * 60 * 60;

export function sessionKey(clientId: string, sid: string, sub: string): string {
  return `session:${encodeURIComponent(clientId)}:${sid}:${encodeURIComponent(sub)}`;
}

export class KvSessionStore implements SessionStore {
  constructor(private readonly kv: KVNamespace) {}

  async get(key: string): Promise<SessionRecord | null> {
    return this.kv.get<SessionRecord>(key, "json");
  }

  async put(key: string, record: SessionRecord): Promise<void> {
    await this.kv.put(key, JSON.stringify(record), { expirationTtl: SESSION_TTL_SECONDS });
  }
}

/** In-memory store, for tests. */
export class MemorySessionStore implements SessionStore {
  readonly records = new Map<string, SessionRecord>();

  async get(key: string): Promise<SessionRecord | null> {
    const r = this.records.get(key);
    return r ? structuredClone(r) : null;
  }

  async put(key: string, record: SessionRecord): Promise<void> {
    this.records.set(key, structuredClone(record));
  }
}
