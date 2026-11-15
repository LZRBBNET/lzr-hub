#!/usr/bin/env bash
# Only the disposable public GitHub runner. Never invoke on a workstation/host.
set -euo pipefail
set +x
umask 077
readonly IMAGE='docker.io/library/postgres@sha256:99d1a998c76487d3abb48b141505bda5dcf8089c0c4cd7be40f75de314fa32f0'
readonly SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_OS:-} == Linux && ${RUNNER_ENVIRONMENT:-} == github-hosted ]] || { echo QA_RUNNER_REQUIRED; exit 78; }
[[ $EUID == 0 && ${GITHUB_RUN_ID:-} =~ ^[0-9]{1,20}$ && ${GITHUB_RUN_ATTEMPT:-} =~ ^[0-9]{1,4}$ ]] || { echo QA_ORCHESTRATOR_REQUIRED; exit 78; }
readonly SUFFIX="${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
readonly USER_NAME="lzrqa${GITHUB_RUN_ID:0:20}${GITHUB_RUN_ATTEMPT}"
readonly ROOT_STATE="/tmp/lzr-integrated-root-${SUFFIX}"
readonly USER_HOME="/tmp/lzr-integrated-user-${SUFFIX}"
readonly GATE="${USER_HOME}/gate"
readonly REPO="${USER_HOME}/repo"
readonly CONTAINER="lzr-integrated-pg-${SUFFIX}"
readonly NETWORK="lzr-integrated-net-${SUFFIX}"
readonly VOLUME="lzr-integrated-data-${SUFFIX}"
readonly NSS="${USER_HOME}/.local/share/pki/nssdb"
readonly NICK='lzr-integrated-leaf'
NODE="$(command -v node)"; readonly NODE
NODE_PATH="$(dirname "$NODE"):/usr/local/bin:/usr/bin:/bin"; readonly NODE_PATH

container_address() {
  local attachment actual_network address extra
  [[ $(docker inspect --format '{{len .NetworkSettings.Networks}}' "$CONTAINER") == 1 ]] || return 1
  attachment=$(docker inspect --format '{{range $name,$config := .NetworkSettings.Networks}}{{$name}} {{$config.IPAddress}}{{end}}' "$CONTAINER")
  read -r actual_network address extra <<< "$attachment"
  [[ $actual_network == "$NETWORK" && -z $extra ]] || return 1
  printf '%s' "$address"
}

as_test_user() {
  runuser -u "$USER_NAME" -- env -i PATH="$NODE_PATH" HOME="$USER_HOME" \
    USER="$USER_NAME" LOGNAME="$USER_NAME" XDG_CONFIG_HOME="$USER_HOME/.config" \
    XDG_DATA_HOME="$USER_HOME/.local/share" LANG=C.UTF-8 TZ=UTC \
    LZR_GATE_DIR="$GATE" "$@"
}

phase() {
  local name="$1" seconds="$2" rc=0 pid restarted=false
  (cd "$REPO" && timeout --signal=TERM --kill-after=10s "$seconds" \
    runuser -u "$USER_NAME" -- env -i PATH="$NODE_PATH" HOME="$USER_HOME" \
    USER="$USER_NAME" LOGNAME="$USER_NAME" XDG_CONFIG_HOME="$USER_HOME/.config" \
    XDG_DATA_HOME="$USER_HOME/.local/share" LANG=C.UTF-8 TZ=UTC LZR_GATE_DIR="$GATE" \
    "$NODE" --experimental-strip-types scripts/qa-integrated.mjs "$name") \
    >"$ROOT_STATE/${name}.stdout" 2>"$ROOT_STATE/${name}.stderr" &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if [[ $name == journey && $restarted == false && -f $GATE/restart-request && ! -L $GATE/restart-request ]]; then
      restarted=true
      if timeout 20s docker restart "$CONTAINER" >"$ROOT_STATE/restart.log" 2>&1; then
        current_ip=$(container_address)
        [[ $current_ip == "$bridge_ip" ]] || { echo QA_DB_RESTART_ENDPOINT_CHANGED; break; }
        for _ in {1..20}; do
          if docker exec "$CONTAINER" pg_isready -U lzr_synthetic_demo -d lzr_synthetic_demo >/dev/null 2>&1; then
            as_test_user touch "$GATE/restart-complete"
            break
          fi
          sleep 1
        done
      fi
    fi
    sleep 1
  done
  wait "$pid" || rc=$?
  # Copy only known diagnostic keys, never arbitrary stdout/stderr.
  python3 - "$ROOT_STATE/${name}.stdout" "$ROOT_STATE/${name}.stderr" <<'PYOUT'
import json,re,sys
keys={'check','result','phase','stage','error','accepted','endpointHits','width','context','owner','delivery','line','actual','expected'}
for path in sys.argv[1:]:
 for line in open(path):
  try: obj=json.loads(line)
  except (ValueError,TypeError): continue
  if not isinstance(obj,dict): continue
  safe={}
  for key,value in obj.items():
   if key not in keys: continue
   if isinstance(value,(bool,int)) or (isinstance(value,str) and re.fullmatch(r'[A-Za-z0-9_-]{1,100}',value)): safe[key]=value
  if safe: print(json.dumps(safe))
PYOUT
  # Never surface tool errors, request bodies, credentials or raw application logs.
  printf '{"phase":"%s","exitCode":%s}\n' "$name" "$rc"
  return "$rc"
}

