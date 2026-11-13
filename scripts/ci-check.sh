#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Do not inherit application credentials, URLs, NODE_OPTIONS or npm config.
# Only installation needs the Cloud's existing standard network proxy settings.
phase="${1:-}"
if [[ "${2:-}" != '--clean' ]]; then
  clean_env=("PATH=${PATH}" CI=true TZ=UTC NEXT_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1)
  if [[ "${phase}" == install ]]; then
    clean_env+=("HTTPS_PROXY=${HTTPS_PROXY:-}" "HTTP_PROXY=${HTTP_PROXY:-}" "NO_PROXY=${NO_PROXY:-}")
  fi
  exec env -i "${clean_env[@]}" bash "$0" "${phase}" --clean
fi

# Vite can load dotenv independently of process.env; refuse local configuration.
if find -L . -maxdepth 1 -name '.env*' -type f ! -name '*.example' ! -name '*.sample' -print -quit | read -r _; then
  echo 'CI refuses local dotenv files; use a clean checkout.' >&2
  exit 78
fi

case "${phase}" in
  install)
    # Existing lockfile only. Optional native packages supply build binaries.
    export npm_config_ignore_scripts=true
    export NODE_USE_SYSTEM_CA=1
    npm run install:ci
    ;;
  types) npm run typecheck ;;
  lint) npm run lint ;;
  tests)
    npm run build
    timeout --signal=TERM --kill-after=10s 3m node \
      --import ./scripts/ci-test-transport.mjs --experimental-strip-types \
      --test tests/*.test.mjs
    ;;
  synthetic)
    # Same fictitious settings as the repository's artifact tests. No DB URL.
    export NODE_ENV=production FEATURE_AUTH=true FEATURE_IXC_FULL_BASE=false
    export FEATURE_SYNTHETIC_INVOICES=true DEMO_DATASET=isolated-invoices-v1
    export SYNTHETIC_WEB_DEMO=true SYNTHETIC_DATABASE_CONFIRMATION=isolated-synthetic-postgres-v1
    export SYNTHETIC_DEMO_ORIGIN=https://demo.example.invalid
    export FEATURE_N8N_CHANNEL=false FEATURE_N8N_AUTOREPLY=false FEATURE_ATTENDANT_REPLY=false
    export FEATURE_LLM_INTENT=false FEATURE_COPILOT_LLM=false FEATURE_TELEGRAM_ALERTS=false
    bash scripts/sites-env.sh -- bash scripts/staging-env.sh \
      timeout --signal=TERM --kill-after=10s 3m node --experimental-strip-types scripts/synthetic-web.mjs build
    # These files are intentionally outside the aggregate *.test.mjs glob.
    timeout --signal=TERM --kill-after=10s 90s node \
      --import ./scripts/ci-test-transport.mjs --experimental-strip-types --test \
      tests/synthetic-web-artifact-check.mjs tests/browser-first-access-artifact.mjs \
      tests/synthetic-web-process.mjs tests/synthetic-operational-artifact.mjs
    ;;
  *) echo 'usage: bash scripts/ci-check.sh {install|types|lint|tests|synthetic}' >&2; exit 64 ;;
esac
