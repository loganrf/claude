# shellcheck shell=sh
# /etc/chromium.d/claude-sandbox, sourced by /usr/bin/chromium on every start.
# Chromium's own sandbox needs user namespaces that an unprivileged container
# doesn't get, so turn it off: the container is the sandbox. (Debian's
# /etc/chromium.d/dev-shm already copes with Docker's small /dev/shm.)
export CHROMIUM_FLAGS="$CHROMIUM_FLAGS --no-sandbox"
