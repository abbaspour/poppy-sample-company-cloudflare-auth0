import { describe, expect, it } from "vitest";
import { classifyVisitor } from "../src/web/identity";
import { renderHome } from "../src/web/page";

const ACT = {
  sub: "agt_gZameUasxQq5wLiFTW7rxF",
  sub_profile: "ai_agent",
  client_id: "tpc_4fR8kLm2QwZx7NbV1sYt3P",
  iss: "https://auth.example.com/",
  poppy_sid: "g4B43922Ut9eOkjgDb7xFA",
  poppy_user_id: "n9YYwSTyEXoeF1tr3Yr_-A",
  poppy_agent_id: "shopping",
};

describe("classifyVisitor", () => {
  it("is signed out without a session", () => {
    expect(classifyVisitor(null)).toEqual({ kind: "signed_out" });
    expect(classifyVisitor(undefined)).toEqual({ kind: "signed_out" });
  });

  it("is a user for a normal login", () => {
    expect(classifyVisitor({ sub: "auth0|alice", name: "Alice", email: "alice@example.com" })).toEqual({
      kind: "user",
      subject: "auth0|alice",
      name: "Alice",
      email: "alice@example.com",
    });
  });

  it("is an agent for a user when a Poppy act joins a user's login", () => {
    const v = classifyVisitor({ sub: "auth0|alice", email: "alice@example.com", act: ACT });
    expect(v.kind).toBe("agent_for_user");
    expect(v.subject).toBe("auth0|alice");
    expect(v.agent).toEqual({
      id: ACT.sub,
      clientId: ACT.client_id,
      sessionId: ACT.poppy_sid,
      userId: ACT.poppy_user_id,
      agentId: "shopping",
    });
  });

  it("is an agent guest for an anonymous subject with a Poppy act, and never a user", () => {
    const v = classifyVisitor({ sub: "anon_poppy@z4eHq6", sub_profile: "user urn:auth0:anonymous_user", act: ACT });
    expect(v.kind).toBe("agent_guest");
    expect(v.agent?.sessionId).toBe(ACT.poppy_sid);
    expect(v.name).toBeUndefined();
    expect(v.email).toBeUndefined();
  });

  it("tells a guest by sub_profile, not by parsing sub", () => {
    expect(classifyVisitor({ sub: "anon_poppy@z4eHq6", act: ACT }).kind).toBe("agent_for_user");
    expect(classifyVisitor({ sub: "auth0|alice", sub_profile: "user urn:auth0:anonymous_user", act: ACT }).kind).toBe(
      "agent_guest",
    );
  });

  it("ignores an act that isn't Poppy's", () => {
    const v = classifyVisitor({ sub: "auth0|alice", act: { sub: "someone-else" } });
    expect(v.kind).toBe("user");
    expect(v.agent).toBeUndefined();
  });

  it("does not take an anonymous session without a Poppy agent for a signed-in user", () => {
    expect(classifyVisitor({ sub: "anon_x", sub_profile: "user urn:auth0:anonymous_user" }).kind).toBe("signed_out");
  });

  it("is signed out for claims without a subject", () => {
    expect(classifyVisitor({ name: "Alice" }).kind).toBe("signed_out");
  });
});

describe("renderHome", () => {
  const opts = { companyName: "Shop", loginEnabled: true };

  it("offers login when signed out, and logout otherwise", () => {
    expect(renderHome({ kind: "signed_out" }, opts)).toContain('href="/auth/login"');
    expect(renderHome({ kind: "user", subject: "auth0|a" }, opts)).toContain('href="/auth/logout"');
  });

  it("doesn't offer a guest the login page", () => {
    const html = renderHome(classifyVisitor({ sub: "anon_x", sub_profile: "urn:auth0:anonymous_user", act: ACT }), opts);
    expect(html).toContain('data-visitor-kind="agent_guest"');
    expect(html).not.toContain("/auth/login");
    expect(html).toContain(ACT.poppy_sid);
  });

  it("says login isn't configured instead of linking to a login that 404s", () => {
    const html = renderHome({ kind: "signed_out" }, { ...opts, loginEnabled: false });
    expect(html).not.toContain("/auth/login");
    expect(html).toContain("Login isn't configured");
  });

  it("escapes values that come from tokens", () => {
    const html = renderHome(
      { kind: "user", subject: "auth0|<script>alert(1)</script>", name: `"><img src=x onerror=alert(1)>` },
      opts,
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&#60;script&#62;");
  });
});
