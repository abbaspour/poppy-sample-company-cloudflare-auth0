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
