# shellcheck shell=bash
# Settings saved from the web UI, in $CLAUDE_CONFIG_DIR/claude-sandbox/settings.json.
# Sourced by the entrypoint, `with-settings` (used by the claude wrapper) and
# interactive shells. A variable set in the container's own environment always
# wins over a saved value. Keep the list in sync with SETTINGS in webui/server.mjs.
#
# Never source this as root: the file it reads is writable by the sandbox user.
# It only ever exports the names below, and never evaluates what it reads.

CLAUDE_SANDBOX_SETTINGS_KEYS=(
  ANTHROPIC_API_KEY
  CLAUDE_CODE_OAUTH_TOKEN
  GH_TOKEN
  GIT_USER_NAME
  GIT_USER_EMAIL
  GIT_REPO_URL
  GIT_REPO_BRANCH
  CLAUDE_REMOTE_CONTROL
  CLAUDE_RC_NAME
  CLAUDE_RC_SPAWN
  CLAUDE_RC_CAPACITY
  CLAUDE_PERMISSION_MODE
)

claude_sandbox_settings_file() {
  printf '%s/claude-sandbox/settings.json\n' "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
}

# Exports every saved setting the environment doesn't already set, and lists the
# names it exported in CLAUDE_SANDBOX_SETTINGS_LOADED.
claude_sandbox_load_settings() {
  # shellcheck disable=SC2034  # read by the entrypoint
  CLAUDE_SANDBOX_SETTINGS_LOADED=()
  local file key value known k
  file="$(claude_sandbox_settings_file)"
  [[ -r $file ]] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  while IFS= read -r -d '' key && IFS= read -r -d '' value; do
    known=0
    for k in "${CLAUDE_SANDBOX_SETTINGS_KEYS[@]}"; do
      if [[ $k == "$key" ]]; then known=1 && break; fi
    done
    ((known)) || continue
    [[ -z ${!key:-} ]] || continue
    # gh prefers GH_TOKEN, so a saved one would override GITHUB_TOKEN from the environment.
    if [[ $key == GH_TOKEN && -n ${GITHUB_TOKEN:-} ]]; then continue; fi
    export "$key=$value"
    CLAUDE_SANDBOX_SETTINGS_LOADED+=("$key")
  done < <(jq -j 'to_entries[] | select((.value | type) == "string" and (.value | length) > 0 and (.value | test("\u0000") | not))
                  | "\(.key)\u0000\(.value)\u0000"' "$file" 2>/dev/null)
}
