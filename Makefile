.DEFAULT_GOAL := help

# quiet npx's "npm notice run ..." lines
export npm_config_loglevel := warn

WRANGLER := npx --no-install wrangler

# the Company's domain and name, from the top-level [vars] in wrangler.toml
COMPANY_DOMAIN := $(shell awk -F'"' '/^COMPANY_DOMAIN/ {print $$2; exit}' wrangler.toml)
KV_TITLE       ?= poppy-sample-company-sessions
KV_PLACEHOLDER := REPLACE_WITH_KV_NAMESPACE_ID
DEV_PORT       ?= 8787

.PHONY: help install test typecheck check dev login whoami kv secrets dry-run deploy tail smoke clean

help:
	@echo "Setup"
	@echo "  make install    # npm install"
	@echo "  make login      # log wrangler in to your Cloudflare account"
	@echo "  make kv         # create the SESSIONS KV namespace and write its id to wrangler.toml"
	@echo "  make secrets    # set the website's AUTH0_CLIENT_SECRET and AUTH0_SESSION_ENCRYPTION_KEY"
	@echo "Develop"
	@echo "  make check      # tests + typecheck"
	@echo "  make dev        # run locally on http://localhost:$(DEV_PORT) (the dev environment)"
	@echo "Deploy (COMPANY_DOMAIN=$(COMPANY_DOMAIN))"
	@echo "  make dry-run    # bundle and validate without uploading"
	@echo "  make deploy     # check, then deploy on https://$(COMPANY_DOMAIN) as a custom domain"
	@echo "  make smoke      # fetch the deployed discovery documents"
	@echo "  make tail       # stream the deployed Worker's logs"

# --- setup ---

install: node_modules/.package-lock.json

node_modules/.package-lock.json: package.json package-lock.json
	npm install --no-fund --no-audit
	@touch $@

login: install
	$(WRANGLER) login

whoami: install
	$(WRANGLER) whoami

# Finds the namespace by title, creates it if missing, and replaces the placeholder id in
# wrangler.toml. Safe to run again.
kv: install
	@command -v jq >/dev/null || { echo "jq not found" >&2; exit 3; }
	@id=$$($(WRANGLER) kv namespace list | jq -r --arg t "$(KV_TITLE)" '.[] | select(.title == $$t) | .id'); \
	if [ -z "$$id" ]; then \
		echo "creating KV namespace $(KV_TITLE)"; \
		$(WRANGLER) kv namespace create "$(KV_TITLE)" >/dev/null; \
		id=$$($(WRANGLER) kv namespace list | jq -r --arg t "$(KV_TITLE)" '.[] | select(.title == $$t) | .id'); \
	fi; \
	[ -n "$$id" ] || { echo "couldn't create or find KV namespace $(KV_TITLE)" >&2; exit 1; }; \
	if grep -q "$(KV_PLACEHOLDER)" wrangler.toml; then \
		sed -i.bak "s/$(KV_PLACEHOLDER)/$$id/" wrangler.toml && rm -f wrangler.toml.bak; \
		echo "wrote KV namespace id $$id to wrangler.toml"; \
	elif grep -q "$$id" wrangler.toml; then \
		echo "wrangler.toml already uses KV namespace $$id"; \
	else \
		echo "wrangler.toml has a different KV id; $(KV_TITLE) is $$id" >&2; exit 1; \
	fi

# The website's secrets (auth0/README.md). The client secret is asked for; the key that encrypts
# the session cookie is generated, and left alone if it exists: a new one signs everyone out.
secrets: install
	@command -v jq >/dev/null || { echo "jq not found" >&2; exit 3; }
	@printf 'Auth0 web application client secret: ' >&2; IFS= read -rs secret; echo >&2; \
	[ -n "$$secret" ] || { echo "no secret given" >&2; exit 1; }; \
	printf %s "$$secret" | $(WRANGLER) secret put AUTH0_CLIENT_SECRET --env=""
	@if $(WRANGLER) secret list --env="" | jq -e '.[] | select(.name == "AUTH0_SESSION_ENCRYPTION_KEY")' >/dev/null; then \
		echo "AUTH0_SESSION_ENCRYPTION_KEY is already set"; \
	else \
		openssl rand -hex 32 | $(WRANGLER) secret put AUTH0_SESSION_ENCRYPTION_KEY --env=""; \
	fi

# --- develop ---

test: install
	npm test

typecheck: install
	npm run typecheck

check: test typecheck

dev: install
	$(WRANGLER) dev --env dev --port $(DEV_PORT) --ip 127.0.0.1

# --- deploy ---

# refuse to deploy the placeholders: poppy.json must be served from exactly COMPANY_DOMAIN (§3.1)
define assert_configured
	@if grep -q "$(KV_PLACEHOLDER)" wrangler.toml; then echo "run 'make kv' first" >&2; exit 1; fi
	@if [ -z "$(COMPANY_DOMAIN)" ] || [ "$(COMPANY_DOMAIN)" = "shop.example.dev" ]; then \
		echo "set COMPANY_DOMAIN in the top-level [vars] of wrangler.toml" >&2; exit 1; fi
endef

dry-run: install
	$(assert_configured)
	$(WRANGLER) deploy --env="" --dry-run --outdir dist

deploy: check
	$(assert_configured)
	$(WRANGLER) deploy --env="" --domain "$(COMPANY_DOMAIN)"

smoke:
	@command -v jq >/dev/null || { echo "jq not found" >&2; exit 3; }
	curl -fsS "https://$(COMPANY_DOMAIN)/.well-known/poppy.json" | jq .
	@status=$$(curl -s -o /dev/null -w '%{http_code}' "https://$(COMPANY_DOMAIN)/.well-known/oauth-protected-resource"); \
	echo "oauth-protected-resource: HTTP $$status (404 = signed-out Sessions only)"

tail: install
	$(WRANGLER) tail --env=""

clean:
	rm -rf .wrangler dist
