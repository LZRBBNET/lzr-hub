#!/bin/sh
set -eu
# Preload flags must be rejected before Node starts. No dotenv or secrets are loaded here.
if [ "${NODE_OPTIONS+x}" = x ] || [ "${NODE_EXTRA_CA_CERTS+x}" = x ]; then
 echo MEMORY_DEMO_REFUSED >&2
 exit 78
fi
node_bin=$(command -v node)
case "$node_bin" in /*) ;; *) echo MEMORY_DEMO_REFUSED >&2; exit 78 ;; esac
exec "$node_bin" --experimental-strip-types scripts/memory-demo.mjs "$@"
