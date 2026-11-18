import { PRODUCTS } from "../api/shop";
import type { Order } from "../api/orders";

/**
 * A scripted Company Agent, standing in for a real one so the conversation protocol (§8) can be
 * shown end to end. It picks a reply by keyword, and asks for sign-in with an `authorization`
 * event when an answer needs the account (§8.11). Signed out, it answers general questions.
 */

export interface AgentInput {
  text: string;
  /** the account and scopes of the request that sent the message, if signed in */
  account: { sub: string; scopes: string[] } | null;
  /** this is a Direct Conversation: the User is talking themselves (§8.10) */
  direct: boolean;
  /** context.user_available, as last shared (§8.4) */
  userAvailable: boolean | null;
  loadOrders: (account: string) => Promise<Order[]>;
}

export interface AgentReply {
  text: string;
  data?: Record<string, unknown>;
}

export interface AgentOutput {
  replies: AgentReply[];
  /** scopes the answer needs: becomes an `authorization` event (§8.11) */
  authorization?: string[];
  /** ask to talk with the User directly: becomes a `user_requested` event (§8.10) */
  userRequested?: string;
}

const has = (text: string, ...words: string[]) => words.some((w) => new RegExp(`\\b${w}`, "i").test(text));

function needs(input: AgentInput, scope: string): boolean {
  return !input.account?.scopes.includes(scope);
}

function signInFor(scope: string, what: string): AgentOutput {
  return {
    authorization: [scope],
    replies: [{ text: `I can ${what} once the User signs in and allows ${scope}.` }],
  };
}

export async function respond(input: AgentInput): Promise<AgentOutput> {
  const text = input.text;

  if (has(text, "cancel")) {
    if (input.direct) {
      return {
        replies: [
          {
            text: "Thanks for confirming. Orders here ship within a day, so they can't be cancelled, but every item can be returned after delivery. Would you like that instead?",
          },
        ],
      };
    }
    if (input.userAvailable === false) {
      return {
        replies: [{ text: "Cancelling needs the customer's own confirmation. Let me know when they're available." }],
      };
    }
    return {
      userRequested: "Cancelling an order needs the customer's own confirmation.",
      replies: [{ text: "I need to confirm a cancellation with the customer directly. Can you bring them in?" }],
    };
  }

  if (has(text, "return")) {
    if (needs(input, "orders:read")) return signInFor("orders:read", "find the orders that can be returned");
    const orders = (await input.loadOrders(input.account!.sub)).filter((o) => o.status === "delivered");
    const items = orders.flatMap((o) =>
      o.items.filter((i) => !o.returns.some((r) => r.sku === i.sku)).map((i) => ({ order_id: o.id, sku: i.sku, name: i.name })),
    );
    return {
      replies: [
        {
          text: items.length
            ? `These items can be returned: ${items.map((i) => `${i.name} from ${i.order_id}`).join("; ")}. Request a return with the requestReturn operation, which needs orders:write.`
            : "There's nothing left to return in the delivered orders.",
          data: { returnable: items, operation: { type: "openapi", operation_id: "requestReturn" } },
        },
      ],
    };
  }

  if (has(text, "order", "track", "deliver", "package", "ship")) {
    if (needs(input, "orders:read")) return signInFor("orders:read", "look up the User's orders");
    const orders = await input.loadOrders(input.account!.sub);
    const latest = orders[0];
    return {
      replies: [
        {
          text: latest
            ? `The latest order is ${latest.id}, placed ${latest.created_at.slice(0, 10)}: ${latest.status}, ${latest.total} ${latest.currency}. There are ${orders.length} orders in all.`
            : "There are no orders on this account yet.",
          data: { orders: orders.map((o) => ({ id: o.id, status: o.status, total: o.total, created_at: o.created_at })) },
        },
      ],
    };
  }

  if (has(text, "product", "sell", "price", "stock", "size", "jacket", "shirt", "tee", "mug", "buy")) {
    return {
      replies: [
        {
          text: `We sell: ${PRODUCTS.map((p) => `${p.name} (${p.price} ${p.currency})`).join("; ")}. Anything can go in the cart without signing in.`,
          data: { products: PRODUCTS },
        },
      ],
    };
  }

  if (has(text, "person", "human", "someone", "representative", "staff")) {
    return {
      replies: [
        {
          text: "You can ask for a person with a handoff request. This is a demo shop with no staff, though, so no one will join.",
        },
      ],
    };
  }

  return {
    replies: [
      {
        text: input.direct
          ? "Hi! How can I help?"
          : "I can help with products, the status of orders, and returns. Order questions need the User to sign in.",
      },
    ],
  };
}

/** The Company's first message in a Direct Conversation it asked for (§8.10). */
export function directGreeting(reason: string | null): AgentReply {
  return {
    text: reason
      ? `Hi, this is the Poppy Sample Shop assistant. Thanks for joining. ${reason} Can you confirm what you'd like to do?`
      : "Hi, this is the Poppy Sample Shop assistant. How can I help?",
  };
}
