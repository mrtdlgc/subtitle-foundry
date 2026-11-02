#!/bin/sh
set -eu
umask 077
# A bind mount can hide the image's directories. Create the login store as the
# application user, and fail clearly if the volume has incompatible ownership.
mkdir -p "${DATA_DIR:-/data}/data/private" "${CODEX_HOME:-/data/data/private/codex}"
chmod 700 "${DATA_DIR:-/data}/data/private" "${CODEX_HOME:-/data/data/private/codex}"
if [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then
  mkdir -p "$CLAUDE_CONFIG_DIR"
  chmod 700 "$CLAUDE_CONFIG_DIR"
fi
exec "$@"