cleanup() {
  local failed=0 actual='' uid=''
  trap - EXIT INT TERM
  if [[ -d $ROOT_STATE && $(stat -c %u "$ROOT_STATE") == 0 ]]; then
    if id "$USER_NAME" >/dev/null 2>&1; then
      if [[ -f $REPO/scripts/qa-integrated.mjs && -f $GATE/cert.pem && -f $NSS/cert9.db ]]; then phase cleanup 20 || failed=1; fi
      if [[ -f $NSS/cert9.db ]]; then
        # Verify exact fingerprint before deleting this one entry. No broad deletion.
        if as_test_user certutil -L -d "sql:$NSS" -n "$NICK" -a >"$ROOT_STATE/leaf-after.pem" 2>/dev/null; then
          actual=$(openssl x509 -in "$ROOT_STATE/leaf-after.pem" -noout -fingerprint -sha256 2>/dev/null) || failed=1
          if [[ -f $ROOT_STATE/fingerprint && $actual == "$(cat "$ROOT_STATE/fingerprint")" ]]; then
            as_test_user certutil -D -d "sql:$NSS" -n "$NICK" >/dev/null 2>&1 || failed=1
          else failed=1; fi
        fi
        if as_test_user certutil -L -d "sql:$NSS" -n "$NICK" >/dev/null 2>&1; then failed=1; fi
      fi
      uid=$(id -u "$USER_NAME")
      [[ $uid -gt 999 ]] || return 1
      pkill -TERM -u "$uid" 2>/dev/null || true
      sleep 1
      pkill -KILL -u "$uid" 2>/dev/null || true
      sleep 1
      if ps -eo uid=,stat= | awk -v uid="$uid" '$1==uid && $2 !~ /^Z/ {found=1} END{exit !found}'; then failed=1; fi
      # PID records in Z state may await init reaping; distinguish from active work.
      local zombies
      zombies=$(ps -eo uid=,stat= | awk -v uid="$uid" '$1==uid && $2 ~ /^Z/ {n++} END{print n+0}')
      printf '{"cleanup":"user-processes","zombieRecords":%s}\n' "$zombies"
    fi
    if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
      docker rm -f -v "$CONTAINER" >/dev/null 2>&1 || failed=1
    fi
    if docker volume inspect "$VOLUME" >/dev/null 2>&1; then
      docker volume rm "$VOLUME" >/dev/null 2>&1 || failed=1
    fi
    if docker network inspect "$NETWORK" >/dev/null 2>&1; then
      docker network rm "$NETWORK" >/dev/null 2>&1 || failed=1
    fi
    docker container inspect "$CONTAINER" >/dev/null 2>&1 && failed=1
    docker network inspect "$NETWORK" >/dev/null 2>&1 && failed=1
    docker volume inspect "$VOLUME" >/dev/null 2>&1 && failed=1
    if id "$USER_NAME" >/dev/null 2>&1; then userdel "$USER_NAME" >/dev/null 2>&1 || failed=1; fi
    id "$USER_NAME" >/dev/null 2>&1 && failed=1
    if [[ -f $ROOT_STATE/user-created ]] && getent group "$USER_NAME" >/dev/null 2>&1; then groupdel "$USER_NAME" >/dev/null 2>&1 || failed=1; fi
    if [[ -f $ROOT_STATE/user-created ]] && getent group "$USER_NAME" >/dev/null 2>&1; then failed=1; fi
    # Remove the private home only after no live user process remains. Keep the
    # root-owned retry marker on ANY failure: the always() step must retry actual
    # remaining resources rather than silently declare an absent marker success.
    if [[ -z $uid ]] || ! ps -eo uid=,stat= | awk -v uid="$uid" '$1==uid && $2 !~ /^Z/ {found=1} END{exit !found}'; then
      rm -rf -- "$USER_HOME" || failed=1
    else failed=1; fi
    [[ ! -e $USER_HOME ]] || failed=1
    if [[ $failed == 0 ]]; then
      rm -rf -- "$ROOT_STATE" || failed=1
      [[ ! -e $ROOT_STATE ]] || failed=1
    fi
  fi
  printf '{"cleanup":"isolated-gate","passed":%s}\n' "$([[ $failed == 0 ]] && echo true || echo false)"
  return "$failed"
}

