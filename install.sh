#!/bin/sh
set -eu
command -v docker >/dev/null || { echo 'Install Docker and Docker Compose first.' >&2; exit 1; }
command -v npm >/dev/null || { echo 'Install Node.js 24 or later first.' >&2; exit 1; }
node -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)' || { echo 'Node.js 24 or later is required.' >&2; exit 1; }
docker compose version >/dev/null
nu_home=${NU_HOME:-"$HOME/.nu"}
nu_uid=$(id -u)
nu_gid=$(id -g)
[ "$nu_uid" != 0 ] || { echo 'Run the installer as your regular host user; Postgres cannot run as root.' >&2; exit 1; }
mkdir -p "$nu_home/workspace" "$nu_home/sandbox" "$nu_home/skills" "$nu_home/packages"
nu_home=$(cd "$nu_home" && pwd)
cat > "$nu_home/compose.yaml" <<'COMPOSE'
services:
  nu:
    image: ghcr.io/rebuno/nu:${NU_VERSION:-latest}
    restart: unless-stopped
    environment:
      SANDBOX_URL: http://sandbox:4121
    user: "${UID:-1000}:${GID:-1000}"
    env_file:
      - path: .env
        required: false
    ports:
      - "127.0.0.1:4122:4122"
    volumes:
      - type: bind
        source: ${NU_HOME:-~/.nu}
        target: /home/nu/.nu
        bind:
          create_host_path: false
  sandbox:
    image: ghcr.io/rebuno/nu:${NU_VERSION:-latest}
    restart: unless-stopped
    user: "${UID:-1000}:${GID:-1000}"
    command: ["node", "--import", "tsx", "src/sandbox/main.ts"]
    environment:
      HOME: /home/nu/.nu/workspace/.home
      NPM_CONFIG_PREFIX: /home/nu/.nu/workspace/.home/.local
      PATH: /home/nu/.nu/workspace/.home/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
    read_only: true
    tmpfs:
      - /tmp:exec
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    mem_limit: 4g
    pids_limit: 1024
    volumes:
      - type: bind
        source: ${NU_HOME:-~/.nu}/workspace
        target: /home/nu/.nu/workspace
        bind:
          create_host_path: false
      - type: bind
        source: ${NU_HOME:-~/.nu}/sandbox
        target: /run/nu-sandbox
        read_only: true
        bind:
          create_host_path: false
      - type: bind
        source: ${NU_HOME:-~/.nu}/skills
        target: /home/nu/.nu/skills
        read_only: true
        bind:
          create_host_path: false
      - type: bind
        source: ${NU_HOME:-~/.nu}/packages
        target: /home/nu/.nu/packages
        read_only: true
        bind:
          create_host_path: false
  dashboard:
    image: ghcr.io/rebuno/dashboard:latest
    profiles: [dashboard]
    restart: unless-stopped
    depends_on: [nu]
    user: "${UID:-1000}:${GID:-1000}"
    environment:
      REBUNO_URL: http://nu:4117
    command:
      - sh
      - -c
      - until [ -s /run/nu/admin_token ]; do sleep 1; done; REBUNO_API_KEY=$$(cat /run/nu/admin_token) exec node server.js
    ports:
      - "127.0.0.1:${NU_DASHBOARD_PORT:-4116}:3000"
      - "[::1]:${NU_DASHBOARD_PORT:-4116}:3000"
    volumes:
      - type: bind
        source: ${NU_HOME:-~/.nu}/secrets
        target: /run/nu
        read_only: true
COMPOSE
if [ ! -e "$nu_home/compose.override.yaml" ]; then
  cat > "$nu_home/compose.override.yaml" <<'COMPOSE'
# Your changes to Nu's services. compose.yaml is replaced on every update.
# To let Nu work on a folder, replace the line below with:
# services:
#   sandbox:
#     volumes:
#       - ${HOME}/projects:${HOME}/projects
services: {}
COMPOSE
fi
# Compose reads .env for interpolation, so plain `docker compose` keeps the host UID/GID and data directory.
nu_env="$nu_home/.env"
touch "$nu_env"
nu_escaped_home=$(printf '%s' "$nu_home" | sed "s/'/\\\\'/g")
{ grep -v -E '^(UID|GID|NU_HOME)=' "$nu_env" || true; printf "UID=%s\nGID=%s\nNU_HOME='%s'\n" "$nu_uid" "$nu_gid" "$nu_escaped_home"; } > "$nu_env.tmp"
mv "$nu_env.tmp" "$nu_env"
chmod 600 "$nu_env"
nu_version=$(sed -n 's/^NU_VERSION=//p' "$nu_env" | tail -n 1)
(cd "$nu_home" && docker compose pull && docker compose up -d)
npm install -g "@rebuno/nu@${nu_version:-latest}"
printf '\nRun nu login to list model providers, then nu login <provider> to sign in.\n'
if [ "$nu_home" != "$HOME/.nu" ]; then
  printf 'Set NU_HOME=%s in your shell so the client can find its token.\n' "$nu_home"
fi
printf 'Manage the server with docker compose from %s.\n' "$nu_home"
