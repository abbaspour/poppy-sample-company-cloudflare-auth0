import { describe, expect, it } from "vitest";
import { LoginInitiationError, parseLoginInitiation } from "../src/web/join";

const o = { issuer: "https://auth.shop.example/", appOrigin: "https://shop.example" };
const parse = (query: string) => parseLoginInitiation(new URL(`https://shop.example/auth/login${query}`), o);

describe("parseLoginInitiation", () => {
  it("accepts an ordinary login with no iss", () => {
    expect(parse("")).toEqual({});
  });

  it("accepts our issuer, exactly, and a target on our own origin", () => {
    const iss = encodeURIComponent(o.issuer);
    const target = encodeURIComponent("https://shop.example/orders?x=1");
    expect(parse(`?iss=${iss}&target_link_uri=${target}`)).toEqual({ returnTo: "/orders?x=1" });
  });

  it("refuses an iss that is another issuer, lacks the trailing slash, is empty or repeated", () => {
    for (const q of [
      "?iss=https%3A%2F%2Fevil.example%2F",
      "?iss=https%3A%2F%2Fauth.shop.example",
      "?iss=",
      `?iss=${encodeURIComponent(o.issuer)}&iss=${encodeURIComponent(o.issuer)}`,
    ]) {
      expect(() => parse(q), q).toThrow(LoginInitiationError);
    }
  });

  it("drops a target_link_uri on another origin or that isn't a URL, and never follows it", () => {
    expect(parse("?target_link_uri=https%3A%2F%2Fevil.example%2Fx")).toEqual({});
    expect(parse("?target_link_uri=%2F%2Fevil.example%2Fx")).toEqual({});
    expect(parse("?target_link_uri=http%3A%2F%2F")).toEqual({});
    expect(parse("?target_link_uri=javascript%3Aalert(1)")).toEqual({});
  });

  it("takes a relative target_link_uri as being on our origin", () => {
    expect(parse("?target_link_uri=%2Forders")).toEqual({ returnTo: "/orders" });
  });
});