if [[ ${1:-} == cleanup ]]; then cleanup; exit; fi
[[ ${1:-} == run ]] || { echo 'usage: qa-integrated-runner.sh run|cleanup'; exit 64; }
[[ ! -e $ROOT_STATE && ! -e $USER_HOME ]] || { echo QA_STALE_RESOURCES; exit 78; }
! id "$USER_NAME" >/dev/null 2>&1 || { echo QA_USER_ALREADY_EXISTS; exit 78; }
! getent group "$USER_NAME" >/dev/null 2>&1 || { echo QA_GROUP_ALREADY_EXISTS; exit 78; }
! docker container inspect "$CONTAINER" >/dev/null 2>&1 || { echo QA_CONTAINER_ALREADY_EXISTS; exit 78; }
! docker network inspect "$NETWORK" >/dev/null 2>&1 || { echo QA_NETWORK_ALREADY_EXISTS; exit 78; }
! docker volume inspect "$VOLUME" >/dev/null 2>&1 || { echo QA_VOLUME_ALREADY_EXISTS; exit 78; }
[[ -x /usr/bin/google-chrome && -x /usr/bin/chromedriver ]] || { echo QA_BROWSER_MISSING; exit 78; }
command -v certutil >/dev/null || { echo QA_OFFICIAL_NSS_TOOL_MISSING; exit 78; }
[[ -d $SOURCE/node_modules && -f $SOURCE/work/synthetic-web/dist/synthetic-web.json ]] || { echo QA_BUILD_MISSING; exit 78; }
mkdir -m 700 "$ROOT_STATE"
trap 'rc=$?; cleanup || rc=1; exit "$rc"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
useradd --user-group --no-create-home --home-dir "$USER_HOME" --shell /usr/sbin/nologin "$USER_NAME" >/dev/null 2>&1
touch "$ROOT_STATE/user-created"
install -d -m 700 -o "$USER_NAME" -g "$USER_NAME" "$USER_HOME" "$GATE" "$REPO"
[[ $(id -Gn "$USER_NAME") == "$USER_NAME" ]] || { echo QA_USER_GROUPS_INVALID; exit 78; }
# Exclude host identity and all configuration; include only source and built dependencies.
# Preserve artifact, but replace its node_modules symlink after copying.
(cd "$SOURCE" && tar --exclude='.git' --exclude='.env*' --exclude='*.log' --exclude='./.codex' \
  --exclude='./.agents' --exclude='./.aws' --exclude='./.wrangler' \
  --exclude='./node_modules/.cache' --exclude='./work/synthetic-web/node_modules' -cf - .) \
  | (cd "$REPO" && tar -xf -)
