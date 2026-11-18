import { type Env, companyOrigin, issuer } from "../env";
import { SCOPES } from "../scopes";

/**
 * GET /openapi.json, the description poppy.json lists in apis[] (§7). Its servers URL is where
 * Personal Agents send Session headers (§5.2). Operations with an empty `security` work signed
 * out; the order operations name the OAuth scopes they need, which the agent requests at sign-in
 * (§4.7). They're listed only when the Company has an issuer.
 */
export function openapi(env: Env): Record<string, unknown> {
  const sessionHeader = { $ref: "#/components/parameters/PoppySession" };
  const versionHeader = { $ref: "#/components/parameters/PoppyVersion" };
  const iss = issuer(env);
  const oauth = (scope: string) => [{ oauth2: [scope] }];
  const json = (properties: Record<string, unknown>, required: string[] = []) => ({
    required: true,
    content: { "application/json": { schema: { type: "object", required, properties } } },
  });
  const errors = {
    "400": { description: "invalid_session, session_ended or version_unsupported", content: errorContent() },
  };
  return {
    openapi: "3.1.0",
    info: {
      title: `${env.COMPANY_NAME} API`,
      version: "0.1.0",
      description: "Sample API for the Personal Agent Protocol. Every request carries a Poppy-Session header.",
    },
    servers: [{ url: `${companyOrigin(env)}/api` }],
    paths: {
      "/products": {
        get: {
          operationId: "listProducts",
          summary: "List products",
          security: [],
          parameters: [sessionHeader, versionHeader],
          responses: { "200": { description: "Products" }, ...errors },
        },
      },
      "/cart": {
        get: {
          operationId: "getCart",
          summary: "The Session's cart",
          security: [],
          parameters: [sessionHeader, versionHeader],
          responses: { "200": { description: "Cart" }, ...errors },
        },
        delete: {
          operationId: "emptyCart",
          summary: "Empty the Session's cart",
          security: [],
          parameters: [sessionHeader, versionHeader],
          responses: { "200": { description: "Cart" }, ...errors },
        },
      },
      "/cart/items": {
        post: {
          operationId: "addToCart",
          summary: "Add a product to the Session's cart",
          security: [],
          parameters: [sessionHeader, versionHeader],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["sku"],
                  properties: { sku: { type: "string" }, quantity: { type: "integer", minimum: 1, default: 1 } },
                },
              },
            },
          },
          responses: { "201": { description: "Cart" }, ...errors },
        },
      },
      "/session": {
        get: {
          operationId: "getSession",
          summary: "What the Company knows about this Session (for debugging)",
          security: [],
          parameters: [sessionHeader, versionHeader],
          responses: { "200": { description: "Session" }, ...errors },
        },
        delete: {
          operationId: "endSession",
          summary: "End this Session, so its next request gets session_ended (for testing)",
          security: [],
          parameters: [sessionHeader, versionHeader],
          responses: { "204": { description: "Ended" }, ...errors },
        },
      },
      ...(iss ? orderPaths() : {}),
    },
    components: {
      ...(iss
        ? {
            securitySchemes: {
              oauth2: {
                type: "oauth2",
                flows: {
                  authorizationCode: {
                    authorizationUrl: `${iss}authorize`,
                    tokenUrl: `${iss}oauth/token`,
                    scopes: Object.fromEntries(Object.entries(SCOPES).map(([k, v]) => [k, v.description])),
                  },
                },
              },
            },
          }
        : {}),
      parameters: {
        PoppySession: {
          name: "Poppy-Session",
          in: "header",
          required: true,
          description: "Session JWT signed for this request (Poppy §5.2)",
          schema: { type: "string" },
        },
        PoppyVersion: {
          name: "Poppy-Version",
          in: "header",
          required: true,
          schema: { type: "string", example: "1.0" },
        },
      },
    },
  };

  function orderPaths() {
    const signedIn = { "401": { description: "Sign-in needed" }, "403": { description: "insufficient_scope" } };
    return {
      "/orders": {
        get: {
          operationId: "listOrders",
          summary: "List the account's orders",
          security: oauth("orders:read"),
          parameters: [sessionHeader, versionHeader],
          responses: { "200": { description: "Orders" }, ...signedIn, ...errors },
        },
        post: {
          operationId: "checkout",
          summary: "Place an order from the Session's cart",
          security: oauth("orders:write"),
          parameters: [sessionHeader, versionHeader],
          responses: { "201": { description: "The new order" }, ...signedIn, ...errors },
        },
      },
      "/orders/{id}": {
        get: {
          operationId: "getOrder",
          summary: "One order, with its returns",
          security: oauth("orders:read"),
          parameters: [sessionHeader, versionHeader, { name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Order" }, "404": { description: "No such order" }, ...signedIn, ...errors },
        },
      },
      "/orders/{id}/returns": {
        post: {
          operationId: "requestReturn",
          summary: "Request a return of one item of a delivered order",
          security: oauth("orders:write"),
          parameters: [sessionHeader, versionHeader, { name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: json({ sku: { type: "string" }, reason: { type: "string" } }, ["sku"]),
          responses: { "201": { description: "The return" }, ...signedIn, ...errors },
        },
      },
    };
  }
}

function errorContent() {
  return {
    "application/json": {
      schema: {
        type: "object",
        properties: { error: { type: "string" }, error_description: { type: "string" } },
      },
    },
  };
}
