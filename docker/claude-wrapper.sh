#!/bin/sh
# /usr/local/bin/claude: always run Claude Code as the unprivileged sandbox user,
# with the settings saved from the web UI.
# `docker exec <container> claude` runs as root by default; this drops to `claude`.
real=/usr/local/lib/claude-code/claude
with_settings=/usr/local/lib/claude-sandbox/with-settings

if [ "$(id -u)" -eq 0 ] && [ -z "${CLAUDE_SANDBOX_ALLOW_ROOT:-}" ]; then
  if command -v gosu >/dev/null 2>&1; then
    exec gosu claude env PATH="/home/claude/.local/bin:$PATH" "$with_settings" "$real" "$@"
  fi
  exec setpriv --reuid=claude --regid=claude --init-groups \
    env HOME=/home/claude USER=claude LOGNAME=claude PATH="/home/claude/.local/bin:$PATH" "$with_settings" "$real" "$@"
fi

case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) PATH="$HOME/.local/bin:$PATH" && export PATH ;;
esac
if [ "$(id -u)" -ne 0 ]; then
  exec "$with_settings" "$real" "$@"
fi
exec "$real" "$@"
