#!/usr/bin/env bash
# Smoke-test a built image without any real credentials.
#
#   tests/smoke.sh IMAGE [EXPECTED_CLAUDE_CODE_VERSION]
# shellcheck disable=SC2016  # the single-quoted snippets run inside the container
set -Eeuo pipefail

image="${1:?usage: tests/smoke.sh IMAGE [EXPECTED_CLAUDE_CODE_VERSION]}"
expected_version="${2:-}"
fake_key="sk-ant-api03-smoketest-0123456789abcdefghij"
failures=0
cleanup=()
remove_containers() {
  local c
  for c in "${cleanup[@]}"; do docker rm -f "$c" >/dev/null 2>&1 || true; done
}
trap remove_containers EXIT

pass() { printf 'ok   %s\n' "$1"; }
fail() {
  printf 'FAIL %s\n' "$1"
  [[ -z ${2:-} ]] || printf '%s\n' "$2" | sed 's/^/       /'
  failures=$((failures + 1))
}
dr() { docker run --rm "$@"; }

# expect NAME PATTERN CMD... : CMD succeeds and its output matches PATTERN (ERE)
expect() {
  local name="$1" pattern="$2" out
  shift 2
  if out="$("$@" 2>&1)" && grep -Eq -- "$pattern" <<<"$out"; then pass "$name"; else fail "$name" "$out"; fi
}
# expect_fail NAME PATTERN CMD... : CMD fails and its output matches PATTERN
expect_fail() {
  local name="$1" pattern="$2" out
  shift 2
  if ! out="$("$@" 2>&1)" && grep -Eq -- "$pattern" <<<"$out"; then pass "$name"; else fail "$name" "$out"; fi
}

dry=(-e CLAUDE_SANDBOX_DRY_RUN=1)

# --- contents ---------------------------------------------------------------
expect "claude runs" "^${expected_version//./\\.}.*\(Claude Code\)" dr "$image" version
expect "developer tools on PATH" "^all present$" dr "$image" bash -c '
  for b in claude git git-lfs gh node npm npx python3 pip3 pipx rg fd jq tmux curl ssh make gcc tini gosu \
    shellcheck chromium docker dockerd; do
    command -v "$b" >/dev/null || { echo "missing: $b"; exit 1; }
  done
  echo "all present"'
expect "runs as unprivileged claude user" "^claude 1000$" dr "$image" bash -c 'echo "$(id -un) $(id -u)"'
expect "no sudo by default" "^no sudo$" dr "$image" bash -c 'sudo -n true 2>/dev/null && echo "has sudo" || echo "no sudo"'
expect "CLAUDE_SUDO=1 grants sudo" "^root$" dr -e CLAUDE_SUDO=1 "$image" sudo -n id -un
expect "auto-update disabled" "^1$" dr "$image" bash -c 'echo "$DISABLE_AUTOUPDATER"'
expect "shellcheck works" "^ok$" dr "$image" bash -c 'printf "#!/bin/sh\necho \"\$1\"\n" > /tmp/s.sh && shellcheck /tmp/s.sh && echo ok'
expect "headless Chromium renders a page" "chromium-ok" dr "$image" chromium --headless --disable-gpu --dump-dom 'data:text/html,<p>chromium-ok</p>'

# --- credentials and config seeding -----------------------------------------
expect "status without credentials" "Auth method +none" dr "$image" status
expect "API key is picked up" "Auth method +api_key" dr -e "ANTHROPIC_API_KEY=$fake_key" "$image" status
expect "API key approved, workspace trusted, onboarding skipped" '^true true true$' \
  dr -e "ANTHROPIC_API_KEY=$fake_key" "$image" bash -c \
  'jq -r "[.hasCompletedOnboarding, (.customApiKeyResponses.approved | index(\"0123456789abcdefghij\") != null), .projects[\"/workspace\"].hasTrustDialogAccepted] | map(tostring) | join(\" \")" "$CLAUDE_CONFIG_DIR/.claude.json"'
expect "OAuth token is picked up" "Auth method +oauth_token" dr -e CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-smoketest "$image" status

secret_dir="$(mktemp -d)"
printf 'ghp_smoketest\n' >"$secret_dir/gh"
chmod 644 "$secret_dir/gh"
expect "*_FILE secrets are read" "^ghp_smoketest$" dr -v "$secret_dir/gh:/run/secrets/gh:ro" -e GH_TOKEN_FILE=/run/secrets/gh "$image" bash -c 'echo "$GH_TOKEN"'
expect "GH_TOKEN wires git to gh" "gh auth git-credential" dr -e GH_TOKEN=ghp_smoketest "$image" git config --global --get-all credential.https://github.com.helper
expect "git identity from env" "^Ada <ada@example.com>$" dr -e GIT_USER_NAME=Ada -e GIT_USER_EMAIL=ada@example.com "$image" bash -c 'echo "$(git config user.name) <$(git config user.email)>"'
repo="$(mktemp -d)"
git -C "$repo" init -q -b trunk
git -C "$repo" -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m init
chmod -R a+rX "$repo"
expect "GIT_REPO_URL is cloned into an empty workspace" "^trunk$" \
  dr -v "$repo:/src:ro" -e GIT_REPO_URL=/src "$image" git -C /workspace branch --show-current
