#!/usr/bin/env bash
# Entrypoint for the Claude Code sandbox image.
#
# Usage: <image> [MODE] [ARGS...]
#
#   auto            (default) runner if an environment secret is set, otherwise
#                   `interactive` when a TTY is attached, otherwise `server`
#   interactive     Claude Code in the terminal; also reachable from claude.ai/code
#                   and the Claude app via Remote Control when a claude.ai login exists
#   server          background service: self-hosted runner > web UI, which runs
#                   Remote Control when it can > (CLAUDE_WEBUI=0) Remote Control > idle
#   webui           the web UI on port CLAUDE_WEBUI_PORT (default 8765)
#   remote-control  `claude remote-control` server (needs a claude.ai login)
#   runner          `claude self-hosted-runner` (Team/Enterprise environment secret)
#   login           one-time `claude auth login`, stored in the config volume
#   setup-token     print a long-lived CLAUDE_CODE_OAUTH_TOKEN for use elsewhere
#   status          show what the container detected and would run (--json for JSON)
#   prepare         apply settings (git identity and credentials, GIT_REPO_URL) and exit
#   shell           bash login shell as the sandbox user
#   idle            stay up so you can `docker exec` in
#   help            this text
#
# Any other first argument is run as a command (for example `claude -p "hi"`).
# A first argument starting with `-` is passed to Claude Code in interactive mode.
# shellcheck disable=SC2016,SC2001  # jq programs use $vars; sed prefixes multi-line text
set -Eeuo pipefail

readonly SANDBOX_USER=claude
readonly REAL_CLAUDE=/usr/local/lib/claude-code/claude
readonly SANDBOX_LIB="${CLAUDE_SANDBOX_LIB:-/usr/local/lib/claude-sandbox}"

WORKDIR="${CLAUDE_WORKDIR:-/workspace}"
export CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-/home/${SANDBOX_USER}/.claude}"

# shellcheck source=docker/settings.sh
. "$SANDBOX_LIB/settings.sh"

log()  { printf '[claude-sandbox] %s\n' "$*" >&2; }
warn() { printf '[claude-sandbox] WARNING: %s\n' "$*" >&2; }
die()  { printf '[claude-sandbox] ERROR: %s\n' "$*" >&2; exit 1; }

is_true() {
  case "${1:-}" in
    1 | true | TRUE | True | yes | YES | Yes | on | ON | On) return 0 ;;
    *) return 1 ;;
  esac
}

json_bool() { if "$@"; then echo true; else echo false; fi; }

usage() { sed -n '2,/^set -Eeuo/{/^set -Eeuo/d;/shellcheck/d;s/^# \{0,1\}//;p;}' "$0"; }

# Prefer the real binary so a missing wrapper never matters inside this script.
claude_bin() {
  if [[ -x $REAL_CLAUDE ]]; then "$REAL_CLAUDE" "$@"; else command claude "$@"; fi
}

# ---------------------------------------------------------------------------
# Secrets: every credential variable also accepts <NAME>_FILE (Docker/K8s secrets).
# ---------------------------------------------------------------------------
readonly SECRET_VARS=(
  ANTHROPIC_API_KEY
  ANTHROPIC_AUTH_TOKEN
  CLAUDE_CODE_OAUTH_TOKEN
  CLAUDE_WEBUI_PASSWORD
  GH_TOKEN
  GITHUB_TOKEN
  SELF_HOSTED_RUNNER_ENVIRONMENT_SECRET
)

