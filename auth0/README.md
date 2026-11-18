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