expect_fail "X and X_FILE together are rejected" "not both" dr -v "$secret_dir/gh:/run/secrets/gh:ro" -e GH_TOKEN_FILE=/run/secrets/gh -e GH_TOKEN=x "$image" status
expect "status --json" '"serverMode": "webui"' dr "$image" status --json
save_settings='mkdir -p "$CLAUDE_CONFIG_DIR/claude-sandbox" &&
  printf "{\"GIT_USER_NAME\":\"Saved\",\"GH_TOKEN\":\"ghp_saved\",\"HOME\":\"/tmp\"}" > "$CLAUDE_CONFIG_DIR/claude-sandbox/settings.json"'
expect "saved settings are loaded, unknown names ignored" "^Saved ghp_saved /home/claude$" dr "$image" bash -c \
  "$save_settings"' && /usr/local/lib/claude-sandbox/with-settings sh -c "echo \$GIT_USER_NAME \$GH_TOKEN \$HOME"'
expect "the environment wins over saved settings" "^Env ghp_saved$" dr -e GIT_USER_NAME=Env "$image" bash -c \
  "$save_settings"' && /usr/local/lib/claude-sandbox/with-settings sh -c "echo \$GIT_USER_NAME \$GH_TOKEN"'

# --- users and volumes ------------------------------------------------------
expect "HOST_UID/HOST_GID remap, workspace writable" "^4321:4321 ok$" dr -e HOST_UID=4321 -e HOST_GID=4321 "$image" bash -c 'touch /workspace/f && echo "$(id -u):$(id -g) ok"'
ws="$(mktemp -d)"
ws_owner="$(id -u)"
if ((ws_owner == 0)); then # root-owned mounts are left alone, so fake a host user
  ws_owner=2468
  chown "$ws_owner:$ws_owner" "$ws"
fi
expect "bind-mounted workspace owner is adopted" "^${ws_owner}$" dr -v "$ws:/workspace" "$image" bash -c 'touch /workspace/f && stat -c %u /workspace/f'

# --- mode selection (dry run) -----------------------------------------------
expect "server starts the web UI" "would run .*node /usr/local/lib/claude-sandbox/webui/server.mjs" dr "${dry[@]}" "$image" server
expect "CLAUDE_WEBUI=0 server with no login idles" "would run .*sleep infinity" dr "${dry[@]}" -e CLAUDE_WEBUI=0 "$image" server
expect "CLAUDE_WEBUI=0 server with API key idles and says why" "ANTHROPIC_API_KEY is set" dr "${dry[@]}" -e CLAUDE_WEBUI=0 -e "ANTHROPIC_API_KEY=$fake_key" "$image" server
expect "environment secret selects the runner" "self-hosted-runner --environment-secret-file .* --base-dir /workspace --capacity 1" \
  dr "${dry[@]}" -e SELF_HOSTED_RUNNER_ENVIRONMENT_SECRET=smoketest "$image"
expect "runner drops personal credentials" "not passing ANTHROPIC_API_KEY" \
  dr "${dry[@]}" -e SELF_HOSTED_RUNNER_ENVIRONMENT_SECRET=smoketest -e "ANTHROPIC_API_KEY=$fake_key" "$image" runner
expect_fail "remote-control without login explains itself" "no claude.ai login" dr "${dry[@]}" "$image" remote-control
expect "flags go to interactive Claude Code" "claude --permission-mode plan --model opus" \
  dr "${dry[@]}" -e CLAUDE_PERMISSION_MODE=plan "$image" --model opus
expect "other commands pass through" "would run .*: echo hi" dr "${dry[@]}" "$image" echo hi

# --- running container ------------------------------------------------------
name="claude-sandbox-smoke-$$"
cleanup+=("$name")
docker run -d --name "$name" "$image" server >/dev/null
webui() { docker exec "$1" curl -sS -b /tmp/cookies -c /tmp/cookies -H 'Content-Type: application/json' "${@:3}" "http://127.0.0.1:8765$2"; }
wait_for_webui() {
  for _ in $(seq 1 30); do
    docker exec "$1" curl -fsS http://127.0.0.1:8765/healthz >/dev/null 2>&1 && return 0
    sleep 0.5
  done
}
wait_for_webui "$name"
expect "server container stays up" "^running$" docker inspect -f '{{.State.Status}}' "$name"
expect "docker exec claude drops to the claude user" "^claude$" docker exec "$name" sh -c \
  'sed "s#^real=.*#real=/usr/bin/whoami#" /usr/local/bin/claude > /tmp/w && sh /tmp/w'
