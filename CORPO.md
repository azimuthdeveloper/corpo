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

## Install

On a Linux VM (Ubuntu or RHEL family) inside the network, with ports 80, 443 and 3000 free:

```bash
curl -fsSLO https://raw.githubusercontent.com/azimuthdeveloper/corpo/main/install.sh
sudo CORPO_HTTP_PROXY=http://proxy.example.internal:8080 \
     CORPO_NO_PROXY=.example.internal \
     CORPO_CA_FILE=/path/to/internal-root-ca.pem \
     bash install.sh
```

Every variable is optional; `install.sh` lists all of them at the top. The installer:

- Trusts the internal CA system-wide, installs Docker if it's missing, and gives the Docker daemon the proxy (a systemd drop-in). It restarts Docker only when those settings actually change.
- Initialises Swarm only if it isn't already active, and never leaves an existing swarm.
- Creates Postgres, the Corpo panel and Traefik. The panel starts with the proxy and CA variables already set, and seeds Settings → Network from them on first boot.
- Waits for the panel to write Traefik's config before starting Traefik.

Then open `http://<server>:3000`, create the admin account, and fill in Settings → Gateway (IIS) and Settings → Network.

**Updating:** `sudo bash install.sh update` pulls `CORPO_IMAGE` (default `ghcr.io/azimuthdeveloper/corpo:latest`) and rolls the panel onto it, re-applying the proxy and CA variables.

## Image

`.github/workflows/corpo.yml` runs typecheck, tests (with a real Docker Swarm) and build on every push to `main`, then publishes the image to GHCR:

| Tag | Published when |
| --- | --- |
| `latest` | every push to `main` |
| `sha-<commit>` | every push to `main` |
| `X.Y.Z` | a `vX.Y.Z` tag is pushed |

- **Actions:** it is disabled on forks until you enable it in the repository's Actions tab.
- **Package visibility:** the package follows the repository's visibility, so it's public while the repo is public. If you make it private, install with `CORPO_REGISTRY_USER` / `CORPO_REGISTRY_TOKEN` (a token with `read:packages`).
- **Removed workflows:** upstream's Docker Hub publishing, docs sync and release workflows are removed. `pull-request.yml` still checks PRs.

## Fork rules (keep upstream merges cheap)

- New code goes in `packages/server/src/corpo/` and `apps/dokploy/components/corpo/`. Upstream files only get small hooks.
- Leave internal identifiers alone: `dokploy-network`, `/etc/dokploy`, the `dokploy` / `dokploy-traefik` service names and the `@dokploy/*` package names.
- Corpo tables live in `packages/server/src/corpo/schema.ts`. They get their own migrations in `apps/dokploy/drizzle-corpo`, tracked in the `corpo_migrations` table, so upstream's `drizzle/` journal never conflicts. To generate a new migration:

  ```bash
  pnpm --filter=dokploy corpo:migration:generate --name <name>
  ```

- Upstream workflow files deleted here may conflict when upstream edits them; resolve by deleting them again.
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
5. ~~Corpo image build/publish and install script~~

### Known gaps

- Remote (multi-server) deployments don't get the proxy, CA, or CA mount automatically.
- Compose services get `CORPO_*` route env or the CA mount only if they add them themselves.
- The `/cor-app` → `/cor-app/` redirect with *Strip path* applies to application routes, not compose labels.
- Polled deployments ignore watch paths. Polling supports GitHub and Git sources only (not GitLab, Gitea or Bitbucket).
- About 50 longer help texts still say "Dokploy".
- Java apps need the internal CA imported into their own truststore.
