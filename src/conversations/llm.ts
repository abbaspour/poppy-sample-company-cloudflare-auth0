/**
 * A small client for Workers AI chat models with tool calling. The Worker's `AI` binding takes
 * OpenAI-style messages and tools, and answers with `choices[0].message`, whose `tool_calls` have
 * the arguments as a JSON string. Older models answer `{ response, tool_calls: [{ name, arguments }] }`
 * with the arguments as an object, so the answer is normalized from either.
 */

/** The cheapest function-calling chat model on Workers AI when this was written (0.45 neurons for a tool call). */
export const DEFAULT_MODEL = "@cf/ibm-granite/granite-4.0-h-micro";

/** What the code needs of the `AI` binding. */
export interface AiLike {
  run(model: string, input: unknown): Promise<unknown>;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  /** `content` is a string even when the assistant only calls tools: the schema refuses null */
  | { role: "assistant"; content: string; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; name: string; content: string };

export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The model's answer, whichever of the two shapes it came in. */
export function parseChatResult(out: unknown): ChatResult {
  const o = isRecord(out) ? out : {};
  const first = Array.isArray(o.choices) ? o.choices[0] : undefined;
  const message = isRecord(first) && isRecord(first.message) ? first.message : undefined;

  const text = message?.content ?? o.response;
  const rawCalls = message?.tool_calls ?? o.tool_calls;

  const toolCalls: ToolCall[] = [];
  if (Array.isArray(rawCalls)) {
    rawCalls.forEach((raw, i) => {
      if (!isRecord(raw)) return;
      const fn = isRecord(raw.function) ? raw.function : raw;
      if (typeof fn.name !== "string" || fn.name === "") return;
      const args = fn.arguments;
      toolCalls.push({
        id: typeof raw.id === "string" && raw.id !== "" ? raw.id : `call_${i}`,
        type: "function",
        function: { name: fn.name, arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) },
      });
    });
  }
  return { content: typeof text === "string" ? text : "", toolCalls };
}

/** One model call. Throws if the model can't be reached, which includes an exhausted free allowance. */
export async function chat(
  ai: AiLike,
  model: string,
  messages: ChatMessage[],
  tools: ToolDef[] | undefined,
): Promise<ChatResult> {
  const out = await ai.run(model, {
    messages,
    ...(tools && tools.length > 0 ? { tools } : {}),
    max_tokens: 400,
    temperature: 0.2,
  });
  return parseChatResult(out);
}

/** A tool call's arguments, as an object. A model's malformed JSON is an empty one, never a crash. */
export function parseArguments(call: ToolCall): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(call.function.arguments || "{}");
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
