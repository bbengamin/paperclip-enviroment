#!/usr/bin/env bash
set -euo pipefail

REAL_DOCKER="${PAPERCLIP_REAL_DOCKER:-/usr/local/bin/docker-real}"

if [[ "${PAPERCLIP_CLOUDFLARE_DOCKER_HOST_NETWORK:-1}" == "0" ]]; then
  exec "$REAL_DOCKER" "$@"
fi

has_network_flag() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      --network|--network=*|--net|--net=*) return 0 ;;
    esac
  done
  return 1
}

run_with_host_network() {
  local subcommand="$1"
  shift
  if has_network_flag "$@"; then
    exec "$REAL_DOCKER" "$subcommand" "$@"
  fi
  exec "$REAL_DOCKER" "$subcommand" --network=host "$@"
}

compose_needs_host_network() {
  case "$1" in
    build|create|run|start|up) return 0 ;;
    *) return 1 ;;
  esac
}

write_host_network_compose_file() {
  local output_file="$1"
  shift
  "$REAL_DOCKER" compose "$@" config --format json | node -e '
const fs = require("fs");
const input = fs.readFileSync(0, "utf8");
const config = JSON.parse(input);
for (const service of Object.values(config.services || {})) {
  service.network_mode = "host";
  delete service.networks;
  delete service.ports;
  delete service.expose;
  if (service.build && typeof service.build === "object") {
    service.build.network = "host";
  }
}
delete config.networks;
process.stdout.write(JSON.stringify(config, null, 2));
' > "$output_file"
}

run_compose_with_host_network() {
  shift

  local -a config_args=()
  local -a runtime_args=()
  local -a command_args=()
  local subcommand=""

  while (($# > 0)); do
    case "$1" in
      -f|--file)
        config_args+=("$1" "$2")
        shift 2
        ;;
      --file=*)
        config_args+=("$1")
        shift
        ;;
      --env-file|--profile|--project-directory|--ansi|--progress|--parallel)
        config_args+=("$1" "$2")
        runtime_args+=("$1" "$2")
        shift 2
        ;;
      --env-file=*|--profile=*|--project-directory=*|--ansi=*|--progress=*|--parallel=*)
        config_args+=("$1")
        runtime_args+=("$1")
        shift
        ;;
      -p|--project-name)
        config_args+=("$1" "$2")
        runtime_args+=("$1" "$2")
        shift 2
        ;;
      --project-name=*)
        config_args+=("$1")
        runtime_args+=("$1")
        shift
        ;;
      --*)
        config_args+=("$1")
        runtime_args+=("$1")
        shift
        ;;
      -*)
        config_args+=("$1")
        runtime_args+=("$1")
        shift
        ;;
      *)
        subcommand="$1"
        shift
        command_args=("$@")
        break
        ;;
    esac
  done

  if [[ -z "$subcommand" ]] || ! compose_needs_host_network "$subcommand"; then
    exec "$REAL_DOCKER" compose "${config_args[@]}" "$subcommand" "${command_args[@]}"
  fi

  local rewritten_file
  rewritten_file="$(mktemp "${TMPDIR:-/tmp}/paperclip-compose-host-network.XXXXXX")"
  write_host_network_compose_file "$rewritten_file" "${config_args[@]}"
  exec "$REAL_DOCKER" compose "${runtime_args[@]}" -f "$rewritten_file" "$subcommand" "${command_args[@]}"
}

case "${1:-}" in
  build)
    shift
    run_with_host_network build "$@"
    ;;
  buildx)
    if [[ "${2:-}" == "build" ]]; then
      shift 2
      if has_network_flag "$@"; then
        exec "$REAL_DOCKER" buildx build "$@"
      fi
      exec "$REAL_DOCKER" buildx build --network=host "$@"
    fi
    ;;
  compose)
    run_compose_with_host_network "$@"
    ;;
  run)
    shift
    run_with_host_network run "$@"
    ;;
esac

exec "$REAL_DOCKER" "$@"
