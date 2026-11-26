import { describe, expect, it, vi } from "vitest";
import type { Order } from "../src/api/orders";
import { type AgentInput, respond } from "../src/conversations/agent";
import { type AiLike, parseChatResult } from "../src/conversations/llm";

const ALICE = { sub: "auth0|alice", scopes: ["orders:read"] };

const ORDERS: Order[] = [
  {
    id: "ord_1042",
    created_at: "2026-10-02T09:12:00Z",
    status: "delivered",
    items: [{ sku: "mug", name: "Poppy mug", quantity: 1, price: 12 }],
    total: 12,
    currency: "USD",
    returns: [],
  },
];

/** What a Workers AI chat model answers. */
const say = (content: string) => ({ choices: [{ index: 0, message: { role: "assistant", content, tool_calls: null }, finish_reason: "stop" }] });
const call = (name: string, args: unknown = {}, id = "call_1") => ({
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{ id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } }],
      },
      finish_reason: "tool_calls",
    },
  ],
});

/** A fake model that answers with these, in order, and records what it was sent. */
function fakeAi(...answers: unknown[]) {
  const inputs: any[] = [];
  const ai: AiLike = {
    async run(model, input) {
      inputs.push({ model, ...(input as object) });
      const next = answers.shift();
      if (next instanceof Error) throw next;
      if (next === undefined) throw new Error("the fake model has no more answers");
      return next;
    },
  };
  return { ai, inputs };
}

function input(ai: AiLike, o: Partial<AgentInput> = {}): AgentInput & { loadOrders: ReturnType<typeof vi.fn> } {
  const loadOrders = vi.fn(async () => ORDERS);
  return {
    text: "hello",
    account: null,
    direct: false,
    userAvailable: null,
    loadOrders,
    llm: { ai, model: "@cf/test/model" },
    ...o,
  } as AgentInput & { loadOrders: ReturnType<typeof vi.fn> };
}

const toolMessages = (i: any) => i.messages.filter((m: any) => m.role === "tool");

