#!/usr/bin/env bash
# Reference deployment service for Platform → Infrastructure & releases (set PLATFORM_DEPLOY_COMMAND to this file).
# Review it against your servers before use: paths, unit names and the nginx canary split are site-specific.
#
#   azcentrix-deploy.sh validate <version>                       tag <version> exists and the configuration is complete
#   azcentrix-deploy.sh deploy   <version> <percent> <current|->  < 100: canary instance + nginx split; 100: production
#   azcentrix-deploy.sh rollback <version> <from>                switch production back to an installed release
#
# Layout:   $APP_ROOT/releases/<version>   a build of git tag <version>
#           $APP_ROOT/current -> releases/<version>   production (API + Celery units run from current/backend,
#                                                       nginx serves current/frontend/dist)
#           $APP_ROOT/canary  -> releases/<version>   the canary instance ($CANARY_SERVICE) during a canary
#           $APP_ROOT/shared/  .env and the data folders every release shares ($SHARED_DIRS)
# Settings: /etc/azcentrix/deploy.env (or $AZX_DEPLOY_CONFIG) may override any variable below.
#
# deploy / rollback re-run themselves in a transient systemd unit, so restarting the API does not kill them, and finish
# by writing {"ok": …, "message": …} to $AZX_RELEASE_RESULT_FILE – the platform only trusts that file.
# The API user needs:   www-data ALL=(root) NOPASSWD: /usr/bin/systemd-run
# Tenant databases are not touched here: each release migrates them itself when it starts.
set -Eeuo pipefail

