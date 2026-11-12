#!/usr/bin/env bash
# One dispatcher pass with the defaults, against the branch checked out in the current directory.
#   .sandcastle/dispatch.sh [--dry-run] [--max N] [--whole-issues]
#   .sandcastle/dispatch.sh --issue N [--no-push]
# Extra arguments go to dispatch.mts. With --issue N it runs that one ticket now instead, in the
# foreground (main.mts --issue N, extra arguments to main.mts), after the same checks; the output also
# goes to .sandcastle/logs/run-N.log, where a dispatched run's log goes. `factory run N` uses this.
# Checks the tools, logins and .sandcastle/.env first (which ones
# follows TRACKER.kind and AGENT.provider in config.mts: glab or gh, claude or pi; with the personal
# config's pi-claude-subscription provider, claude's login, the provider extension and the models, see
# preflight.mts, and the container's CLAUDE_CODE_OAUTH_TOKEN), then the image: from a
# terminal a missing or mismatched image is built; without one (the timer) the pass stops and says
# how to build it, so a background pass never starts a long build.
set -euo pipefail
# Same run-state folder as the timer and the board service, so hand-started passes show on the board.
export SANDCASTLE_STATE_DIR="${SANDCASTLE_STATE_DIR:-$HOME/.local/state/factory}"

fail() { echo "dispatch.sh: $*" >&2; exit 1; }

# --issue N picks one ticket. Parsed before the checks so a bad argument fails at once.
issue=""
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --issue) [ $# -ge 2 ] || fail "--issue needs a ticket number."; issue="$2"; shift 2 ;;
    --issue=*) issue="${1#--issue=}"; shift ;;
    *) args+=("$1"); shift ;;
  esac
done
if [ -n "$issue" ]; then
  [[ "$issue" =~ ^[1-9][0-9]*$ ]] || fail "--issue needs a ticket number, got \"$issue\"."
  for a in ${args[@]+"${args[@]}"}; do
    case "$a" in --dry-run | --max | --max=*) fail "$a is for a dispatcher pass, not --issue." ;; esac
  done
fi

root="$(git rev-parse --show-toplevel 2>/dev/null)" || fail "not inside a git repository."
cd "$root"
[ -f .sandcastle/dispatch.mts ] || fail "no .sandcastle/dispatch.mts in $root."

base="$(git branch --show-current)"
[ -n "$base" ] || fail "detached HEAD. Check out the integration branch first."
[ "$base" = "spike-1" ] || fail "R2 Factory runs must target spike-1, never main."
git ls-remote --exit-code --heads origin "$base" >/dev/null || fail "branch $base isn't on origin. Push it, or check out the integration branch."

# Read from the project's own config so the checks match what the runs use. A config without these
# fields is the GitLab + Claude Code one.
cfg_value() { sed -nE "s/^[[:space:]]*$1:[[:space:]]*\"([^\"]+)\".*/\\1/p" .sandcastle/config.mts | head -n 1; }
kind="$(cfg_value kind)"; kind="${kind:-gitlab}"
agent="$(cfg_value provider)"; agent="${agent:-claude}"
image="$(sed -nE 's/^[[:space:]]*image:[[:space:]]*"([^"]+)".*/\1/p' .sandcastle/main.mts | head -n 1)"
[ -n "$image" ] || fail "couldn't read CONFIG.image from .sandcastle/main.mts."
case "$kind" in gitlab) tracker_cli=glab ;; github) tracker_cli=gh ;; *) fail "unknown TRACKER.kind \"$kind\" in .sandcastle/config.mts." ;; esac
case "$agent" in claude | pi) ;; *) fail "unknown AGENT.provider \"$agent\" in .sandcastle/config.mts." ;; esac

for tool in node npm npx git "$tracker_cli" "$agent" docker curl; do
  command -v "$tool" >/dev/null || fail "$tool isn't on the PATH."
done

if [ "$kind" = gitlab ]; then
  host="$(cfg_value gitlabHost)"
  [ -n "$host" ] || fail "couldn't read TRACKER.gitlabHost from .sandcastle/config.mts."
  glab auth status --hostname "$host" >/dev/null 2>&1 || fail "glab isn't logged in to $host. Run: glab auth login --hostname $host"
else
  host="$(cfg_value host)"; host="${host:-github.com}"
  gh auth status --hostname "$host" >/dev/null 2>&1 || fail "gh isn't logged in to $host. Run: gh auth login --hostname $host"