expect "docker exec claude works" "Claude Code" docker exec "$name" claude --version

# --- web UI -------------------------------------------------------------------
expect "web UI answers" "^ok$" docker exec "$name" curl -fsS http://127.0.0.1:8765/healthz
expect "web UI asks for a password first" '"setupRequired":true' webui "$name" /api/session
expect "web UI needs a session" "^401$" webui "$name" /api/status -o /dev/null -w '%{http_code}'
expect "web UI refuses a wrong setup code" "setup code is not right" webui "$name" /api/setup \
  -d '{"setupCode":"AAAA-BBBB-CCCC","password":"smoke test password"}'
setup_code="$(docker logs "$name" 2>&1 | sed -n 's/.*setup code: //p' | tail -n1)"
expect "web UI refuses a short password" "at least 12" webui "$name" /api/setup -d "{\"setupCode\":\"$setup_code\",\"password\":\"short\"}"
expect "setup code creates the password" '"ok":true' webui "$name" /api/setup \
  -d "{\"setupCode\":\"$setup_code\",\"password\":\"smoke test password\"}"
expect "web UI refuses cross-origin writes" "Cross-origin" webui "$name" /api/settings -H 'Origin: http://evil.example' -d '{}'
expect "web UI status explains Remote Control" '"state":"blocked".*no claude.ai login' webui "$name" /api/status
expect "web UI saves settings" '"changed":\["GIT_USER_NAME"\]' webui "$name" /api/settings -d '{"values":{"GIT_USER_NAME":"Ada"}}'
expect "saved settings reach docker exec" "^Ada$" docker exec -u claude "$name" /usr/local/lib/claude-sandbox/with-settings printenv GIT_USER_NAME
expect "saved git identity is applied" "^Ada$" bash -c "sleep 2; docker exec -u claude $name git config --global user.name"
expect "web UI rejects bad settings" "is not an email address" webui "$name" /api/settings -d '{"values":{"GIT_USER_EMAIL":"nope"}}'

name_pw="claude-sandbox-smoke-pw-$$"
cleanup+=("$name_pw")
docker run -d --name "$name_pw" -e CLAUDE_WEBUI_PASSWORD="from the environment" "$image" server >/dev/null
wait_for_webui "$name_pw"
expect "CLAUDE_WEBUI_PASSWORD skips setup" '"setupRequired":false,"passwordSource":"environment"' webui "$name_pw" /api/session
expect "CLAUDE_WEBUI_PASSWORD signs in" '"ok":true' webui "$name_pw" /api/login -d '{"password":"from the environment"}'
expect "wrong web UI password is refused" "Wrong password" webui "$name_pw" /api/login -d '{"password":"something else entirely"}'
docker rm -f "$name_pw" >/dev/null

# --- Docker inside the sandbox ------------------------------------------------
expect "CLAUDE_DOCKER without privileged warns and carries on" "needs a privileged container" dr -e CLAUDE_DOCKER=1 "$image" true
name_dind="claude-sandbox-smoke-dind-$$"
cleanup+=("$name_dind")
docker run -d --name "$name_dind" --privileged -e CLAUDE_DOCKER=1 -v "$name_dind:/var/lib/docker" "$image" idle >/dev/null
for _ in $(seq 1 60); do
  docker exec -u claude "$name_dind" docker info >/dev/null 2>&1 && break
  sleep 1
done
expect "CLAUDE_DOCKER runs Docker for the claude user" "^[0-9]+\." docker exec -u claude "$name_dind" docker info --format '{{.ServerVersion}}'
expect "the claude user can build images" "^sha256:" docker exec -u claude "$name_dind" sh -c \
  'printf "FROM scratch\nLABEL smoke=1\n" | docker build -q -t smoke -'
expect "status shows Docker" "^Docker +[0-9]+\." docker exec -u claude "$name_dind" claude-sandbox status
docker rm -f "$name_dind" >/dev/null
docker volume rm "$name_dind" >/dev/null
start=$(date +%s)
docker stop -t 20 "$name" >/dev/null
elapsed=$(($(date +%s) - start))
if ((elapsed < 10)); then pass "stops promptly on SIGTERM (${elapsed}s)"; else fail "stops promptly on SIGTERM" "took ${elapsed}s"; fi

echo
if ((failures)); then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all checks passed"
