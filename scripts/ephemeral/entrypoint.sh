#!/bin/sh
set -eu
# Refuse Node preloads before invoking Node. Never print environment values.
if [ "${NODE_OPTIONS+x}" = x ] || [ "${NODE_EXTRA_CA_CERTS+x}" = x ]; then
  echo EPHEMERAL_EXTERNAL_RUNTIME_REFUSED >&2
  exit 78
fi
for variable in DATABASE_URL PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PGOPTIONS PGSSLMODE PGSERVICE PGSERVICEFILE PGPASSFILE PGSSLROOTCERT PGSSLCERT PGSSLKEY; do
  if printenv "$variable" >/dev/null 2>&1; then
    echo EPHEMERAL_EXTERNAL_DATABASE_REFUSED >&2
    exit 78
  fi
done
if [ -n "${PGDATA:-}" ]; then
  echo EPHEMERAL_EXTERNAL_DATABASE_REFUSED >&2
  exit 78
fi
exec env -i PATH=/usr/local/bin:/usr/lib/postgresql/17/bin:/usr/bin:/bin LANG=C.UTF-8 /usr/local/bin/node --experimental-strip-types /app/scripts/ephemeral/supervisor.mjs
