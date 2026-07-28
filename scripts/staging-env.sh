#!/usr/bin/env bash
set -euo pipefail

export LZR_ENV=staging
export NEXT_PUBLIC_LZR_ENV=staging
export LZR_RUNTIME_MODE=mock
export IXC_MODE=disabled
export IXC_TRANSPORT=disabled
export IXC_WRITE_ENABLED=false
export FEATURE_IXC_WRITE=false
export PILOT_MODE=disabled
export FEATURE_LANGFUSE=false
export FEATURE_CHATWOOT=false
export FEATURE_EVOLUTION=false
export FEATURE_META_WHATSAPP=false
export FEATURE_QUEUES=false
export FEATURE_PGVECTOR=false
export FEATURE_AGENT_HOMOLOGATION_PROFILES=false

exec "$@"
