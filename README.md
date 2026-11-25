# poppy-sample-company-cloudflare-auth0

A sample Company for the [Personal Agent Protocol](https://personalagentprotocol.org/) (Poppy)
1.0. It runs on Cloudflare Workers, and Auth0 is its OAuth issuer. Any Personal Agent that publishes
a client metadata document can use it. [poppy-bash](https://github.com/abbaspour/poppy-bash) is one such agent, but nothing
here depends on it.

## Endpoints

| Path                                        | Session header | What it is                                                                                                                   |
|---------------------------------------------|----------------|------------------------------------------------------------------------------------------------------------------------------|
| `GET /`                                     | no             | The website: HTML that says who is visiting (see [Website](#website)). Without `Accept: text/html` it is a JSON description |
| `GET /cart`, `GET /orders`                  | no             | The website's pages: an agent's Session's cart, and the account's orders (see [Website](#website))                           |
| `GET /auth/login`, `/auth/callback`, `/auth/logout` | no     | The website's Auth0 login, by `@auth0/auth0-hono`. Off until the website's application is configured                        |
| `GET /.well-known/poppy.json`               | no             | Discovery document (§3)                                                                                                      |
| `GET /.well-known/oauth-protected-resource` | no             | RFC 9728 metadata naming the issuer. Returns 404 while no `AUTH0_ISSUER` is set, which means signed-out Sessions only (§3.2) |
| `GET /openapi.json`                         | no             | The API description listed in `apis[]`. Its `servers` URL is where agents send Session headers                               |
| `GET /api/products`                         | verified       | Product list                                                                                                                 |
| `GET /api/cart`, `DELETE /api/cart`         | verified       | The Session's cart                                                                                                           |
| `POST /api/cart/items`                      | verified       | Add `{"sku","quantity"}` to the Session's cart                                                                               |
| `GET /api/session`                          | verified       | What the Company knows about the Session, including its account and scopes (for debugging)                                   |
| `DELETE /api/session`                       | verified       | Ends the Session, so its next request gets `session_ended` (for testing §5.5)                                                |
| `GET /api/orders`                           | `orders:read`  | The account's orders. Each new account starts with two delivered sample orders                                               |
| `POST /api/orders`                          | `orders:write` | Places an order from the Session's cart, which may have been filled signed out                                               |
| `GET /api/orders/{id}`                      | `orders:read`  | One order, with its returns                                                                                                  |
| `POST /api/orders/{id}/returns`             | `orders:write` | Requests a return of `{"sku","reason"}` from a delivered order                                                               |
| `GET /poppy/tasks`                          | verified       | Excluded tasks with alternatives, a skill index, and the feedback endpoint (§9)                                              |
| `POST /poppy/feedback`                      | verified       | A task the User couldn't do (§9.3): 202, or 200 with an alternative. Stored in KV with the Session's attribution             |
| `GET /skills/return-an-item/SKILL.md`       | no             | The published skill, in the Agent Skills format; its `digest` in the index is computed from these bytes (§9.4)               |
| `POST /poppy/conversations`                 | verified       | Starts a conversation, or a Direct Conversation with `parent_conversation_id` (§8.3, §8.10)                                  |
| `POST /poppy/conversations/{id}/messages`   | verified       | Sends a message                                                                                                              |
| `GET /poppy/conversations/{id}/events`      | verified       | Reads events after `cursor`, holding the request up to `wait` seconds (§8.5). Always JSON: streaming (§8.6) is optional      |
| `POST /poppy/conversations/{id}/handoff`    | verified       | Asks for a person; `…/handoff/cancel` withdraws it (§8.9)                                                                    |
| `POST /poppy/conversations/{id}/close`      | verified       | Closes the conversation (§8.12)                                                                                              |

The order endpoints need an access token from the Company's issuer, together with the Session
header (§5). Without one, they answer RFC 6750 challenges:

| Request                                       | Response                                                                     |
|-----------------------------------------------|------------------------------------------------------------------------------|
| No access token                               | `401`, `WWW-Authenticate: Bearer scope="orders:read", resource_metadata="…"` |
| Expired, invalid, or issued to another client | `401`, `Bearer error="invalid_token"`                                        |
| Missing the scope                             | `403`, `Bearer error="insufficient_scope", scope="orders:write"`             |
| Another account than the Session used before  | `400 {"error": "session_ended"}` (§5.4)                                      |

## Website

The Company also has a small website. [Hono](https://hono.dev) is the Worker's entry point and owns
`/` and `/auth/*`, with [`@auth0/auth0-hono`](https://github.com/auth0/auth0-hono) for the login.
Every other path goes to the Poppy code above, unchanged, so the APIs and discovery documents never
see the website's session cookie.

`GET /` tells who is visiting, from the ID token of the website's session (`src/web/identity.ts`):

| Shows                                    | When                                                                                       |
|------------------------------------------|--------------------------------------------------------------------------------------------|
| You are signed out                       | No session                                                                                 |
| You are signed in as a user              | A login with no Poppy `act` claim                                                          |
| An agent is browsing as a guest          | An anonymous subject (`sub_profile` has `urn:auth0:anonymous_user`) with a Poppy `act`     |
| An agent is acting on behalf of a user   | A user's login whose `act` names the agent (`act.poppy_sid` is present)                    |

A guest is never shown as a user, and gets no link to the login page: it signs in through its
agent. A client that doesn't send `Accept: text/html` gets the Company's name and the same
classification as JSON (`visitor.kind`: `signed_out`, `user`, `agent_guest` or `agent_for_user`).

The website logs in with the Company's API audience (`https://{COMPANY_DOMAIN}`, or `AUTH0_AUDIENCE`)
and the scopes `openid profile email offline_access orders:read orders:write`. Agents get their tokens
for the same audience, which is what lets an agent's browser join end in a login to this website.
Sessions are in the `SESSIONS` KV namespace, under keys that don't collide with the Poppy Sessions'.

Login is off until `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET` and `AUTH0_SESSION_ENCRYPTION_KEY` are set:
`/` then says so, and `/auth/*` is a 404. Create the application as described in
[auth0/README.md](auth0/README.md#the-website-regular-web-application), put its client ID in
`wrangler.toml`, and run `make secrets`. For `make dev`, copy `.dev.vars.example` to `.dev.vars`.

### Browser join

An agent's browser can join its Session (§6). Auth0 hosts the join endpoint, so the Worker doesn't
implement one: `poppy.json` lists `web.browser_session_endpoint`
(`https://{issuer host}/poppy/{AUTH0_CLIENT_ID}/browser-session`) and the scope `poppy:browser-sign-in`,
once the issuer and `AUTH0_CLIENT_ID` are set. The join runs like this:

1. The agent's browser loads Auth0's endpoint, which gives it a one-time code and a cookie.
2. The agent authorizes the code at `{endpoint}/authorize` with its `Poppy-Session` header and, signed in, its access token.
3. The browser submits the code, and Auth0 sends it to this website's Application Login URI, `/auth/login`, with `iss` and `target_link_uri`.
4. `/auth/login` (`src/web/join.ts`) refuses an `iss` that is empty, repeated, or not `AUTH0_ISSUER`, with a 400 and nothing started. It follows `target_link_uri` only on this origin. Then it starts a normal login, which Auth0 completes without prompts.
5. The tokens name the agent in `act`, so `/` shows an agent guest or an agent acting on behalf of a user, with the Poppy Session and User IDs, and the scopes the user approved for it.

The website applies the agent's scopes rather than treating the join as the account's full access
(`web.unscoped` is `false`): the website has no action of its own beyond the APIs, and a signed-in
join's tokens carry only what the user approved. An agent's session lasts as long as its ID token,
at most 2 hours with no refresh token, and the website stops honoring it after that.
`poppy-bash`'s `browser-join.sh` does the agent's side.

### One Session at the APIs and the website

The agent's Session at the APIs and its browser's session at the website are the same Session (§6).
The ID token's `act` names the agent (its metadata URL, as `act.sub` when its application isn't
linked to an Auth0 agent), the Session ID and the User ID. Together they are the key of the Session
record the APIs keep (`session:{agent}:{sid}:{user}`), and the website reads that record
(`src/web/poppy-session.ts`). Never by the Session ID alone: agents choose their own, so two agents' or
two users' can be equal.

- `GET /cart` shows the cart the agent fills through `POST /api/cart/items`, for a guest or a signed-in agent. If the agent hasn't used the APIs in this Session, there is no record yet, and the page says so.
- `GET /orders` shows the account's orders to a person, and to a signed-in agent only if the user approved `orders:read` for it. Otherwise it answers 403 with a page that names the missing scope (§6), so the agent can ask for it. A guest has no account, so it gets 403 too.
- **The website stops acting for a Session the Company has ended** (§5.5): when the record is `ended` (`DELETE /api/session`), the visitor is treated as signed out and the page says why. It does the same when the Session is signed in to another account than the login (§5.4). The cookie still exists until it expires, but nothing honors it. This is checked on each page, not pushed: revoking the agent at Auth0 doesn't end a join (a beta limit), and the website only learns what the Company's own record says.
- If `act.sub` is an Auth0 agent ID rather than the metadata URL, the record can't be found from the login and the pages say there is no cart. Link-aware lookup would need a mapping, which this sample doesn't keep.

## Conversations

Each conversation is a Durable Object ([`src/conversations/object.ts`](./src/conversations/object.ts)).
That keeps its events strictly ordered, and lets a read wait in place for the next event.
[`routes.ts`](./src/conversations/routes.ts) validates each request (§8.2-8.4) and passes it on.

- **IDs.** A new conversation's ID is derived from its owner and the request ID, so a retried first
  message reaches the conversation it already started (§8.3). Every POST's ID, path and body are
  recorded: a retry gets the original response, and a reused ID with another body gets
  `request_id_conflict`.
- **Ownership (§8.2).** A conversation belongs to the `client_id` and User ID that started it, and to
  an account once a signed-in request uses it. The same User signed out then gets a challenge.
  Another account, User or agent gets `conversation_not_found`, exactly as an unknown ID does.
- **`?wait` on a POST** holds the request until the Company has acted on it, so the reply comes back
  in the same response (§8.3). A GET with `wait` returns at the next event, or when `working`
  turns false (§8.5).
- **The Company Agent** ([`agent.ts`](./src/conversations/agent.ts)) is scripted, and replies about
  a second after each request, from a Durable Object alarm, so `working` and `wait` are visible:
  - Product questions are answered signed out.
  - Order and return questions add an `authorization` event with the scope they need (§8.11), and
    are answered from the account's orders once signed in.
  - "Cancel" adds a `user_requested` event, which the agent can accept with a Direct Conversation
    (§8.10). While that's open, the parent takes no messages.
  - A handoff (§8.9) goes `pending`, then back to `none` with a message saying no one is available.
    The demo has no staff, and doesn't pretend a person joined.

## Session verification

[`src/session/verify.ts`](./src/session/verify.ts) runs §5.3 on every API request:

1. **`Poppy-Version`.** It must be compatible with 1.x, or the response is `version_unsupported` (§3.4).
2. **Session JWT header.** `typ` must be `poppy-session+jwt` and `alg` must be `ES256`. A
   delegation in `poppy_dlg` is required, so a JWT signed directly with a `jwks_uri` key is
   rejected.
3. **Client metadata.** The `iss` URL is fetched without following redirects. Its `client_id`
   must equal that URL. Then `jwks_uri` is fetched; it must be on the same domain. Only HTTPS and
   public hosts are allowed ([`cimd.ts`](./src/session/cimd.ts)). Results are cached for 5
   minutes and refetched when a key is unknown.
4. **Delegation.** It must be signed by the `jwks_uri` key named by `kid`, with `ES256` or `PS384`.
   Its `typ` must be `poppy-delegation+jwt`, its `iss` must match, it must not have expired, and
   it may last at most 24h.
5. **Signature.** The JWT must verify with the delegated key, and `kid` must be that key's
   RFC 7638 thumbprint.
6. **Claims.** `aud` must be the Company identifier: the issuer, or `https://{domain}`. `htm` and
   `htu` must match the request (RFC 9449 §4.3). `iat` must be within 60s. `sid` must be an ID
   (§8.2). `ath` must cover the access token, and be absent without one.
7. **Session lookup.** The Session is found by `client_id`, `sid` and `sub` in KV, or started.
   An ended Session gets `session_ended`. A Session whose `agent_id` changed is rejected.

With an access token, [`src/router.ts`](./src/router.ts) then:

8. **Validates the token** ([`access-token.ts`](./src/auth/access-token.ts)) against the issuer's
   JWKS, from `jwks_uri` in its metadata. `iss` must be exactly `AUTH0_ISSUER`, `aud` must include
   `https://{COMPANY_DOMAIN}`, and it must not have expired. It must also have been issued to the
   Session JWT's `iss`, via `client_id` or `azp`, so a copied token is useless without the agent's
   keys (§5.3 step 3).
9. **Binds the Session to the token's account.** A later request in the Session for another
   account gets `session_ended` (§5.4).
10. **Checks the route's scope** (§7).

Failures return HTTP 400 with `{"error": "invalid_session", "error_description": ...}`.

## Make goals

Every step is a `make` goal. The goals run npm and wrangler for you, and `make` on its own lists
them.

| Goal           | What it does                                                                                        |
|----------------|-----------------------------------------------------------------------------------------------------|
| `make install` | `npm install`, rerun only when `package.json` or the lock file changes                              |
| `make check`   | Tests and typecheck                                                                                 |
| `make dev`     | Runs the Company locally on `http://localhost:8787`, using the `dev` environment                    |
| `make login`   | Logs wrangler in to your Cloudflare account (`make whoami` shows which account)                     |
| `make kv`      | Creates the `SESSIONS` KV namespace, or finds it if it exists, and writes its id to `wrangler.toml` |
| `make secrets` | Sets the website's `AUTH0_CLIENT_SECRET` (asked for) and `AUTH0_SESSION_ENCRYPTION_KEY` (generated once) |
| `make dry-run` | Bundles and validates the Worker without uploading it                                               |
| `make deploy`  | Runs `make check`, then deploys the Worker with `COMPANY_DOMAIN` as its custom domain               |
| `make smoke`   | Fetches the deployed `poppy.json` and protected resource metadata                                   |
| `make tail`    | Streams the deployed Worker's logs                                                                  |
| `make clean`   | Removes `.wrangler/` (local KV data) and `dist/`                                                    |

## Develop

```bash
make install
make check          # verifier tests: valid Sessions and each failure in §5.3, plus typecheck
make dev            # http://localhost:8787, the `dev` environment
```

The `dev` environment sets `COMPANY_DOMAIN=localhost:8787` and `DEV_ALLOW_HTTP=true`, so it
accepts agents whose metadata is on `http://localhost`. Use it with poppy-bash's
`POPPY_DEV_ALLOW_HTTP=1` and `AGENT_BASE_URL=http://localhost:1990`. Never deploy that environment.
The deploy goals target the top-level environment explicitly (`--env=""`), so `make deploy` can't
deploy `dev` by mistake.

## Deploy

1. **Set the Company.** In the top-level `[vars]` of `wrangler.toml`, set `COMPANY_DOMAIN` to a
   hostname in a zone on your Cloudflare account, and set `COMPANY_NAME`. `poppy.json` must be
   served from exactly `organization.domain` (§3.1), so the Worker gets that hostname as its
   custom domain. You don't need a `routes` entry.
2. **Set up the account.**

   ```bash
   make login
   make kv
   ```

3. **Deploy.**

   ```bash
   make dry-run    # optional
   make deploy
   ```

4. **Check it.** Run `make smoke`, then `./discover.sh -d <COMPANY_DOMAIN>` in poppy-bash.

`make dry-run` and `make deploy` refuse to run while `wrangler.toml` still has the placeholder KV id
or the example domain `shop.example.dev`.

For the Auth0 tenant that issues the Company's tokens, see [`auth0/README.md`](./auth0/README.md).
