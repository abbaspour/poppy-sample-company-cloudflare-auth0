import { describe, expect, it } from "vitest";
import { poppyJson } from "../src/discovery/poppy-json";
import { protectedResource } from "../src/discovery/protected-resource";
import type { Env } from "../src/env";
import { makeEnv } from "./fakes";

const ISSUER = "https://auth.shop.example/";

function envWith(extra: Partial<Env>): Env {
  return { ...makeEnv(ISSUER).env, ...extra };
}

describe("browser join in discovery (§6)", () => {
  it("lists Auth0's join endpoint for the website's application, and the scope that signs in", () => {
    const doc = poppyJson(envWith({ AUTH0_CLIENT_ID: "web client" })) as {
      web: Record<string, unknown>;
      auth: { scopes: Record<string, string> };
    };
    expect(doc.web).toEqual({
      browser_session_endpoint: "https://auth.shop.example/poppy/web%20client/browser-session",
      unscoped: false,
    });
    expect(doc.auth.scopes["poppy:browser-sign-in"]).toMatch(/permissions you approve/);
  });

  it("lists the scope in the protected resource metadata too", async () => {
    const body = (await protectedResource(envWith({ AUTH0_CLIENT_ID: "web" })).json()) as { scopes_supported: string[] };
    expect(body.scopes_supported).toEqual(["orders:read", "orders:write", "poppy:browser-sign-in"]);
  });

  it("offers no browser join without the website's application, or without an issuer", async () => {
    const without = poppyJson(envWith({})) as { web?: unknown; auth: { scopes: Record<string, string> } };
    expect(without.web).toBeUndefined();
    expect(without.auth.scopes["poppy:browser-sign-in"]).toBeUndefined();
    const meta = (await protectedResource(envWith({})).json()) as { scopes_supported: string[] };
    expect(meta.scopes_supported).toEqual(["orders:read", "orders:write"]);

    const noIssuer = poppyJson(envWith({ AUTH0_ISSUER: "", AUTH0_CLIENT_ID: "web" })) as { web?: unknown; auth?: unknown };
    expect(noIssuer.web).toBeUndefined();
    expect(noIssuer.auth).toBeUndefined();
  });
});
