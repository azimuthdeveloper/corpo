# Corpo

Corpo is an internal-network fork of [Dokploy](https://github.com/Dokploy/dokploy) (Apache 2.0), branched from `v0.30.8`. It runs on a Linux VM inside the corporate network. An IIS server terminates SSL and forwards `/cor-*` paths to it, so apps are reachable at URLs like `https://iis.example.internal/cor-myapp`.

## Differences from Dokploy

- **No enterprise code.** Dokploy's DSAL-licensed `/proprietary` folders (SSO, SCIM, audit logs, custom roles, whitelabeling, license keys, forward auth) are removed. `packages/server/src/corpo/license.ts` provides stand-ins, and licence-gated features stay off.
- **Branding.** The branding config is fixed in `packages/server/src/corpo/branding.ts` and the logo is replaced.
- **No Let's Encrypt.** The ACME resolver is removed from the default Traefik config and hidden in the UI, because IIS terminates TLS.
- **No self-update.** The "Update" button would have switched the panel to the upstream `dokploy/dokploy` image. Upgrade by redeploying the Corpo image instead.
- **Gateway** (Settings → Gateway): holds these settings:
  - IIS public host and scheme
  - route prefix (`cor-`)
  - Corpo server address
  - trusted proxy IPs, written to Traefik's `forwardedHeaders.trustedIPs`

  The page also generates the IIS `web.config` rule and `appcmd` setup commands.
- **Access card** (Domains tab of an application or compose service): shows direct port URLs and IIS routes, and adds an IIS route from a short name.
- **Exact path routing.** A domain path `/cor-app` matches `/cor-app` and `/cor-app/...` but not `/cor-application`. With *Strip path* on, `/cor-app` redirects to `/cor-app/`.
- **`CORPO_BASE_PATH` / `CORPO_PUBLIC_URL`** are injected into application build args and runtime env for the primary route (the IIS route if there is one). Values you set yourself take precedence.
- **Auto-deploy by polling** (General tab of an application or compose service). GitHub.com and Azure DevOps cloud can't send webhooks into the network, so Corpo runs `git ls-remote` on the branch at a set interval (30 seconds minimum) and queues a normal deployment when the head commit changes. Details:
  - Switching polling on records the current commit as a baseline, so it never deploys straight away.
  - Failures back off exponentially, up to 30 minutes, and the latest error shows on the card.
  - Watch paths are not applied to polled deployments.
  - Supported sources: GitHub (the existing GitHub App token) and Git (SSH key, or HTTPS with a token).
- **HTTPS git tokens** (same card, for Git sources with an `https://` URL, such as an Azure DevOps PAT with Code: Read). The token is sent as an `http.extraHeader` through git's environment config, scoped to the single clone or `ls-remote` command, so it never appears in the URL, deployment logs or later build steps.
- **Network** (Settings → Network): outbound proxy (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`) and internal CA certificates (PEM). `NO_PROXY` always includes loopback and the panel's own services.
  - **Panel:** saving puts the proxy, `NODE_USE_ENV_PROXY=1`, `NODE_EXTRA_CA_CERTS` and `GIT_SSL_CAINFO` on the `dokploy` Swarm service and restarts it. Git clones, polling and GitHub API calls then go through the proxy and trust the CA.
  - **Builds** (on by default): the proxy variables are passed as Dockerfile build args and as env for Nixpacks, Railpack and buildpacks. Nixpacks may bake them into the image.
  - **Containers** (off by default): the proxy variables are set on application containers.
  - **CA in containers** (on by default): the CA is mounted read-only at `/etc/corpo`, with `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE` and `CURL_CA_BUNDLE` set. This covers applications on the Corpo server only; compose services can mount `/etc/dokploy/corpo/ca` themselves. Java apps need their own truststore.
  - **Docker daemon:** image pulls need the proxy on the host daemon. The page shows the systemd drop-in to install; the Corpo installer (Phase 5) writes it for you.
  - **Remote servers** are not covered yet: builds and containers there don't get the proxy or CA automatically.

## Fork rules (keep upstream merges cheap)

- New code goes in `packages/server/src/corpo/` and `apps/dokploy/components/corpo/`. Upstream files only get small hooks.
- Leave internal identifiers alone: `dokploy-network`, `/etc/dokploy`, the `dokploy` / `dokploy-traefik` service names and the `@dokploy/*` package names.
- Corpo tables live in `packages/server/src/corpo/schema.ts`. They get their own migrations in `apps/dokploy/drizzle-corpo`, tracked in the `corpo_migrations` table, so upstream's `drizzle/` journal never conflicts. To generate a new migration:

  ```bash
  pnpm --filter=dokploy corpo:migration:generate --name <name>
  ```

- Merging upstream:

  ```bash
  git fetch upstream --tags && git merge <release-tag>
  pnpm typecheck && pnpm test -- --run
  ```

## Roadmap

1. ~~Remove enterprise code, rebrand, drop Let's Encrypt and self-update~~
2. ~~Gateway settings, IIS routes, exact path routing, `CORPO_*` env~~
3. ~~Git polling auto-deploy and HTTPS token credentials~~
4. ~~Corporate proxy and internal CA for the panel, git, builds and containers~~
5. Corpo image build/publish and a forked install script
