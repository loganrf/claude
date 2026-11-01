#!/usr/bin/env bash
# /usr/local/lib/claude-sandbox/with-settings: run a command with the settings
# saved from the web UI added to its environment (see settings.sh).
# shellcheck source=docker/settings.sh
. /usr/local/lib/claude-sandbox/settings.sh
if [[ $(id -u) != 0 ]]; then
  claude_sandbox_load_settings
fi
exec "$@"