ln -s "$REPO/node_modules" "$REPO/work/synthetic-web/node_modules"
chown -R "$USER_NAME:$USER_NAME" "$USER_HOME"
[[ ! -e $USER_HOME/.pki && ! -e $NSS ]] || { echo QA_NSS_NOT_EMPTY; exit 78; }
# Pull trusted pinned image BEFORE certificate clock starts, but create no DB yet.
docker pull "$IMAGE" >"$ROOT_STATE/pull.log" 2>&1
as_test_user python3 "$REPO/scripts/qa-integrated-cert.py" "$GATE" >"$ROOT_STATE/cert.log" 2>&1
openssl x509 -in "$GATE/cert.pem" -noout -fingerprint -sha256 >"$ROOT_STATE/fingerprint"
phase preflight 90
# TLS preflight has now passed. No database exists before this line.
python3 - "$ROOT_STATE/pg.env" <<'PY'
import os,secrets,sys
fd=os.open(sys.argv[1],os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'w') as f:
 f.write('POSTGRES_USER=lzr_synthetic_demo\nPOSTGRES_DB=lzr_synthetic_demo\nPOSTGRES_PASSWORD='+secrets.token_hex(32)+'\n')
PY
docker network create --internal "$NETWORK" >/dev/null
docker volume create "$VOLUME" >/dev/null
docker run -d --name "$CONTAINER" --network "$NETWORK" --read-only \
  --security-opt no-new-privileges:true --log-driver=none --memory=512m --cpus=1 --pids-limit=128 \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --tmpfs /var/run/postgresql:rw,noexec,nosuid,size=16m \
  --mount "type=volume,source=$VOLUME,target=/var/lib/postgresql/data" \
  --env-file "$ROOT_STATE/pg.env" "$IMAGE" \
  -c log_statement=none -c log_min_messages=fatal -c log_min_error_statement=panic >/dev/null
# Docker internal-only networks deliberately have no default gateway, so
# --publish is ignored. Retain no-egress isolation and relay host loopback to
# this container's verified single private bridge endpoint instead.
[[ $(docker network inspect --format '{{.Internal}}' "$NETWORK") == true ]] || { echo QA_DB_NETWORK_INVALID; exit 78; }
[[ $(docker inspect --format '{{len .NetworkSettings.Networks}}' "$CONTAINER") == 1 ]] || { echo QA_DB_NETWORK_INVALID; exit 78; }
bridge_ip=$(container_address)
python3 - "$bridge_ip" <<'PYIP'
import ipaddress,sys
address=ipaddress.ip_address(sys.argv[1])
assert address.version==4 and any(address in ipaddress.ip_network(n) for n in ['10.0.0.0/8','172.16.0.0/12','192.168.0.0/16'])
PYIP
as_test_user python3 "$REPO/scripts/qa-integrated-relay.py" "$bridge_ip" "$GATE/relay-port" \
  >"$ROOT_STATE/relay.stdout" 2>"$ROOT_STATE/relay.stderr" &
relay_pid=$!
port=''
for _ in {1..50}; do
  kill -0 "$relay_pid" 2>/dev/null || { echo QA_DB_RELAY_FAILED; exit 1; }
  if [[ -f $GATE/relay-port && ! -L $GATE/relay-port ]]; then port=$(cat "$GATE/relay-port"); break; fi
  sleep 0.1
done
[[ $port =~ ^[0-9]+$ && $port -gt 1023 && $port -lt 65536 ]] || { echo QA_DB_BIND_INVALID; exit 78; }
python3 - "$ROOT_STATE/pg.env" "$GATE/state.json" "$port" <<'PY'
import json,os,sys
settings=dict(line.strip().split('=',1) for line in open(sys.argv[1]))
fd=os.open(sys.argv[2],os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'w') as f:
 json.dump({'host':'127.0.0.1','port':int(sys.argv[3]),'user':settings['POSTGRES_USER'],
            'password':settings['POSTGRES_PASSWORD'],'database':settings['POSTGRES_DB']},f)
PY
chown "$USER_NAME:$USER_NAME" "$GATE/state.json"
ready=false
for _ in {1..30}; do
  if docker exec "$CONTAINER" pg_isready -U lzr_synthetic_demo -d lzr_synthetic_demo >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
[[ $ready == true ]] || { echo QA_DB_NOT_READY; exit 1; }
phase journey 210
# Expiration is checked in a fresh browser only AFTER the complete journey.
phase expiry 500