CONFIG=${AZX_DEPLOY_CONFIG:-/etc/azcentrix/deploy.env}
# shellcheck disable=SC1090
[ -f "$CONFIG" ] && . "$CONFIG"
APP_ROOT=${APP_ROOT:-/var/www/azcentrix-connect}
REPO_DIR=${REPO_DIR:-$APP_ROOT/repo}                 # git clone that receives the release tags
SERVICES=${SERVICES:-"azcentrix-api celery-worker"}  # systemd units running $APP_ROOT/current
SHARED_DIRS=${SHARED_DIRS:-"uploads media logs deploy_state storage_quarantine"}
HEALTH_URL=${HEALTH_URL:-http://127.0.0.1:8002/health}
CANARY_SERVICE=${CANARY_SERVICE:-}                   # unit running $APP_ROOT/canary on its own port (empty = no canary)
CANARY_HEALTH_URL=${CANARY_HEALTH_URL:-}
NGINX_SPLIT_FILE=${NGINX_SPLIT_FILE:-}               # nginx include that defines $azcentrix_api_upstream
STABLE_UPSTREAM=${STABLE_UPSTREAM:-azcentrix_api}
CANARY_UPSTREAM=${CANARY_UPSTREAM:-azcentrix_canary}

action=${1:-}
version=${2:-}

finish() {  # finish true|false "message"
  local message=${2//\\//}
  message=${message//\"/\'}
  [ -n "${AZX_RELEASE_RESULT_FILE:-}" ] && printf '{"ok": %s, "message": "%s"}\n' "$1" "$message" > "$AZX_RELEASE_RESULT_FILE"
  echo "$2"
  [ "$1" = true ] || exit 1
}

if [ "$action" != validate ] && [ -z "${AZX_DETACHED:-}" ] && command -v systemd-run >/dev/null 2>&1; then
  exec sudo -n systemd-run --quiet --collect --unit="azcentrix-deploy-${AZX_RELEASE_STEP:-$$}" \
    --setenv=AZX_DETACHED=1 --setenv=AZX_DEPLOY_CONFIG="$CONFIG" --setenv=AZX_RELEASE_STEP="${AZX_RELEASE_STEP:-}" \
    --setenv=AZX_RELEASE_RESULT_FILE="${AZX_RELEASE_RESULT_FILE:-}" --setenv=AZX_LOG="${AZX_RELEASE_LOG_FILE:-/dev/null}" \
    /bin/bash -c 'exec "$0" "$@" >>"$AZX_LOG" 2>&1' "$(readlink -f "$0")" "$@"
fi
[ "$action" = validate ] || trap 'finish false "Step failed at line $LINENO: $BASH_COMMAND"' ERR

release_dir() { echo "$APP_ROOT/releases/$1"; }

stage() {  # build tag $1 into releases/$1 (once)
  local dir; dir=$(release_dir "$1")
  [ -f "$dir/backend/VERSION" ] && return 0
  rm -rf "$dir" && mkdir -p "$dir"
  git -C "$REPO_DIR" archive "refs/tags/$1" | tar -x -C "$dir"
  python3 -m venv "$dir/backend/venv"
  "$dir/backend/venv/bin/pip" install --quiet -r "$dir/backend/requirements.txt"
  ln -sfn "$APP_ROOT/shared/.env" "$dir/backend/.env"
  for shared in $SHARED_DIRS; do mkdir -p "$APP_ROOT/shared/$shared"; rm -rf "${dir:?}/backend/$shared"; ln -s "$APP_ROOT/shared/$shared" "$dir/backend/$shared"; done
  (cd "$dir/frontend" && npm ci --silent && AZX_RELEASE="$1" npm run build --silent)
  echo "$1" > "$dir/backend/VERSION"  # written last: marks a complete build
}

switch() {  # make release $1 production and restart its units
  ln -sfn "$(release_dir "$1")" "$APP_ROOT/current.next" && mv -T "$APP_ROOT/current.next" "$APP_ROOT/current"
  for unit in $SERVICES; do systemctl restart "$unit"; done
}

split() {  # send $1 % of API traffic to the canary upstream
  [ -n "$NGINX_SPLIT_FILE" ] || return 0
  if [ "$1" -gt 0 ]; then
    printf 'split_clients "${remote_addr}${http_user_agent}" $azcentrix_api_upstream {\n    %s%% %s;\n    * %s;\n}\n' "$1" "$CANARY_UPSTREAM" "$STABLE_UPSTREAM" > "$NGINX_SPLIT_FILE"
  else
    printf 'split_clients "${remote_addr}" $azcentrix_api_upstream {\n    * %s;\n}\n' "$STABLE_UPSTREAM" > "$NGINX_SPLIT_FILE"
  fi
  nginx -t -q && systemctl reload nginx
}

healthy() { curl -fsS --max-time 5 --retry 20 --retry-delay 3 --retry-connrefused "$1" >/dev/null; }

stop_canary() {
  split 0
  [ -z "$CANARY_SERVICE" ] || systemctl stop "$CANARY_SERVICE" || true
}

case "$action" in
  validate)
    [ -n "$version" ] || { echo "Usage: $0 validate <version>"; exit 2; }
    [ -d "$REPO_DIR/.git" ] || { echo "REPO_DIR $REPO_DIR is not a git clone"; exit 2; }
    git -C "$REPO_DIR" fetch --tags --quiet
    git -C "$REPO_DIR" rev-parse -q --verify "refs/tags/$version^{commit}" >/dev/null || { echo "Git tag $version not found in $REPO_DIR"; exit 3; }
    [ -f "$APP_ROOT/shared/.env" ] || { echo "Missing $APP_ROOT/shared/.env"; exit 4; }
    for unit in $SERVICES ${CANARY_SERVICE:-}; do systemctl cat "$unit" >/dev/null 2>&1 || { echo "systemd unit $unit not found"; exit 5; }; done
    echo "Tag $version found at $(git -C "$REPO_DIR" rev-parse --short "refs/tags/$version^{commit}")"
    ;;
  deploy)
    percent=${3:?percent}
    current=${4:--}
    stage "$version"
    if [ "$percent" -ge 100 ]; then
      switch "$version"
      if ! healthy "$HEALTH_URL"; then
        trap - ERR
        if [ "$current" != - ] && [ -f "$(release_dir "$current")/backend/VERSION" ]; then
          switch "$current"
          finish false "$version failed its health check after the switch; production restored to $current"
        fi
        finish false "$version failed its health check after the switch and no previous release is installed"
      fi
      stop_canary
      finish true "$version is production (100% of traffic)"
    else
      [ -n "$CANARY_SERVICE" ] && [ -n "$NGINX_SPLIT_FILE" ] || finish false "A canary needs CANARY_SERVICE and NGINX_SPLIT_FILE – or turn off Canary releases in Control Center"
      ln -sfn "$(release_dir "$version")" "$APP_ROOT/canary"
      systemctl restart "$CANARY_SERVICE"
      [ -z "$CANARY_HEALTH_URL" ] || healthy "$CANARY_HEALTH_URL" || { trap - ERR; stop_canary; finish false "Canary $version failed its health check; all traffic stays on the production release"; }
      split "$percent"
      finish true "$version serving $percent% of traffic"
    fi
    ;;
  rollback)
    [ -f "$(release_dir "$version")/backend/VERSION" ] || finish false "Release $version is not installed in $(release_dir "$version")"
    stop_canary
    if [ "$(readlink -f "$APP_ROOT/current")" != "$(readlink -f "$(release_dir "$version")")" ]; then
      switch "$version"
    fi
    healthy "$HEALTH_URL" || finish false "Rolled back to $version but its health check fails"
    finish true "Rolled back to $version (100% of traffic)"
    ;;
  *)
    echo "Usage: $0 validate|deploy|rollback <version> …"
    exit 2
    ;;
esac
