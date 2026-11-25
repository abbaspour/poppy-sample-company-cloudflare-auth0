/**
 * The scopes the Company offers Personal Agents, with the descriptions and hints poppy.json
 * publishes (§4.7) and the OpenAPI security scheme repeats.
 */
export const SCOPES = {
  "orders:read": {
    description: "See your orders and returns. Needed to track an order or find one to return",
    hints: { changes: "none", personal_data: true },
  },
  "orders:write": {
    description: "Place orders from your cart and return items. Needed for any change to an order",
    hints: { changes: "irreversible", personal_data: true },
  },
} as const;

export const SCOPE_NAMES = Object.keys(SCOPES);

/**
 * The one scope the protocol defines (§6): a signed-in browser join needs it. The website applies
 * the agent's scopes, as the APIs do, so it allows nothing beyond the token's other scopes and the
 * Company needn't ask the User to approve it separately. It isn't an API scope, so it's not in SCOPES.
 */
export const BROWSER_SIGN_IN = {
  name: "poppy:browser-sign-in",
  description: "Use the website on your behalf, with the permissions you approve",
} as const;
