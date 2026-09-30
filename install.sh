#!/usr/bin/env bash
# Corpo installer: sets up Docker Swarm, Postgres, the Corpo panel and Traefik
# on a Linux server inside a corporate network.
#
#   sudo bash install.sh            install
#   sudo bash install.sh update     switch the panel to the latest image
#
# Configuration (environment variables, all optional):
#   CORPO_IMAGE           panel image            (default ghcr.io/azimuthdeveloper/corpo:latest)
#   CORPO_POSTGRES_IMAGE  postgres image         (default postgres:16)
#   CORPO_TRAEFIK_IMAGE   traefik image          (default traefik:v3.6.25)
#   ADVERTISE_ADDR        swarm advertise address (default: first private IPv4)
#   DOCKER_SWARM_INIT_ARGS extra `docker swarm init` arguments (e.g. --default-addr-pool 172.30.0.0/16)
#   CORPO_HTTP_PROXY      outbound proxy, e.g. http://proxy.example.internal:8080
#   CORPO_HTTPS_PROXY     defaults to CORPO_HTTP_PROXY
#   CORPO_NO_PROXY        extra hosts to reach directly, e.g. .example.internal,10.0.0.0/8
#   CORPO_CA_FILE         PEM file with internal CA certificate(s)
#   CORPO_REGISTRY_MIRROR Docker Hub mirror, e.g. https://mirror.example.internal
#   CORPO_INSTALL_DOCKER  set to 0 to fail instead of installing Docker when it is missing
#   CORPO_REGISTRY_USER / CORPO_REGISTRY_TOKEN
#                         credentials for a private CORPO_IMAGE registry (e.g. a GitHub
#                         token with read:packages for ghcr.io)

set -euo pipefail

CORPO_IMAGE="${CORPO_IMAGE:-ghcr.io/azimuthdeveloper/corpo:latest}"
CORPO_POSTGRES_IMAGE="${CORPO_POSTGRES_IMAGE:-postgres:16}"
CORPO_TRAEFIK_IMAGE="${CORPO_TRAEFIK_IMAGE:-traefik:v3.6.25}"
BASE_DIR=/etc/dokploy
CA_DIR="$BASE_DIR/corpo/ca"
# Must match BUILTIN_NO_PROXY in packages/server/src/corpo/network-env.ts so
# the panel sees its environment as up to date.
BUILTIN_NO_PROXY="localhost,127.0.0.1,::1,dokploy-postgres,dokploy-redis,dokploy-traefik,dokploy-monitoring"

log() { printf '\033[0;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[0;31mError:\033[0m %s\n' "$*" >&2; exit 1; }
command_exists() { command -v "$1" >/dev/null 2>&1; }

HTTP_PROXY_VALUE="${CORPO_HTTP_PROXY:-}"
HTTPS_PROXY_VALUE="${CORPO_HTTPS_PROXY:-$HTTP_PROXY_VALUE}"
HTTP_PROXY_VALUE="${HTTP_PROXY_VALUE:-$HTTPS_PROXY_VALUE}"

merged_no_proxy() {
	printf '%s' "$BUILTIN_NO_PROXY,${CORPO_NO_PROXY:-}" |
		tr ' ,' '\n\n' | sed '/^$/d' | awk '!seen[$0]++' | paste -sd, -
}

preflight() {
	[ "$(id -u)" = "0" ] || die "Run this script as root (sudo bash install.sh)."
	[ "$(uname -s)" = "Linux" ] || die "Corpo must be installed on Linux."
	[ ! -f /.dockerenv ] || die "Run this on the host, not inside a container."
	command_exists curl || die "curl is required."
	command_exists openssl || die "openssl is required."
	if [ -n "${CORPO_CA_FILE:-}" ]; then
		[ -r "$CORPO_CA_FILE" ] || die "CORPO_CA_FILE ($CORPO_CA_FILE) is not readable."
		openssl x509 -in "$CORPO_CA_FILE" -noout 2>/dev/null ||
			die "CORPO_CA_FILE does not contain a PEM certificate."
	fi
	if [ -n "$HTTP_PROXY_VALUE" ]; then
		case "$HTTP_PROXY_VALUE" in http://* | https://*) ;; *)
			die "Proxy must be a URL like http://proxy.example.internal:8080" ;;
		esac
		export HTTP_PROXY="$HTTP_PROXY_VALUE" HTTPS_PROXY="$HTTPS_PROXY_VALUE"
		export http_proxy="$HTTP_PROXY_VALUE" https_proxy="$HTTPS_PROXY_VALUE"
		NO_PROXY="$(merged_no_proxy)"
		export NO_PROXY no_proxy="$NO_PROXY"
	fi
}

