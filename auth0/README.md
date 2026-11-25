# Auth0 tenant setup

The Company's issuer is set in `wrangler.toml` as `AUTH0_ISSUER`, exactly as the issuer's metadata
writes it, including the trailing slash. Without it, the Company offers signed-out Sessions only.

The issuer must meet what Poppy requires of the Company's authorization server (§3.2, §4). Here's
how the sample tenant `amin.emt-poppy-poc-01.auth0c.com` is set up:

1. **`protected_resources`.** The issuer's `/.well-known/oauth-authorization-server` must list
   `https://{COMPANY_DOMAIN}` in `protected_resources`. Personal Agents refuse a Company whose
   issuer doesn't, because any domain could otherwise claim the issuer. Standard Auth0 tenants
   don't publish this field. The `emt-poppy-poc-01` environment does.
2. **An API for the Company.** Its identifier is `https://{COMPANY_DOMAIN}`, its scopes are
   `orders:read` and `orders:write`, and it allows offline access, so sign-ins return refresh
   tokens (§4.4). Make it the tenant's default audience. A sign-in without `resource` then gets a
   token for the Company (§4.5), which is how Poppy expects sign-in to work, so any Personal Agent
   works unchanged. Without a default audience, turn on the Resource Parameter Compatibility
   Profile, and have agents name the Company's resource at sign-in. poppy-bash does this with
   `sign-in.sh -R default`.
3. **Client ID Metadata Document Registration** (Settings > Advanced). Personal Agents' `client_id`s
   are URLs of CIMD documents (§4.1). Either turn on **Dynamic CIMD Registration**, or import each
   agent under Applications > Create Application > Import from URL.
4. **Third-party client access.** Auth0 treats CIMD clients as third-party applications. Give them
   a client grant for the Company's API, and promote the connections Users sign in with to the
   domain level.
5. ~~**Device Sign-In (optional, §4.3).** Enable the Device Code grant on the agent's application.
   It isn't enabled when the CIMD document is imported.~~
6. **Include Issuer in Authorization Responses** (Settings > Advanced). Personal Agents check `iss`
   on every Direct Sign-In redirect (RFC 9207, §4.2).
7. **Client assertions.** The tenant must accept `private_key_jwt` with ES256 and PS384 (§4.1).
   `token_endpoint_auth_signing_alg_values_supported` in the metadata lists what it accepts.

To check the tenant, fetch its metadata:

```bash
curl -s https://<tenant>/.well-known/oauth-authorization-server | jq '{issuer, protected_resources,
  client_id_metadata_document_supported, authorization_response_iss_parameter_supported,
  token_endpoint_auth_signing_alg_values_supported}'
```

Then run `make smoke`, and `./discover.sh -d <COMPANY_DOMAIN> -W` in poppy-bash, which runs every
discovery check.

## The website: a Regular Web Application

The website's login (`/auth/*`) needs its own application, separate from the Personal Agents'
applications. Create a **Regular Web Application** in the tenant and set:

| Setting                | Value                                                                                           |
|------------------------|-------------------------------------------------------------------------------------------------|
| Allowed Callback URLs  | `https://{COMPANY_DOMAIN}/auth/callback`, and `http://localhost:8787/auth/callback` for `make dev` |
| Allowed Logout URLs    | `https://{COMPANY_DOMAIN}`, and `http://localhost:8787`                                          |
| Allowed Web Origins    | the same two origins                                                                            |
| Grant types            | Authorization Code and Refresh Token                                                            |
| Application access     | A client grant on the Company's API (`https://{COMPANY_DOMAIN}`) for users, with `orders:read` and `orders:write`. The website logs in with that audience and those scopes; agents' tokens use the same audience |
| Connections            | The same domain-level connection the Personal Agents' users sign in with                        |

Then give the Worker its settings:

1. Put the application's client ID in `AUTH0_CLIENT_ID` in `wrangler.toml`.
2. Run `make secrets`. It asks for the client secret and sets `AUTH0_SESSION_ENCRYPTION_KEY` once.
3. `make deploy`, then open `https://{COMPANY_DOMAIN}/`, log in, and check that the page says you
   are signed in as a user.

For `make dev`, copy `.dev.vars.example` to `.dev.vars` and fill it in. Locally the Company's origin
is `http://localhost:8787`, which isn't the API's identifier, so `.dev.vars` sets `AUTH0_AUDIENCE`.

The website's login uses the tenant's custom domain from `AUTH0_ISSUER`, so ID tokens carry the
issuer Poppy needs. Joining an agent's browser to its Session (below) adds settings to this application.

### Browser join (§6)

Auth0 hosts the join endpoint, `https://{issuer host}/poppy/{WEB_CLIENT_ID}/browser-session`. Without
the settings below it answers `The browser session could not be joined` / `target client has no
HTTPS initiate_login_uri`. On the website's application:

| Setting                             | Value                                                                           |
|-------------------------------------|---------------------------------------------------------------------------------|
| `allow_personal_agent_browser_join` | `true`. First-party applications only                                           |
| `initiate_login_uri`                | `https://{COMPANY_DOMAIN}/auth/login` (Application Login URI)                   |
| `callbacks`                         | already includes `https://{COMPANY_DOMAIN}/auth/callback`                       |
| `anonymous_sessions`                | `{ "active": true }`, for guest joins                                           |

On the Company's API (`https://{COMPANY_DOMAIN}`):

- Add the scope `poppy:browser-sign-in`, described "Use the website on your behalf, with the permissions you approve".
- Turn on **Allow Skipping User Consent** (`skip_consent_for_verifiable_first_party_clients`): the login that ends a join can't show a consent screen.
- Include agent subject claims (`agent_subject_claims: auth0-v1`), so `act` names the agent.
- For a guest's website token to be a JWT for the API (optional): `subject_type_authorization.anonymous_user.policy: require_client_grant`, and a client grant for the website's application with `subject_type: anonymous_user`. Without it a guest gets only an opaque `/userinfo` token, which is enough for `/`.

The Personal Agents' applications need `poppy:browser-sign-in` in their client grant for users, and the
connection users sign in with must be a domain-level connection. The login that ends a join can't show
prompts: no MFA, consent screen or post-login Action form. If you require MFA, skip it when an actor is present.

Then deploy the Worker with `AUTH0_CLIENT_ID` set: `poppy.json` gains the `web` block, and
`./discover.sh -d {COMPANY_DOMAIN} -W` in poppy-bash picks it up. Check the endpoint:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://{issuer host}/poppy/{WEB_CLIENT_ID}/browser-session   # 200, not 400
```
