#!/bin/sh
# /usr/local/bin/claude: always run Claude Code as the unprivileged sandbox user.
# `docker exec <container> claude` runs as root by default; this drops to `claude`.
real=/usr/local/lib/claude-code/claude

if [ "$(id -u)" -eq 0 ] && [ -z "${CLAUDE_SANDBOX_ALLOW_ROOT:-}" ]; then
  if command -v gosu >/dev/null 2>&1; then
    exec gosu claude env PATH="/home/claude/.local/bin:$PATH" "$real" "$@"
  fi
  exec setpriv --reuid=claude --regid=claude --init-groups \
    env HOME=/home/claude USER=claude LOGNAME=claude PATH="/home/claude/.local/bin:$PATH" "$real" "$@"
fi

case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) PATH="$HOME/.local/bin:$PATH" && export PATH ;;
esac
exec "$real" "$@"