describe("the Company Agent's model", () => {
  it("answers in the model's words, with the shop's rules and tools", async () => {
    const { ai, inputs } = fakeAi(say("Hi! How can I help?"));
    const out = await respond(input(ai, { text: "hello, who are you?" }));
    expect(out.replies).toEqual([{ text: "Hi! How can I help?" }]);
    expect(out.authorization).toBeUndefined();
    expect(inputs[0].model).toBe("@cf/test/model");
    expect(inputs[0].messages[0]).toMatchObject({ role: "system" });
    expect(inputs[0].messages[0].content).toMatch(/Never invent/);
    expect(inputs[0].messages.at(-1)).toEqual({ role: "user", content: "hello, who are you?" });
    expect(inputs[0].tools.map((t: any) => t.function.name)).toEqual([
      "list_products",
      "get_orders",
      "get_returnable_items",
      "request_order_cancellation",
    ]);
  });

  it("knows whether it is talking with the customer themselves", async () => {
    const a = fakeAi(say("x"));
    await respond(input(a.ai, { direct: true }));
    expect(a.inputs[0].messages[0].content).toMatch(/with the customer themselves/);
    const b = fakeAi(say("x"));
    await respond(input(b.ai, { direct: false }));
    expect(b.inputs[0].messages[0].content).toMatch(/personal agent/);
  });

  it("sends the conversation so far", async () => {
    const { ai, inputs } = fakeAi(say("Yes."));
    await respond(
      input(ai, {
        text: "and in large?",
        history: [
          { role: "user", text: "do you have tees?" },
          { role: "assistant", text: "Yes, a medium." },
        ],
      }),
    );
    expect(inputs[0].messages.slice(1).map((m: any) => [m.role, m.content])).toEqual([
      ["user", "do you have tees?"],
      ["assistant", "Yes, a medium."],
      ["user", "and in large?"],
    ]);
  });

  it("calls a tool, gives the model its result, and returns the model's answer with the data", async () => {
    const { ai, inputs } = fakeAi(call("list_products"), say("We sell tees, a mug and a jacket."));
    const out = await respond(input(ai, { text: "what do you sell?" }));
    expect(out.replies[0]?.text).toBe("We sell tees, a mug and a jacket.");
    expect((out.replies[0]?.data as any).products.map((p: any) => p.sku)).toContain("mug");

    const second = inputs[1].messages;
    // the assistant's tool call has string content: the model's schema refuses null
    expect(second.at(-2)).toMatchObject({ role: "assistant", content: "", tool_calls: [{ id: "call_1", function: { name: "list_products" } }] });
    expect(second.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call_1", name: "list_products" });
    expect(second.at(-1).content).toContain("Poppy mug");
  });

  it("asks for sign-in through the protocol when an answer needs the account, whatever the model writes", async () => {
    const i = input(fakeAi(call("get_orders"), say("Sure, one moment!")).ai, { text: "where is my package?" });
    const out = await respond(i);
    expect(out.authorization).toEqual(["orders:read"]);
    expect(out.replies[0]?.text).toBe("Sure, one moment!");
    expect(i.loadOrders).not.toHaveBeenCalled();
  });

  it("tells the model to ask for sign-in, and doesn't leave the reply empty", async () => {
    const { ai, inputs } = fakeAi(call("get_orders"), say(""));
    const out = await respond(input(ai));
    expect(toolMessages(inputs[1])[0].content).toMatch(/sign in and allow orders:read/);
    expect(out.authorization).toEqual(["orders:read"]);
    expect(out.replies[0]?.text).toMatch(/signs in and allows orders:read/);
  });

  it("reads the orders of the caller's own account, never one the model names", async () => {
    const i = input(fakeAi(call("get_orders", { account: "auth0|bob", sub: "auth0|bob" }), say("Your last order is delivered.")).ai, { account: ALICE });
    const out = await respond(i);
    expect(i.loadOrders).toHaveBeenCalledOnce();
    expect(i.loadOrders).toHaveBeenCalledWith("auth0|alice");
    expect(out.authorization).toBeUndefined();
    expect((out.replies[0]?.data as any).orders[0]).toMatchObject({ id: "ord_1042", status: "delivered" });
  });

  it("won't read orders without orders:read, even signed in", async () => {
    const i = input(fakeAi(call("get_orders"), say("x")).ai, { account: { sub: "auth0|alice", scopes: ["orders:write"] } });
    const out = await respond(i);
    expect(out.authorization).toEqual(["orders:read"]);
    expect(i.loadOrders).not.toHaveBeenCalled();
  });

  it("lists what can still be returned, with the operation that returns it", async () => {
    const out = await respond(input(fakeAi(call("get_returnable_items"), say("The mug from ord_1042.")).ai, { account: ALICE }));
    const data = out.replies[0]?.data as any;
    expect(data.returnable).toEqual([{ order_id: "ord_1042", sku: "mug", name: "Poppy mug" }]);
    expect(data.operation).toEqual({ type: "openapi", operation_id: "requestReturn" });
  });

  describe("cancelling", () => {
    const cancel = (o: Partial<AgentInput>) => respond(input(fakeAi(call("request_order_cancellation", { order_id: "ord_1042" }), say("ok")).ai, o));

    it("asks for the customer, with a user_requested event", async () => {
      expect((await cancel({})).userRequested).toMatch(/customer's own confirmation/);
    });

    it("doesn't ask again once the customer says they're not available", async () => {
      expect((await cancel({ userAvailable: false })).userRequested).toBeUndefined();
    });

    it("doesn't ask the customer who is already there", async () => {
      const { ai, inputs } = fakeAi(call("request_order_cancellation", {}), say("They ship within a day, but you can return it."));
      const out = await respond(input(ai, { direct: true }));
      expect(out.userRequested).toBeUndefined();
      expect(toolMessages(inputs[1])[0].content).toMatch(/can't be cancelled/);
    });
  });

  it("survives a tool the model made up and arguments that aren't JSON", async () => {
    const { ai, inputs } = fakeAi(call("drop_tables", "{not json"), call("list_products", "{oops", "call_2"), say("Done."));
    const out = await respond(input(ai));
    expect(out.replies[0]?.text).toBe("Done.");
    expect(toolMessages(inputs[1])[0].content).toMatch(/unknown_tool/);
  });

  it("makes the model answer with what it has after a few rounds of tools", async () => {
    const { ai, inputs } = fakeAi(...Array.from({ length: 4 }, () => call("list_products")), say("Enough looking."));
    const out = await respond(input(ai));
    // four rounds with tools, then a call without them
    expect(inputs).toHaveLength(5);
    expect(inputs[3].tools).toBeDefined();
    expect(inputs[4].tools).toBeUndefined();
    expect(out.replies[0]?.text).toBe("Enough looking.");
  });

  it("falls back to the script if the model still wants tools when it has none", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ai } = fakeAi(...Array.from({ length: 5 }, () => call("list_products")));
    const out = await respond(input(ai, { text: "What products do you sell?" }));
    expect(out.replies[0]?.text).toMatch(/We sell: /);
    log.mockRestore();
  });

  it("cuts a long reply", async () => {
    const out = await respond(input(fakeAi(say("a".repeat(5000))).ai));
    expect(out.replies[0]?.text).toHaveLength(2000);
  });
});

describe("when the model can't answer, the script does", () => {
  const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});

  it("answers from the script without a model", async () => {
    const out = await respond({ ...input(fakeAi().ai, { text: "What products do you sell?" }), llm: undefined });
    expect(out.replies[0]?.text).toMatch(/Poppy mug/);
  });

  it("answers from the script when the model fails, like when its free allowance is spent", async () => {
    const log = quiet();
    const out = await respond(input(fakeAi(new Error("4006: you have used up your daily free allocation")).ai, { text: "What products do you sell?" }));
    expect(out.replies[0]?.text).toMatch(/We sell: /);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("answers from the script when the model says nothing at all", async () => {
    const log = quiet();
    const out = await respond(input(fakeAi(say("")).ai, { text: "What products do you sell?" }));
    expect(out.replies[0]?.text).toMatch(/We sell: /);
    log.mockRestore();
  });

  it("keeps the script's events when it answers a sign-in question", async () => {
    const log = quiet();
    const out = await respond(input(fakeAi(new Error("down")).ai, { text: "where is my order?" }));
    expect(out.authorization).toEqual(["orders:read"]);
    log.mockRestore();
  });
});

describe("parseChatResult", () => {
  it("reads an OpenAI-style answer", () => {
    expect(parseChatResult(call("get_orders", { a: 1 }))).toEqual({
      content: "",
      toolCalls: [{ id: "call_1", type: "function", function: { name: "get_orders", arguments: '{"a":1}' } }],
    });
  });

  it("reads the older shape, with arguments as an object and no id", () => {
    expect(parseChatResult({ response: "hm", tool_calls: [{ name: "list_products", arguments: { x: 1 } }] })).toEqual({
      content: "hm",
      toolCalls: [{ id: "call_0", type: "function", function: { name: "list_products", arguments: '{"x":1}' } }],
    });
  });

  it("reads nothing as an empty answer", () => {
    for (const out of [null, undefined, "x", {}, { choices: [] }, { choices: [{}] }]) {
      expect(parseChatResult(out)).toEqual({ content: "", toolCalls: [] });
    }
  });
});
