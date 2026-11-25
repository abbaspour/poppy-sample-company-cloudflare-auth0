import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { createApp } from "../src/web/app";
import { makeEnv } from "./fakes";

const ISSUER = "https://shop-auth.example/";
const ORIGIN = "https://shop.example";

const rest = vi.fn(async (request: Request) => new Response(`rest:${new URL(request.url).pathname}`, { status: 202 }));
const app = createApp(rest);

/** An env with login configured. makeEnv's issuer is what the Poppy side checks; login adds its own settings. */
function webEnv(extra: Partial<Env> = {}): Env {
  return {
    ...makeEnv(ISSUER).env,
    AUTH0_CLIENT_ID: "web-client",
    AUTH0_CLIENT_SECRET: "web-secret",
    AUTH0_SESSION_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
    ...extra,
  };
}

function get(path: string, env: Env, headers: HeadersInit = {}) {
  return app.fetch(new Request(`${ORIGIN}${path}`, { headers }), env);
}

beforeEach(() => {
  rest.mockClear();
});

describe("GET /", () => {
  it("is an HTML page for a browser, signed out", async () => {
    const res = await get("/", webEnv(), { accept: "text/html" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const html = await res.text();
    expect(html).toContain('data-visitor-kind="signed_out"');
    expect(html).toContain('href="/auth/login"');
    expect(rest).not.toHaveBeenCalled();
  });

  it("is JSON for a client that doesn't ask for HTML, and names the Company as before", async () => {
    const res = await get("/", webEnv(), { accept: "application/json" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; poppy: string; visitor: { kind: string } };
    expect(body.name).toBe("Test");
    expect(body.poppy).toBe("/.well-known/poppy.json");
    expect(body.visitor).toEqual({ kind: "signed_out" });
  });

  it("works with login not configured, and says so", async () => {
    const env = { ...webEnv(), AUTH0_CLIENT_SECRET: undefined };
    const html = await (await get("/", env, { accept: "text/html" })).text();
    expect(html).toContain('data-visitor-kind="signed_out"');
    expect(html).not.toContain("/auth/login");
  });
});

describe("everything else is the Poppy Company", () => {
  it.each(["/.well-known/poppy.json", "/.well-known/oauth-protected-resource", "/api/products", "/openapi.json", "/nothing"])(
    "passes %s through untouched",
    async (path) => {
      const res = await get(path, webEnv());
      expect(res.status).toBe(202);
      expect(await res.text()).toBe(`rest:${path}`);
    },
  );

  it("passes /auth/* through when login isn't configured", async () => {
    const res = await get("/auth/login", { ...webEnv(), AUTH0_CLIENT_ID: undefined });
    expect(res.status).toBe(202);
  });
});

describe("/auth/login", () => {
  it("redirects to Auth0 with the Company's audience and the callback", async () => {
    const authorize = new URL(`${ISSUER}authorize`);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
      if (url.pathname.endsWith("/.well-known/openid-configuration")) {
        return Response.json({
          issuer: ISSUER,
          authorization_endpoint: authorize.href,
          token_endpoint: `${ISSUER}oauth/token`,
          jwks_uri: `${ISSUER}.well-known/jwks.json`,
          end_session_endpoint: `${ISSUER}oidc/logout`,
        });
      }
      return new Response("unexpected", { status: 500 });
    });
    try {
      // its own client ID: auth0() captures `fetch` when it is first built, which must be after the mock
      const res = await get("/auth/login", webEnv({ AUTH0_CLIENT_ID: "web-client-login" }));
      expect(res.status).toBe(302);
      const location = new URL(res.headers.get("location") as string);
      expect(location.origin + location.pathname).toBe(authorize.href);
      expect(location.searchParams.get("client_id")).toBe("web-client-login");
      expect(location.searchParams.get("audience")).toBe(ORIGIN);
      expect(location.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/callback`);
      expect(location.searchParams.get("scope")).toContain("orders:read");
      expect(rest).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });
});
