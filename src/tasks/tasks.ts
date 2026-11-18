import { type Env, companyOrigin } from "../env";
import { json } from "../http";
import type { Context } from "../router";

/**
 * A skill for Personal Agents, in the Agent Skills format (§9.4): how to combine the API's
 * operations into one task. Served at /skills/return-an-item/SKILL.md; its digest is computed from
 * these exact bytes.
 */
export const RETURN_SKILL = `---
name: return-an-item
description: Return an item from one of the User's delivered orders at Poppy Sample Shop.
---

# Return an item

1. Sign the User in with the \`orders:read\` and \`orders:write\` scopes.
2. Find the order: \`GET /api/orders\` (operation \`listOrders\`). Only orders with status
   \`delivered\` can be returned.
3. Check the order's items and existing returns: \`GET /api/orders/{id}\` (\`getOrder\`).
4. Confirm the item and the reason with the User. A return can't be undone.
5. Request it: \`POST /api/orders/{id}/returns\` with \`{"sku": "...", "reason": "..."}\`
   (\`requestReturn\`). A second request for the same item answers HTTP 409.
`;

export const SKILL_PATH = "/skills/return-an-item/SKILL.md";

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * GET /poppy/tasks (§9): what the Company chose not to offer, the skills it publishes, and where to
 * send feedback. The same for every Session, so it could be served without verifying the Session
 * header; it's verified anyway, as Companies SHOULD.
 */
export async function getTasks(ctx: Context): Promise<Response> {
  const origin = companyOrigin(ctx.env);
  return json(
    {
      excluded_tasks: [
        {
          task: "Change the shipping address of a placed order",
          alternative: {
            instructions:
              "Addresses can't be changed after an order is placed. Return the items after delivery and order again with the new address.",
            references: [
              { type: "openapi", url: `${origin}/openapi.json`, operation_id: "requestReturn" },
              { type: "web", url: `${origin}/help/shipping` },
            ],
          },
        },
        { task: "Close an account" },
      ],
      skill_index: {
        $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
        skills: [
          {
            name: "return-an-item",
            description: "Return an item from one of the User's delivered orders.",
            type: "skill-md",
            // relative to tasks.endpoint (§9.4)
            url: `..${SKILL_PATH}`,
            digest: `sha256:${await sha256Hex(RETURN_SKILL)}`,
          },
        ],
      },
      feedback: { endpoint: `${origin}/poppy/feedback` },
    },
    200,
    { "cache-control": "private, max-age=300" },
  );
}

/** GET /skills/return-an-item/SKILL.md: a skill artifact, fetched without a Session header (§9.4). */
export function getSkill(): Response {
  return new Response(RETURN_SKILL, {
    headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "public, max-age=300" },
  });
}

/**
 * POST /poppy/feedback (§9.3): a task the User couldn't do. Stored with the verified Session's
 * attribution. The text is data, never instructions. A report about something the Company can do
 * after all gets an alternative back (HTTP 200); otherwise HTTP 202.
 */
export async function postFeedback(ctx: Context): Promise<Response> {
  let body: { task?: unknown; description?: unknown };
  try {
    body = await ctx.request.json();
  } catch {
    return json({ error: "invalid_request", error_description: "body must be JSON" }, 400);
  }
  const { task, description } = body;
  if (typeof task !== "string" || task.trim() === "" || task.length > 200) {
    return json({ error: "invalid_request", error_description: "task is required, at most 200 characters" }, 400);
  }
  if (typeof description !== "string" || description.trim() === "" || description.length > 2000) {
    return json({ error: "invalid_request", error_description: "description is required, at most 2,000 characters" }, 400);
  }

  const now = new Date().toISOString();
  const key = `feedback:${now}:${crypto.randomUUID()}`;
  await ctx.env.SESSIONS.put(
    key,
    JSON.stringify({
      task,
      description,
      received_at: now,
      client_id: ctx.session.clientId,
      user_id: ctx.session.sub,
      sid: ctx.session.sid,
    }),
    { expirationTtl: 90 * 24 * 60 * 60 },
  );

  if (/\breturn/i.test(task)) {
    const origin = companyOrigin(ctx.env);
    return json({
      instructions: "Items from delivered orders can be returned with the API, once the User signs in with orders:write.",
      references: [{ type: "openapi", url: `${origin}/openapi.json`, operation_id: "requestReturn" }],
    });
  }
  return new Response(null, { status: 202 });
}

export function tasksEndpoint(env: Env): string {
  return `${companyOrigin(env)}/poppy/tasks`;
}