trim() {
  local s="$1"
  s="${s//$'\r'/}"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

load_secret_files() {
  local var file_var file
  for var in "${SECRET_VARS[@]}"; do
    file_var="${var}_FILE"
    file="${!file_var:-}"
    [[ -n $file ]] || continue
    if [[ -n ${!var:-} ]]; then
      die "set either $var or $file_var, not both"
    fi
    [[ -r $file ]] || die "$file_var points to '$file', which does not exist or is not readable"
    export "$var=$(trim "$(<"$file")")"
    unset "$file_var"
  done
}

# ---------------------------------------------------------------------------
# Root phase: match the host user's UID/GID, fix ownership, optional sudo, then
# re-run this script as the unprivileged sandbox user. Skipped when the
# container is started as non-root (for example Kubernetes runAsUser).
# ---------------------------------------------------------------------------
run_as_sandbox_user() {
  if command -v gosu >/dev/null 2>&1; then
    exec gosu "$SANDBOX_USER" "$@"
  fi
  export HOME="/home/${SANDBOX_USER}" USER="$SANDBOX_USER" LOGNAME="$SANDBOX_USER"
  exec setpriv --reuid="$SANDBOX_USER" --regid="$SANDBOX_USER" --init-groups "$@"
}

root_phase() {
  local home="/home/${SANDBOX_USER}"
  local cur_uid cur_gid want_uid want_gid
  cur_uid="$(id -u "$SANDBOX_USER")"
  cur_gid="$(id -g "$SANDBOX_USER")"
  want_uid="${HOST_UID:-}"
  want_gid="${HOST_GID:-}"

  # Bind-mounted projects on Linux: adopt the owner of the workspace so files
  # Claude creates are owned by you on the host.
  if [[ -z $want_uid ]] && is_true "${CLAUDE_MATCH_WORKSPACE_OWNER:-1}" && [[ -d $WORKDIR ]]; then
    local owner group
    owner="$(stat -c %u "$WORKDIR")"
    group="$(stat -c %g "$WORKDIR")"
    if [[ $owner != 0 ]]; then
      want_uid="$owner"
      want_gid="${want_gid:-$group}"
    fi
  fi
  want_uid="${want_uid:-$cur_uid}"
  want_gid="${want_gid:-$cur_gid}"

  [[ $want_uid =~ ^[0-9]+$ && $want_gid =~ ^[0-9]+$ ]] || die "HOST_UID/HOST_GID must be numeric (got '$want_uid'/'$want_gid')"
  [[ $want_uid != 0 ]] || die "HOST_UID=0 is not supported: Claude Code runs as an unprivileged user in this image"

  local changed=0
  if [[ $want_gid != "$cur_gid" ]]; then
    groupmod --non-unique --gid "$want_gid" "$SANDBOX_USER"
    changed=1
  fi
  if [[ $want_uid != "$cur_uid" ]]; then
    usermod --non-unique --uid "$want_uid" "$SANDBOX_USER"
    changed=1
  fi
  mkdir -p "$CLAUDE_CONFIG_DIR" "$WORKDIR"
  if ((changed)); then
    log "running as uid=$want_uid gid=$want_gid"
    chown -R "$SANDBOX_USER:$SANDBOX_USER" "$home"
    # The image's own /workspace (or a volume it seeded) still belongs to the
    # previous UID; a bind mount owned by someone else is left alone.
    if [[ $(stat -c %u "$WORKDIR") == "$cur_uid" ]]; then
      chown -R "$SANDBOX_USER:$SANDBOX_USER" "$WORKDIR"
    fi
  fi

  # Fresh volumes and bind mounts can arrive root-owned.
  local dir
  for dir in "$home" "$CLAUDE_CONFIG_DIR"; do
    if [[ $(stat -c %u "$dir") != "$want_uid" ]]; then
      chown -R "$SANDBOX_USER:$SANDBOX_USER" "$dir"
    fi
  done
  if [[ $(stat -c %u "$WORKDIR") == 0 && -z $(ls -A "$WORKDIR") ]]; then
    chown "$SANDBOX_USER:$SANDBOX_USER" "$WORKDIR"
  fi

  if is_true "${CLAUDE_SUDO:-0}"; then
    printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$SANDBOX_USER" >/etc/sudoers.d/claude-sandbox
    chmod 0440 /etc/sudoers.d/claude-sandbox
    log "passwordless sudo enabled for $SANDBOX_USER (CLAUDE_SUDO)"
  else
    rm -f /etc/sudoers.d/claude-sandbox
  fi

  start_docker "${1:-${CLAUDE_MODE:-auto}}"
  run_as_sandbox_user "$0" "$@"
}

# ---------------------------------------------------------------------------
# Docker inside the sandbox: CLAUDE_DOCKER=1 in a privileged container (see
# compose.docker.yaml). dockerd runs as root; the claude user reaches it through
# the docker group. Containers it runs stop when the sandbox stops.
# ---------------------------------------------------------------------------
start_docker() {
  local mode="$1" log=/var/log/dockerd.log capeff pid _
  is_true "${CLAUDE_DOCKER:-0}" || return 0
  case "$mode" in
    login | setup-token | status | prepare | version | help | --help | -h) return 0 ;; # one-off commands
  esac
  if docker info >/dev/null 2>&1; then
    log "CLAUDE_DOCKER: using the Docker daemon that's already reachable"
    return 0
  fi
  if ! command -v dockerd >/dev/null 2>&1; then
    warn "CLAUDE_DOCKER is set, but this image has no dockerd"
    return 0
  fi
  capeff="$(awk '/^CapEff:/ { print $2 }' /proc/self/status)"
  if (((16#$capeff >> 21 & 1) == 0)); then # no CAP_SYS_ADMIN: not privileged
    warn "CLAUDE_DOCKER needs a privileged container (privileged: true, as in compose.docker.yaml); not starting Docker"
    return 0
  fi
  # What Docker's own dind script does: cgroup v2 nesting, AppArmor detection
  # and shared mount propagation.
  if [[ -f /sys/fs/cgroup/cgroup.controllers ]]; then
    mkdir -p /sys/fs/cgroup/init
    xargs -rn1 </sys/fs/cgroup/cgroup.procs >/sys/fs/cgroup/init/cgroup.procs 2>/dev/null || true
    sed -e 's/ / +/g' -e 's/^/+/' </sys/fs/cgroup/cgroup.controllers >/sys/fs/cgroup/cgroup.subtree_control 2>/dev/null || true
  fi
  if [[ -d /sys/kernel/security ]] && ! mountpoint -q /sys/kernel/security; then
    mount -t securityfs none /sys/kernel/security 2>/dev/null || true
  fi
  mount --make-rshared / 2>/dev/null || true
  # A restarted container still has the previous run's pid file and socket.
  rm -rf /var/run/docker.pid /var/run/docker.sock /var/run/docker
  log "CLAUDE_DOCKER: starting Docker (log in $log)"
  container=docker dockerd --group docker >"$log" 2>&1 &
  pid=$!
  for _ in $(seq 1 60); do
    if docker info >/dev/null 2>&1; then
      log "Docker $(docker info --format '{{.ServerVersion}}' 2>/dev/null) is running; the $SANDBOX_USER user can use it"
      return 0
    fi
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  warn "Docker didn't start; the end of $log:"
  tail -n 15 "$log" | sed 's/^/  /' >&2
}

docker_version() { # server version of a reachable Docker daemon, or nothing
  local v
  v="$(timeout 3 docker info --format '{{.ServerVersion}}' 2>/dev/null || true)"
  [[ $v =~ ^[0-9][0-9A-Za-z.+~-]*$ ]] && printf '%s\n' "$v"
  return 0
}

# ---------------------------------------------------------------------------
# Claude Code config seeding ($CLAUDE_CONFIG_DIR/.claude.json and settings.json)
# so a fresh container starts without interactive first-run prompts.
# ---------------------------------------------------------------------------
json_update() {
  local file="$1" filter="$2"
  shift 2
  if [[ ! -s $file ]]; then
    (umask 077 && printf '{}\n' >"$file")
  fi
  if ! jq -e 'type == "object"' "$file" >/dev/null 2>&1; then
    warn "$file is not a JSON object; leaving it untouched"
    return 0
  fi
  local tmp
  tmp="$(mktemp "${file}.XXXXXX")"
  if jq "$@" "$filter" "$file" >"$tmp"; then
    chmod 600 "$tmp"
    mv -f "$tmp" "$file"
  else
    rm -f "$tmp"
    warn "could not update $file"
  fi
}

seed_config() {
  local global="$CLAUDE_CONFIG_DIR/.claude.json"
  local filter='.hasCompletedOnboarding = true'
  local key_fragment=""

  if is_true "${CLAUDE_TRUST_WORKSPACE:-1}"; then
    filter+=' | .projects[$dir].hasTrustDialogAccepted = true'
  fi
  if [[ -n ${ANTHROPIC_API_KEY:-} ]]; then
    # Claude Code remembers approved keys by their last 20 characters.
    key_fragment="$(trim "$ANTHROPIC_API_KEY")"
    key_fragment="${key_fragment: -20}"
    filter+=' | .customApiKeyResponses.approved = (((.customApiKeyResponses.approved // []) - [$key]) + [$key])'
    filter+=' | .customApiKeyResponses.rejected = ((.customApiKeyResponses.rejected // []) - [$key])'
  fi
  json_update "$global" "$filter" --arg dir "$WORKDIR" --arg key "$key_fragment"

  if [[ ${CLAUDE_PERMISSION_MODE:-} == bypassPermissions ]]; then
    json_update "$CLAUDE_CONFIG_DIR/settings.json" '.skipDangerousModePermissionPrompt = true'
  fi
}

# Accept Remote Control's one-time consent and pick a spawn mode, so the server
# never waits on a y/n prompt nobody can see.
seed_remote_control_config() {
  local spawn="$1"
  json_update "$CLAUDE_CONFIG_DIR/.claude.json" \
    '.remoteDialogSeen = true | .projects[$dir].remoteControlSpawnMode //= $spawn' \
    --arg dir "$WORKDIR" --arg spawn "$spawn"
}

# ---------------------------------------------------------------------------
# Git / GitHub
# ---------------------------------------------------------------------------
configure_git() {
  local gc=(git config --global)
  if [[ -n ${GIT_USER_NAME:-} ]]; then
    "${gc[@]}" user.name "$GIT_USER_NAME" || warn "could not set git user.name"
  fi
  if [[ -n ${GIT_USER_EMAIL:-} ]]; then
    "${gc[@]}" user.email "$GIT_USER_EMAIL" || warn "could not set git user.email"
  fi
  if [[ -n ${GH_TOKEN:-}${GITHUB_TOKEN:-} ]] && command -v gh >/dev/null 2>&1; then
    local host
    for host in https://github.com https://gist.github.com; do
      "${gc[@]}" --unset-all "credential.${host}.helper" >/dev/null 2>&1 || true
      if ! { "${gc[@]}" --add "credential.${host}.helper" '' &&
        "${gc[@]}" --add "credential.${host}.helper" '!gh auth git-credential'; }; then
        warn "could not configure the git credential helper for $host"
      fi
    done
  fi
}

clone_repo() {
  [[ -n ${GIT_REPO_URL:-} ]] || return 0
  mkdir -p "$WORKDIR"
  if git -C "$WORKDIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    log "$WORKDIR is already a git checkout; not cloning $GIT_REPO_URL"
    return 0
  fi
  if [[ -n $(ls -A "$WORKDIR") ]]; then
    warn "$WORKDIR is not empty; not cloning $GIT_REPO_URL"
    return 0
  fi
  log "cloning $GIT_REPO_URL into $WORKDIR"
  local args=(clone)
  [[ -z ${GIT_REPO_BRANCH:-} ]] || args+=(--branch "$GIT_REPO_BRANCH")
  git "${args[@]}" -- "$GIT_REPO_URL" "$WORKDIR" || die "git clone of $GIT_REPO_URL failed"
}

# ---------------------------------------------------------------------------
# Credential detection
# ---------------------------------------------------------------------------
auth_method() { # how Claude Code would authenticate with the current environment
  local out
  out="$(claude_bin auth status --json 2>/dev/null || true)"
  [[ -n $out ]] || out='{}'
  jq -r '.authMethod // "none"' <<<"$out" 2>/dev/null || printf 'unknown\n'
}

stored_login_status() { # `claude auth status --json` for the login stored in the config dir
  local out
  out="$(env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CODE_OAUTH_TOKEN \
    "$REAL_CLAUDE" auth status --json 2>/dev/null || true)"
  jq -ce 'objects' <<<"$out" 2>/dev/null || printf '{}\n'
}

has_claudeai_login() { # a full-scope `claude auth login` stored in the config dir
  [[ $(stored_login_status | jq -r '.authMethod // "none"') == claude.ai ]]
}

has_runner_secret() { [[ -n ${SELF_HOSTED_RUNNER_ENVIRONMENT_SECRET:-} ]]; }

# Prints one line per reason Remote Control can't run; prints nothing if it can.
remote_control_blockers() {
  if ! is_true "${CLAUDE_REMOTE_CONTROL:-1}"; then
    echo "CLAUDE_REMOTE_CONTROL is turned off"
    return 0
  fi
  if [[ -n ${ANTHROPIC_API_KEY:-} ]]; then
    echo "ANTHROPIC_API_KEY is set (Remote Control needs claude.ai subscription auth, not an API key)"
  fi
  if [[ -n ${ANTHROPIC_AUTH_TOKEN:-} ]]; then
    echo "ANTHROPIC_AUTH_TOKEN is set (Remote Control needs claude.ai subscription auth)"
  fi
  if [[ -n ${ANTHROPIC_BASE_URL:-} && ${ANTHROPIC_BASE_URL%/} != https://api.anthropic.com ]]; then
    echo "ANTHROPIC_BASE_URL points somewhere other than api.anthropic.com"
  fi
  local v
  for v in CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY; do
    if is_true "${!v:-}"; then echo "$v is set (Remote Control needs the Anthropic API)"; fi
  done
  for v in CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC DISABLE_GROWTHBOOK; do
    if [[ -n ${!v:-} ]]; then echo "$v is set (Remote Control needs feature-flag evaluation)"; fi
  done
  if ! has_claudeai_login; then
    echo "no claude.ai login in $CLAUDE_CONFIG_DIR: run the 'login' command once (a CLAUDE_CODE_OAUTH_TOKEN can't start Remote Control)"
  fi
}

# Long-lived setup tokens outrank a stored login but can't open Remote Control.
prefer_stored_login() {
  if [[ -n ${CLAUDE_CODE_OAUTH_TOKEN:-} ]]; then
    log "using the stored claude.ai login instead of CLAUDE_CODE_OAUTH_TOKEN (Remote Control needs a full-scope login)"
    unset CLAUDE_CODE_OAUTH_TOKEN
  fi
}

extra_args() { # CLAUDE_ARGS, split on whitespace
  EXTRA_ARGS=()
  if [[ -n ${CLAUDE_ARGS:-} ]]; then
    read -r -a EXTRA_ARGS <<<"$CLAUDE_ARGS"
  fi
}

run() { # exec, or print the command when CLAUDE_SANDBOX_DRY_RUN is set
  if is_true "${CLAUDE_SANDBOX_DRY_RUN:-0}"; then
    printf '[claude-sandbox] would run (in %s):' "$PWD" >&2
    printf ' %q' "$@" >&2
    printf '\n' >&2
    exit 0
  fi
  exec "$@"
}

# ---------------------------------------------------------------------------
# Modes
# ---------------------------------------------------------------------------
mode_interactive() {
  cd "$WORKDIR"
  extra_args
  local args=() rc_name_last=0
  [[ -z ${CLAUDE_PERMISSION_MODE:-} ]] || args+=(--permission-mode "$CLAUDE_PERMISSION_MODE")
  if [[ -z $(remote_control_blockers) ]]; then
    prefer_stored_login
    seed_remote_control_config same-dir
    if [[ -n ${CLAUDE_RC_NAME:-} ]]; then
      args+=(--remote-control "$CLAUDE_RC_NAME")
    else
      rc_name_last=1 # bare flag goes last so it can't swallow a prompt argument
    fi
    log "Remote Control on: this session also appears at https://claude.ai/code and in the Claude app"
  fi
  args+=("${EXTRA_ARGS[@]}" "$@")
  if ((rc_name_last)); then
    args+=(--remote-control)
  fi
  run "$REAL_CLAUDE" "${args[@]}"
}

mode_remote_control() {
  local blockers
  blockers="$(remote_control_blockers)"
  if [[ -n $blockers ]]; then
    printf '[claude-sandbox] ERROR: Remote Control cannot start:\n' >&2
    sed 's/^/  - /' <<<"$blockers" >&2
    exit 1
  fi
  prefer_stored_login
  cd "$WORKDIR"
  extra_args

  local spawn="${CLAUDE_RC_SPAWN:-same-dir}"
  if [[ $spawn == worktree ]] && ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    warn "CLAUDE_RC_SPAWN=worktree needs a git repository in $WORKDIR; using same-dir"
    spawn=same-dir
  fi
  seed_remote_control_config "$spawn"

  local args=(remote-control --spawn "$spawn")
  [[ -z ${CLAUDE_RC_NAME:-} ]] || args+=(--name "$CLAUDE_RC_NAME")
  [[ -z ${CLAUDE_RC_CAPACITY:-} ]] || args+=(--capacity "$CLAUDE_RC_CAPACITY")
  [[ -z ${CLAUDE_PERMISSION_MODE:-} ]] || args+=(--permission-mode "$CLAUDE_PERMISSION_MODE")
  log "starting Remote Control: open https://claude.ai/code or the Claude app to use this container"
  run "$REAL_CLAUDE" "${args[@]}" "${EXTRA_ARGS[@]}" "$@"
}

mode_runner() {
  has_runner_secret || die "runner mode needs SELF_HOSTED_RUNNER_ENVIRONMENT_SECRET (or ..._FILE): the environment key from claude.ai > Admin settings > Cloud environments"
  extra_args

  # Sessions get session-scoped tokens from Anthropic; personal credentials
  # would only leak into them.
  local v
  for v in ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN; do
    if [[ -n ${!v:-} ]]; then
      log "runner mode: not passing $v to runner sessions"
      unset "$v"
    fi
  done

  # Hand the secret over as a private file rather than leaving it in the
  # environment every session inherits.
  local secret_dir secret_file
  secret_dir="$(mktemp -d /tmp/claude-runner.XXXXXX)"
  secret_file="$secret_dir/environment-secret"
  (umask 077 && printf '%s' "$SELF_HOSTED_RUNNER_ENVIRONMENT_SECRET" >"$secret_file")
  unset SELF_HOSTED_RUNNER_ENVIRONMENT_SECRET

  # Without a GitHub token, let Anthropic serve git for github.com repositories.
  local capacity="${CLAUDE_RUNNER_CAPACITY:-1}"
  if [[ -z ${CLAUDE_RUNNER_USE_GIT_PROXY:-} && -z ${GH_TOKEN:-}${GITHUB_TOKEN:-} && $capacity == 1 ]]; then
    export CLAUDE_RUNNER_USE_GIT_PROXY=1
    log "no GH_TOKEN: using the Anthropic git proxy for github.com repositories"
  fi

  local base_dir="${SELF_HOSTED_RUNNER_BASE_DIR:-$WORKDIR}"
  mkdir -p "$base_dir"
  cd "$base_dir"
  log "starting self-hosted runner: pick this environment when you start a session at https://claude.ai/code"
  run "$REAL_CLAUDE" self-hosted-runner \
    --environment-secret-file "$secret_file" \
    --base-dir "$base_dir" \
    --capacity "$capacity" \
    "${EXTRA_ARGS[@]}" "$@"
}

mode_idle() {
  if [[ -n ${1:-} ]]; then
    log "nothing to serve in the background:"
    sed 's/^/[claude-sandbox]   - /' <<<"$1" >&2
  fi
  log "container is idle; open Claude Code with: docker exec -it <container> claude"
  run sleep infinity
}

mode_webui() {
  local server="$SANDBOX_LIB/webui/server.mjs" node=/usr/local/bin/node
  [[ -r $server ]] || die "the web UI is not installed in this image ($server)"
  [[ -x $node ]] || node=node
  # The web UI reads the saved settings itself, and the Remote Control it starts
  # loads them again, so hand it the container's own environment.
  local env_args=() v
  for v in "${CLAUDE_SANDBOX_SETTINGS_LOADED[@]}"; do env_args+=(-u "$v"); done
  if [[ -n $WEBUI_PASSWORD ]]; then export CLAUDE_WEBUI_PASSWORD="$WEBUI_PASSWORD"; fi
  cd "$WORKDIR"
  run env "${env_args[@]}" "$node" "$server" "$@"
}

mode_server() {
  if has_runner_secret; then
    mode_runner "$@"
  fi
  if is_true "${CLAUDE_WEBUI:-1}"; then
    mode_webui "$@"
  fi
  local blockers
  blockers="$(remote_control_blockers)"
  if [[ -z $blockers ]]; then
    mode_remote_control "$@"
  fi
  mode_idle "$blockers"
}

mode_login() {
  # A pipe or socket is fine too: the web UI drives this command and passes the code in.
  [[ -t 0 || -p /dev/stdin || -S /dev/stdin ]] || die "login needs an interactive terminal: docker compose run --rm claude login (or docker run -it ... login)"
  log "signing in to claude.ai; the login is saved in $CLAUDE_CONFIG_DIR (keep it on a volume)"
  log "if no browser opens, open the URL shown below on any device and paste the code back here"
  env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CODE_OAUTH_TOKEN \
    "$REAL_CLAUDE" auth login "$@"
  seed_remote_control_config same-dir
  log "done. Start the background service (docker compose up -d) to reach this container from claude.ai/code and the Claude app."
  if [[ -n ${ANTHROPIC_API_KEY:-}${ANTHROPIC_AUTH_TOKEN:-} ]]; then
    warn "ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN is set and takes precedence over this login; unset it to use your plan and Remote Control"
  fi
}

status_json() {
  local method="$1" mode="$2" login rc_blockers git_json='{"repo": false}'
  login="$(stored_login_status)"
  # Reasons Remote Control couldn't start even if it were turned on.
  rc_blockers="$(CLAUDE_REMOTE_CONTROL=1 remote_control_blockers)"
  if git -C "$WORKDIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git_json="$(jq -n \
      --arg branch "$(git -C "$WORKDIR" branch --show-current 2>/dev/null || true)" \
      --arg remote "$(git -C "$WORKDIR" remote get-url origin 2>/dev/null | sed -E 's#://[^/@]+@#://#' || true)" \
      --arg commit "$(git -C "$WORKDIR" log -1 --format='%h %s' 2>/dev/null || true)" \
      '{repo: true, branch: $branch, remote: $remote, commit: $commit}')"
  fi
  jq -n \
    --arg claudeCode "$("$REAL_CLAUDE" --version 2>/dev/null || echo unknown)" \
    --arg user "$(id -un)" --argjson uid "$(id -u)" --argjson gid "$(id -g)" \
    --arg hostname "${HOSTNAME:-}" --arg workspace "$WORKDIR" --arg configDir "$CLAUDE_CONFIG_DIR" \
    --arg authMethod "$method" --argjson login "$login" \
    --argjson apiKey "$(json_bool test -n "${ANTHROPIC_API_KEY:-}")" \
    --argjson authToken "$(json_bool test -n "${ANTHROPIC_AUTH_TOKEN:-}")" \
    --argjson oauthToken "$(json_bool test -n "${CLAUDE_CODE_OAUTH_TOKEN:-}")" \
    --argjson githubToken "$(json_bool test -n "${GH_TOKEN:-}${GITHUB_TOKEN:-}")" \
    --argjson runnerSecret "$(json_bool has_runner_secret)" \
    --argjson sudo "$(json_bool test -e /etc/sudoers.d/claude-sandbox)" \
    --argjson trustWorkspace "$(json_bool is_true "${CLAUDE_TRUST_WORKSPACE:-1}")" \
    --arg permissionMode "${CLAUDE_PERMISSION_MODE:-}" \
    --argjson rcEnabled "$(json_bool is_true "${CLAUDE_REMOTE_CONTROL:-1}")" \
    --arg rcBlockers "$rc_blockers" \
    --arg rcName "${CLAUDE_RC_NAME:-}" --arg rcSpawn "${CLAUDE_RC_SPAWN:-same-dir}" --arg rcCapacity "${CLAUDE_RC_CAPACITY:-}" \
    --arg gitName "$(git config --global user.name 2>/dev/null || true)" \
    --arg gitEmail "$(git config --global user.email 2>/dev/null || true)" \
    --argjson dockerEnabled "$(json_bool is_true "${CLAUDE_DOCKER:-0}")" --arg dockerVersion "$(docker_version)" \
    --argjson git "$git_json" --arg serverMode "$mode" \
    '{
      claudeCode: $claudeCode, user: $user, uid: $uid, gid: $gid, hostname: $hostname,
      workspace: $workspace, configDir: $configDir,
      authMethod: $authMethod,
      claudeaiLogin: ($login.authMethod == "claude.ai"),
      account: (if $login.authMethod == "claude.ai" then ($login | {email, orgName, subscriptionType}) else null end),
      apiKey: $apiKey, authToken: $authToken, oauthToken: $oauthToken, githubToken: $githubToken,
      runnerSecret: $runnerSecret, sudo: $sudo, trustWorkspace: $trustWorkspace,
      permissionMode: (if $permissionMode == "" then null else $permissionMode end),
      remoteControl: {
        enabled: $rcEnabled,
        blockers: ($rcBlockers | split("\n") | map(select(length > 0))),
        name: $rcName, spawn: $rcSpawn, capacity: $rcCapacity
      },
      gitIdentity: {name: $gitName, email: $gitEmail},
      git: $git,
      docker: {enabled: $dockerEnabled, version: (if $dockerVersion == "" then null else $dockerVersion end)},
      serverMode: $serverMode
    }'
}

mode_status() {
  local method blockers mode
  method="$(auth_method)"
  blockers="$(remote_control_blockers)"
  if has_runner_secret; then
    mode="runner"
  elif is_true "${CLAUDE_WEBUI:-1}"; then
    mode="webui"
  elif [[ -z $blockers ]]; then
    mode="remote-control"
  else
    mode="idle"
  fi
  if [[ ${1:-} == --json ]]; then
    status_json "$method" "$mode"
    return
  fi
  printf 'Claude Code     %s\n' "$("$REAL_CLAUDE" --version 2>/dev/null || echo unknown)"
  printf 'User            %s (uid %s, gid %s)\n' "$(id -un)" "$(id -u)" "$(id -g)"
  printf 'Workspace       %s\n' "$WORKDIR"
  printf 'Config dir      %s\n' "$CLAUDE_CONFIG_DIR"
  printf 'Auth method     %s\n' "$method"
  printf 'claude.ai login %s\n' "$(has_claudeai_login && echo yes || echo no)"
  printf 'Runner secret   %s\n' "$(has_runner_secret && echo set || echo 'not set')"
  printf 'GitHub token    %s\n' "$([[ -n ${GH_TOKEN:-}${GITHUB_TOKEN:-} ]] && echo set || echo 'not set')"
  if [[ -z $blockers ]]; then
    printf 'Remote Control  available\n'
  else
    printf 'Remote Control  unavailable\n'
    sed 's/^/                - /' <<<"$blockers"
  fi
  if is_true "${CLAUDE_WEBUI:-1}"; then
    printf 'Web UI          on, port %s (server mode)\n' "${CLAUDE_WEBUI_PORT:-8765}"
  else
    printf 'Web UI          off (CLAUDE_WEBUI)\n'
  fi
  local docker
  docker="$(docker_version)"
  if [[ -n $docker ]]; then
    printf 'Docker          %s\n' "$docker"
  elif is_true "${CLAUDE_DOCKER:-0}"; then
    printf 'Docker          not running (CLAUDE_DOCKER is set; see /var/log/dockerd.log)\n'
  else
    printf 'Docker          off (CLAUDE_DOCKER)\n'
  fi
  printf 'Server mode     %s\n' "$mode"
}

main() {
  load_secret_files
  if [[ $(id -u) == 0 ]]; then
    root_phase "$@"
  fi

  # Only the web UI needs its password; keep it out of every other environment.
  WEBUI_PASSWORD="${CLAUDE_WEBUI_PASSWORD:-}"
  unset CLAUDE_WEBUI_PASSWORD
  # As the sandbox user only: the settings file is writable by that user.
  claude_sandbox_load_settings

  local mode="${1:-${CLAUDE_MODE:-auto}}"
  if [[ $mode == -* ]]; then
    mode=interactive # `docker run -it <image> --model opus`
  else
    (($# == 0)) || shift
  fi

  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) export PATH="$HOME/.local/bin:$PATH" ;;
  esac

  # Read-only modes: no config seeding, git setup or clone.
  case "$mode" in
    help | --help | -h) usage; exit 0 ;;
    status) mode_status "$@"; exit 0 ;;
  esac

  mkdir -p "$CLAUDE_CONFIG_DIR" "$WORKDIR"
  chmod 700 "$CLAUDE_CONFIG_DIR" 2>/dev/null || true
  seed_config
  configure_git
  clone_repo

  if [[ $mode == auto ]]; then
    if has_runner_secret; then
      mode=runner
    elif [[ -t 0 && -t 1 ]]; then
      mode=interactive
    else
      mode=server
    fi
  fi

  case "$mode" in
    interactive) mode_interactive "$@" ;;
    server) mode_server "$@" ;;
    remote-control | rc) mode_remote_control "$@" ;;
    runner) mode_runner "$@" ;;
    login) mode_login "$@" ;;
    setup-token) run "$REAL_CLAUDE" setup-token "$@" ;;
    webui) mode_webui "$@" ;;
    prepare) exit 0 ;;
    shell) cd "$WORKDIR" && run bash "$@" ;;
    idle) mode_idle "" ;;
    version) run "$REAL_CLAUDE" --version ;;
    *) run "$mode" "$@" ;;
  esac
}

main "$@"