check_ports() {
	# Re-running on an existing install is fine; the ports belong to Corpo.
	docker service inspect dokploy >/dev/null 2>&1 && return 0
	command_exists ss || return 0
	local port
	for port in 80 443 3000; do
		if ss -tuln | awk '{print $5}' | grep -Eq "[:.]${port}\$"; then
			die "Port $port is already in use."
		fi
	done
}

DOCKER_NEEDS_RESTART=0

# Copies $1 to $2 and flags a Docker restart only when the content changed.
install_if_changed() {
	if [ ! -f "$2" ] || ! cmp -s "$1" "$2"; then
		cp "$1" "$2"
		DOCKER_NEEDS_RESTART=1
		return 0
	fi
	return 1
}

install_ca_system_wide() {
	[ -n "${CORPO_CA_FILE:-}" ] || return 0
	log "Trusting the internal CA system-wide (needed for image pulls through TLS-inspecting proxies)"
	if [ -d /usr/local/share/ca-certificates ] && command_exists update-ca-certificates; then
		install_if_changed "$CORPO_CA_FILE" /usr/local/share/ca-certificates/corpo-internal-ca.crt &&
			update-ca-certificates >/dev/null
	elif [ -d /etc/pki/ca-trust/source/anchors ] && command_exists update-ca-trust; then
		install_if_changed "$CORPO_CA_FILE" /etc/pki/ca-trust/source/anchors/corpo-internal-ca.pem &&
			update-ca-trust extract
	else
		warn "Unknown CA store layout; add $CORPO_CA_FILE to the system trust store manually."
	fi
}

install_docker() {
	if command_exists docker; then
		log "Docker is already installed"
		return
	fi
	[ "${CORPO_INSTALL_DOCKER:-1}" != "0" ] ||
		die "Docker is not installed and CORPO_INSTALL_DOCKER=0."
	log "Installing Docker"
	curl -fsSL https://get.docker.com | sh
	systemctl enable --now docker
}

configure_docker_daemon() {
	local tmp
	tmp="$(mktemp)"
	if [ -n "$HTTP_PROXY_VALUE" ]; then
		log "Configuring the Docker daemon proxy"
		mkdir -p /etc/systemd/system/docker.service.d
		printf '[Service]\nEnvironment="HTTP_PROXY=%s"\nEnvironment="HTTPS_PROXY=%s"\nEnvironment="NO_PROXY=%s"\n' \
			"$HTTP_PROXY_VALUE" "$HTTPS_PROXY_VALUE" "$NO_PROXY" >"$tmp"
		install_if_changed "$tmp" /etc/systemd/system/docker.service.d/http-proxy.conf || true
	fi
	if [ -n "${CORPO_REGISTRY_MIRROR:-}" ]; then
		if [ -f /etc/docker/daemon.json ]; then
			grep -q "$CORPO_REGISTRY_MIRROR" /etc/docker/daemon.json ||
				warn "/etc/docker/daemon.json exists; add \"registry-mirrors\": [\"$CORPO_REGISTRY_MIRROR\"] to it yourself."
		else
			log "Configuring the Docker Hub mirror"
			mkdir -p /etc/docker
			printf '{\n  "registry-mirrors": ["%s"]\n}\n' "$CORPO_REGISTRY_MIRROR" >"$tmp"
			install_if_changed "$tmp" /etc/docker/daemon.json || true
		fi
	fi
	rm -f "$tmp"
	if [ "$DOCKER_NEEDS_RESTART" = 1 ]; then
		log "Restarting Docker to apply the proxy/CA/mirror settings"
		systemctl daemon-reload
		systemctl restart docker
	fi
}

