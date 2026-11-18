import { ConversationObject } from "../src/conversations/object";
import type { Env } from "../src/env";

/** Just enough of KVNamespace for the Worker. */
export class MemoryKV {
  readonly data = new Map<string, string>();
  async get(key: string, type?: string) {
    const v = this.data.get(key);
    return v === undefined ? null : type === "json" ? JSON.parse(v) : v;
  }
  async put(key: string, value: string) {
    this.data.set(key, value);
  }
}

/** Durable Object storage in memory, with an alarm the test fires itself. */
class MemoryStorage {
  readonly data = new Map<string, unknown>();
  alarm: number | null = null;
  async get<T>(key: string): Promise<T | undefined> {
    const v = this.data.get(key);
    return v === undefined ? undefined : (structuredClone(v) as T);
  }
  async put(keyOrEntries: string | Record<string, unknown>, value?: unknown) {
    const entries = typeof keyOrEntries === "string" ? { [keyOrEntries]: value } : keyOrEntries;
    for (const [k, v] of Object.entries(entries)) this.data.set(k, structuredClone(v));
  }
  async setAlarm(time: number) {
    this.alarm = time;
  }
}

/** A DurableObjectNamespace that runs the real ConversationObject in memory. */
export class MemoryDurableObjects {
  readonly objects = new Map<string, { object: ConversationObject; storage: MemoryStorage }>();
  env!: Env;

  idFromName(name: string) {
    return { name, toString: () => name };
  }

  get(id: { name: string }) {
    let entry = this.objects.get(id.name);
    if (!entry) {
      const storage = new MemoryStorage();
      entry = { object: new ConversationObject({ storage } as unknown as DurableObjectState, this.env), storage };
      this.objects.set(id.name, entry);
    }
    const { object } = entry;
    return { fetch: (input: string, init?: RequestInit) => object.fetch(new Request(input, init)) };
  }

  /** Fires every alarm due by `now`, as the runtime would, until none are left. */
  async runAlarms(now = Date.now()): Promise<void> {
    for (let fired = true; fired; ) {
      fired = false;
      for (const { object, storage } of this.objects.values()) {
        if (storage.alarm !== null && storage.alarm <= now) {
          storage.alarm = null;
          await object.alarm();
          fired = true;
        }
      }
    }
  }
}

export function makeEnv(issuer: string): { env: Env; durableObjects: MemoryDurableObjects } {
  const durableObjects = new MemoryDurableObjects();
  const env: Env = {
    SESSIONS: new MemoryKV() as unknown as KVNamespace,
    CONVERSATIONS: durableObjects as unknown as DurableObjectNamespace,
    COMPANY_DOMAIN: "shop.example",
    COMPANY_NAME: "Test",
    AUTH0_ISSUER: issuer,
  };
  durableObjects.env = env;
  return { env, durableObjects };
}
