import { openapi } from "./api/openapi";
import { checkout, getOrder, listOrders, requestReturn } from "./api/orders";
import { addToCart, emptyCart, endSession, getCart, getSession, listProducts } from "./api/shop";
import {
  CONVERSATIONS_PATH,
  cancelHandoff,
  closeConversation,
  readEvents,
  requestHandoff,
  sendMessage,
  startConversation,
} from "./conversations/routes";
import { poppyJson } from "./discovery/poppy-json";
import { protectedResource } from "./discovery/protected-resource";
import type { Env } from "./env";
import { json } from "./http";
import { type Deps, type Route, route } from "./router";
import { SKILL_PATH, getSkill, getTasks, postFeedback } from "./tasks/tasks";

export { ConversationObject } from "./conversations/object";

/** API routes. Each verifies the Session header (§5.3); those with a scope also need the account (§7). */
export const ROUTES: Route[] = [
  { method: "GET", path: "/api/products", handler: () => listProducts() },
  { method: "GET", path: "/api/cart", handler: getCart },
  { method: "DELETE", path: "/api/cart", handler: emptyCart },
  { method: "POST", path: "/api/cart/items", handler: addToCart },
  { method: "GET", path: "/api/session", handler: getSession },
  { method: "DELETE", path: "/api/session", handler: endSession },
  { method: "GET", path: "/api/orders", scope: "orders:read", handler: listOrders },
  { method: "POST", path: "/api/orders", scope: "orders:write", handler: checkout },
  { method: "GET", path: "/api/orders/:id", scope: "orders:read", handler: getOrder },
  { method: "POST", path: "/api/orders/:id/returns", scope: "orders:write", handler: requestReturn },
  // §9: same for every Session; no access token
  { method: "GET", path: "/poppy/tasks", handler: getTasks },
  { method: "POST", path: "/poppy/feedback", handler: postFeedback },
  // §8.2: conversations check ownership and account use themselves
  { method: "POST", path: CONVERSATIONS_PATH, handler: startConversation },
  { method: "POST", path: `${CONVERSATIONS_PATH}/:id/messages`, handler: sendMessage },
  { method: "GET", path: `${CONVERSATIONS_PATH}/:id/events`, handler: readEvents },
  { method: "POST", path: `${CONVERSATIONS_PATH}/:id/handoff`, handler: requestHandoff },
  { method: "POST", path: `${CONVERSATIONS_PATH}/:id/handoff/cancel`, handler: cancelHandoff },
  { method: "POST", path: `${CONVERSATIONS_PATH}/:id/close`, handler: closeConversation },
];

export async function handle(request: Request, env: Env, deps: Deps): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  // discovery and description documents carry no Session header (§5.2)
  switch (path) {
    case "/.well-known/poppy.json":
      return json(poppyJson(env), 200, { "cache-control": "public, max-age=300" });
    case "/.well-known/oauth-protected-resource":
      return protectedResource(env);
    case "/openapi.json":
      return json(openapi(env), 200, { "cache-control": "public, max-age=300" });
    case SKILL_PATH:
      return getSkill();
    case "/":
      return json({ name: env.COMPANY_NAME, poppy: "/.well-known/poppy.json" });
  }

  return route(ROUTES, request, env, path, deps);
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env, { fetch: (input, init) => fetch(input, init) });
  },
} satisfies ExportedHandler<Env>;