private_ip() {
	ip -o -4 addr show scope global |
		awk '$2 !~ /^(docker|br-|veth)/ {print $4}' | cut -d/ -f1 |
		grep -E '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)' | head -n1
}

init_swarm() {
	local state
	state="$(docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null || true)"
	if [ "$state" = "active" ]; then
		log "Docker Swarm is already active"
	else
		ADVERTISE_ADDR="${ADVERTISE_ADDR:-$(private_ip)}"
		[ -n "$ADVERTISE_ADDR" ] ||
			die "Could not detect a private IP; set ADVERTISE_ADDR=<server-ip>."
		log "Initialising Docker Swarm on $ADVERTISE_ADDR"
		# shellcheck disable=SC2086
		docker swarm init --advertise-addr "$ADVERTISE_ADDR" ${DOCKER_SWARM_INIT_ARGS:-}
	fi
	docker network inspect dokploy-network >/dev/null 2>&1 ||
		docker network create --driver overlay --attachable dokploy-network >/dev/null
}

random_secret() { openssl rand -hex 32; }

create_secret() {
	docker secret inspect "$1" >/dev/null 2>&1 ||
		random_secret | docker secret create "$1" - >/dev/null
}

prepare_files() {
	mkdir -p "$BASE_DIR"
	chmod 755 "$BASE_DIR"
	if [ -n "${CORPO_CA_FILE:-}" ]; then
		mkdir -p "$CA_DIR"
		openssl x509 -in "$CORPO_CA_FILE" >"$CA_DIR/ca-custom.pem"
		local system_bundle
		for system_bundle in /etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt; do
			if [ -f "$system_bundle" ]; then
				cat "$system_bundle" "$CA_DIR/ca-custom.pem" >"$CA_DIR/ca-bundle.pem"
				break
			fi
		done
		[ -f "$CA_DIR/ca-bundle.pem" ] || cp "$CA_DIR/ca-custom.pem" "$CA_DIR/ca-bundle.pem"
		chmod 644 "$CA_DIR"/*.pem
	fi
}

registry_login() {
	if [ -n "${CORPO_REGISTRY_USER:-}" ] && [ -n "${CORPO_REGISTRY_TOKEN:-}" ]; then
		local registry="${CORPO_IMAGE%%/*}"
		log "Logging in to $registry"
		printf '%s' "$CORPO_REGISTRY_TOKEN" |
			docker login "$registry" -u "$CORPO_REGISTRY_USER" --password-stdin >/dev/null
	fi
}

panel_env_args() {
	PANEL_ENV=()
	if [ -n "$HTTP_PROXY_VALUE" ]; then
		PANEL_ENV+=(
			-e "HTTP_PROXY=$HTTP_PROXY_VALUE" -e "http_proxy=$HTTP_PROXY_VALUE"
			-e "HTTPS_PROXY=$HTTPS_PROXY_VALUE" -e "https_proxy=$HTTPS_PROXY_VALUE"
			-e "NO_PROXY=$NO_PROXY" -e "no_proxy=$NO_PROXY"
			-e "NODE_USE_ENV_PROXY=1"
		)
	fi
	if [ -n "${CORPO_CA_FILE:-}" ]; then
		PANEL_ENV+=(
			-e "NODE_EXTRA_CA_CERTS=$CA_DIR/ca-custom.pem"
			-e "GIT_SSL_CAINFO=$CA_DIR/ca-bundle.pem"
		)
	fi
}

create_services() {
	create_secret dokploy_postgres_password
	create_secret dokploy_auth_secret

	if ! docker service inspect dokploy-postgres >/dev/null 2>&1; then
		log "Creating Postgres"
		docker service create --detach \
			--name dokploy-postgres \
			--constraint 'node.role==manager' \
			--network dokploy-network \
			--env POSTGRES_USER=dokploy \
			--env POSTGRES_DB=dokploy \
			--secret source=dokploy_postgres_password,target=/run/secrets/postgres_password \
			--env POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password \
			--mount type=volume,source=dokploy-postgres,target=/var/lib/postgresql/data \
			"$CORPO_POSTGRES_IMAGE" >/dev/null
	fi

	panel_env_args
	if docker service inspect dokploy >/dev/null 2>&1; then
		log "The Corpo panel service already exists; use 'install.sh update' to change its image"
	else
		log "Creating the Corpo panel ($CORPO_IMAGE)"
		docker service create --detach --with-registry-auth \
			--name dokploy \
			--replicas 1 \
			--network dokploy-network \
			--mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock \
			--mount type=bind,source="$BASE_DIR",target="$BASE_DIR" \
			--mount type=volume,source=dokploy,target=/root/.docker \
			--secret source=dokploy_postgres_password,target=/run/secrets/postgres_password \
			--secret source=dokploy_auth_secret,target=/run/secrets/dokploy_auth_secret \
			--publish published=3000,target=3000,mode=host \
			--update-parallelism 1 \
			--update-order stop-first \
			--constraint 'node.role == manager' \
			-e POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password \
			-e BETTER_AUTH_SECRET_FILE=/run/secrets/dokploy_auth_secret \
			${PANEL_ENV[@]+"${PANEL_ENV[@]}"} \
			"$CORPO_IMAGE" >/dev/null
	fi
}

start_traefik() {
	if docker container inspect dokploy-traefik >/dev/null 2>&1; then
		log "Traefik is already running"
		return
	fi
	# The panel writes traefik.yml on first start; if the file is missing when
	# the container starts, Docker creates a directory in its place.
	log "Waiting for the panel to write the Traefik config"
	local waited=0
	until [ -f "$BASE_DIR/traefik/traefik.yml" ]; do
		sleep 3
		waited=$((waited + 3))
		[ "$waited" -lt 300 ] ||
			die "The panel did not start within 5 minutes; check 'docker service logs dokploy'."
	done
	log "Starting Traefik"
	docker run -d \
		--name dokploy-traefik \
		--restart always \
		--network dokploy-network \
		-v "$BASE_DIR/traefik/traefik.yml:/etc/traefik/traefik.yml" \
		-v "$BASE_DIR/traefik/dynamic:/etc/dokploy/traefik/dynamic" \
		-v /var/run/docker.sock:/var/run/docker.sock:ro \
		-p 80:80/tcp \
		-p 443:443/tcp \
		-p 443:443/udp \
		"$CORPO_TRAEFIK_IMAGE" >/dev/null
}

install_corpo() {
	preflight
	install_ca_system_wide
	install_docker
	check_ports
	configure_docker_daemon
	init_swarm
	prepare_files
	registry_login
	create_services
	start_traefik

	local addr="${ADVERTISE_ADDR:-$(private_ip)}"
	printf '\n\033[0;32mCorpo is installed.\033[0m\n'
	printf 'Open http://%s:3000 to create the admin account.\n' "${addr:-<server-ip>}"
	printf 'Then set up Settings → Gateway (IIS) and Settings → Network.\n\n'
}

update_corpo() {
	preflight
	registry_login
	log "Updating the Corpo panel to $CORPO_IMAGE"
	docker pull "$CORPO_IMAGE" >/dev/null
	prepare_files
	panel_env_args
	local env_updates=() arg
	for arg in ${PANEL_ENV[@]+"${PANEL_ENV[@]}"}; do
		[ "$arg" = "-e" ] || env_updates+=(--env-add "$arg")
	done
	docker service update --detach --with-registry-auth \
		${env_updates[@]+"${env_updates[@]}"} \
		--image "$CORPO_IMAGE" dokploy >/dev/null
	log "Update started; follow it with: docker service ps dokploy"
}

case "${1:-install}" in
install) install_corpo ;;
update) update_corpo ;;
*) die "Usage: install.sh [install|update]" ;;
esac