fi
# The ticket analysis runs this agent on the host with its own login. With pi and the pi-claude-subscription
# provider that login is claude's, and the container runs use CLAUDE_CODE_OAUTH_TOKEN (checked below).
subscription=0
if [ "$agent" = claude ]; then
  claude auth status 2>/dev/null | grep -q '"loggedIn": *true' || fail "claude isn't logged in. Run: claude auth login"
elif grep -q '"pi-claude-subscription/' .sandcastle/config.mts; then
  subscription=1
  [ -f .sandcastle/preflight.mts ] || fail "no .sandcastle/preflight.mts in $root."
  node .sandcastle/preflight.mts >&2 || exit 1
else
  # A custom pi config on openai/ models: the container runs use the host's pi login.
  pi auth check --provider openai >/dev/null 2>&1 || fail "pi has no working OpenAI login. Run pi, then /login, and pick Sign in with ChatGPT."
fi
docker info >/dev/null 2>&1 || fail "Docker isn't running, or this user can't reach it."

# Claude Code in the container logs in with .sandcastle/.env, not the host's login: the client config's
# agent, and the CLI behind pi-claude-subscription. Check the credential with an empty Messages request: a
# bad one gets 401, a good one 400. No tokens are used, and the value is never printed or put on a command
# line. A pi config on openai/ models needs nothing here: each run gets a fresh token from the host's pi
# login, checked above.
env_file=.sandcastle/.env
[ -f "$env_file" ] || fail "no $env_file. Run: cp .sandcastle/.env.example $env_file, then fill it in."
if [ "$agent" = claude ] || [ "$subscription" = 1 ]; then
  env_value() { sed -nE "s/^[[:space:]]*(export[[:space:]]+)?$1=[\"']?([^\"'#[:space:]]*).*/\2/p" "$env_file" | tail -n 1; }
  if token="$(env_value CLAUDE_CODE_OAUTH_TOKEN)" && [ -n "$token" ]; then
    key_name=CLAUDE_CODE_OAUTH_TOKEN
    auth_header="Authorization: Bearer $token"
  elif [ "$agent" = claude ] && token="$(env_value ANTHROPIC_API_KEY)" && [ -n "$token" ]; then
    # Only the client config's Claude Code accepts an API key. pi-claude-subscription strips ANTHROPIC_API_KEY.
    key_name=ANTHROPIC_API_KEY
    auth_header="x-api-key: $token"
  else
    fail "CLAUDE_CODE_OAUTH_TOKEN in $env_file is empty. Run: claude setup-token, and paste the token there."
  fi
  status="$(printf '%s\n' "$auth_header" | curl -sS -o /dev/null -w '%{http_code}' --max-time 20 -H @- \
    -H 'anthropic-version: 2023-06-01' -H 'anthropic-beta: oauth-2025-04-20' -H 'content-type: application/json' \
    -d '{}' https://api.anthropic.com/v1/messages)" || fail "couldn't reach api.anthropic.com to check $key_name."
  unset token auth_header
  case "$status" in
    401 | 403) fail "$key_name in $env_file was rejected. For a new token run: claude setup-token" ;;
    400 | 200) ;;
    *) fail "checking $key_name got HTTP $status from api.anthropic.com. Try again shortly." ;;
  esac
fi

# Sandcastle runs the container as this user, and refuses an image built for another UID.
problem=""
if ! user="$(docker image inspect "$image" --format '{{.Config.User}}' 2>/dev/null)"; then
  problem="image $image doesn't exist"
elif [ -n "$user" ] && [ "${user%%:*}" != "$(id -u)" ]; then
  problem="image $image was built for UID ${user%%:*}, not $(id -u)"
fi
if [ -n "$problem" ]; then
  build="npx sandcastle docker build-image --image-name $image"
  [ -t 0 ] || fail "$problem. Build it from a terminal in $root: $build"
  echo "$problem; building it (takes a few minutes)."
  $build
fi

# The pass imports @ai-hero/sandcastle from the project's node_modules. Install when it's missing or
# older than the lockfile; quick enough to run under the timer too.
if [ ! -d node_modules/@ai-hero/sandcastle ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "node dependencies missing or out of date; installing."
  if [ -f package-lock.json ]; then npm ci; else npm install; fi
fi

if [ -n "$issue" ]; then
  mkdir -p .sandcastle/logs
  log=".sandcastle/logs/run-$issue.log"
  echo "Running #$issue on $base in the foreground; the output also goes to $log."
  set +e
  npx tsx .sandcastle/main.mts --base "$base" --issue "$issue" ${args[@]+"${args[@]}"} 2>&1 | tee -a "$log"
  exit "${PIPESTATUS[0]}"
fi
exec node .sandcastle/dispatch.mts --base "$base" ${args[@]+"${args[@]}"}
