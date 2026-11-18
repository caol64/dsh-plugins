#!/usr/bin/env bash
#
# Dev harness for dsh-omni-article-markdown.
#
# Everything runs against an ISOLATED DSH_HOME inside this repo (`.dev/home`),
# so plugin changes can be verified without touching ~/.dsh, without your
# credentials, without port 3080, and without restarting the Web GUI.
#
#   scripts/dev.sh check                  headless host: assert md_article registers
#   scripts/dev.sh check --with-installed also verify the installed copy's file set
#   scripts/dev.sh boot                   run an isolated `dsh web` for manual UI checks
#   scripts/dev.sh dump                   print the composed profile tree
#   scripts/dev.sh clean                  stop isolated processes and delete .dev/
#
# Package manager: pnpm only (see ../AGENTS.md). Never npm/npx.
#
# Verified constraints (do not "simplify" these away):
#   * `dsh <app>` is shorthand for `--profile <app>`: the app name IS the
#     profile name, and `--profile` must be given exactly once.
#   * `--patch` is a launcher flag and needs an explicit `--profile`.
#   * The `web` app never runs a model step, so a `agent/pre-step` probe never
#     fires there; tool registration is proven with the `headless` app instead.
#   * `--port`/`--no-open` belong to the web app only.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV_DIR="$ROOT/.dev"
DEV_HOME="${DEV_HOME:-$DEV_DIR/home}"
PLUGIN="dsh-omni-article-markdown"
WORK=""
DSH=""

# ---------------------------------------------------------------- safety net --
# Refuse to run package operations anywhere near the real harness home. A past
# incident ran `pnpm add` inside ~/.dsh/profiles/web by mistake; this guard
# makes that impossible however the script is invoked.
guard_not_user_profile() {
  local real_home="$HOME/.dsh"
  local pwd_real
  pwd_real="$(pwd -P)"
  for candidate in "$pwd_real" "$DEV_HOME"; do
    case "$candidate" in
      "$real_home"|"$real_home"/*)
        echo "dev.sh: refusing to operate inside $real_home (isolated home is $DEV_HOME)" >&2
        exit 1
        ;;
    esac
  done
}

# ------------------------------------------------------------------- helpers ---
resolve_dsh() {
  if [[ -n "${DSH_BIN:-}" && -x "${DSH_BIN}" ]]; then printf '%s' "$DSH_BIN"; return; fi
  if command -v dsh >/dev/null 2>&1; then command -v dsh; return; fi
  if [[ -x "$HOME/Library/pnpm/dsh" ]]; then printf '%s' "$HOME/Library/pnpm/dsh"; return; fi
  echo "dev.sh: cannot find a dsh executable; set DSH_BIN=/path/to/dsh" >&2
  exit 1
}

profile_dir() { printf '%s/profiles/%s' "$DEV_HOME" "$1"; }

cleanup_work() { [[ -n "$WORK" && -d "$WORK" ]] && rm -rf "$WORK"; WORK=""; }
# This directory has no pnpm-workspace.yaml, so pnpm materialises a local
# `.pnpm-store/` in the repo root on every run. Drop it when we are done.
cleanup_store() {
  [[ -d "$ROOT/../.pnpm-store" ]] && rm -rf "$ROOT/../.pnpm-store"
  return 0
}
cleanup_summary() { cleanup_work; cleanup_store; }
trap cleanup_summary EXIT

# A profile whose bundle list matches one shipped app template, plus this plugin.
write_profile() {
  local app="$1" dir
  dir="$(profile_dir "$app")"
  mkdir -p "$dir"
  # Node builds the manifest: no string concatenation, no quoting bugs.
  PLUGIN="$PLUGIN" ROOT="$ROOT" APP="$app" OUT="$dir/package.json" node -e '
    const fs = require("node:fs");
    const { PLUGIN, ROOT, APP, OUT } = process.env;
    const bundles = { web: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"],
                      headless: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] }[APP];
    if (!bundles) { console.error(`dev.sh: unknown app ${APP}`); process.exit(2); }
    bundles.push(PLUGIN);
    fs.writeFileSync(OUT, JSON.stringify({
      name: `dsh-profile-${APP}`, private: true,
      dependencies: { [PLUGIN]: `file:${ROOT}` },
      dsh: { profile: { bundles } },
    }, null, 2) + "\n");
  '
}

ensure_profile() {
  local app="$1" dir
  dir="$(profile_dir "$app")"
  write_profile "$app"
  # pnpm caches `file:` packages by version, so an unchanged version number
  # would silently reuse a stale copy of the source. Drop the copy first so
  # every check exercises the code as it is right now.
  rm -rf "$dir/node_modules/$PLUGIN"
  ( cd "$dir" && pnpm install --silent >/dev/null 2>&1 ) || {
    echo "dev.sh: pnpm install failed in $dir" >&2; exit 1; }
}

write_probe() {
  local dir="$1"
  cat >"$dir/probe-plugin.mjs" <<'EOF'
// Reads the host's tool registry on the first model step, then exits.
// No model call, no network, no credentials.
export const name = 'dev-probe';
export const inject = ['tools'];
export const apply = (ctx) => {
  ctx.on('agent/pre-step', async () => {
    const names = ctx.tools.definitions().map((d) => d.name);
    const has = names.includes('md_article');
    console.log(`DEVPROBE tools=${names.length} md_article=${has} has_bash=${names.includes('bash')}`);
    process.exit(has ? 0 : 3);
  });
};
EOF
  printf -- '- insert:\n    - id: dev-probe\n      name: file://%s/probe-plugin.mjs\n' "$dir" >"$dir/probe.patch.yml"
}

# ------------------------------------------------------------------- check -----
cmd_check() {
  local with_installed=0
  [[ "${1:-}" == "--with-installed" ]] && with_installed=1

  ensure_profile headless
  [[ $with_installed -eq 1 ]] && ensure_profile web
  mkdir -p "$DEV_DIR/tmp"
  WORK="$(mktemp -d "$DEV_DIR/tmp/check.XXXXXX")"
  write_probe "$WORK"

  local log="$WORK/boot.log" code=0
  set +e
  DSH_HOME="$DEV_HOME" "$DSH" --profile headless --patch "$WORK/probe.patch.yml" "noop" >"$log" 2>&1
  code=$?
  set -e

  echo "--- isolated headless host ---"
  grep -vE '^\s+at |^\s*$' "$log" | head -15 || true

  if ! grep -q 'DEVPROBE .*md_article=true' "$log"; then
    echo "FAIL: md_article did not register (exit $code)" >&2
    sed -n '/Failed plugins/,/^$/p' "$log" >&2 || true
    exit 1
  fi
  echo "PASS: md_article is registered in a real isolated host"

  if [[ $with_installed -eq 1 ]]; then
    local installed
    installed="$(profile_dir web)/node_modules/$PLUGIN"
    [[ -d "$installed" ]] || { echo "FAIL: installed copy missing: $installed" >&2; exit 1; }
    if diff -r "$installed" "$ROOT" -x test -x docs -x scripts -x node_modules -x '.dev' -x '.DS_Store' -x AGENTS.md -x pnpm-lock.yaml >/dev/null; then
      echo "PASS: installed copy matches the source tree"
    else
      echo "FAIL: installed copy differs from source" >&2
      diff -r "$installed" "$ROOT" -x test -x docs -x scripts -x node_modules -x '.dev' -x '.DS_Store' -x AGENTS.md -x pnpm-lock.yaml | head -20 >&2
      exit 1
    fi
    if [[ -d "$installed/test" || -f "$installed/src/skill.md" ]]; then
      echo "FAIL: installed copy ships files it must not" >&2
      exit 1
    fi
    echo "PASS: no test or retired assets in the installed copy"
  fi

  cat <<'TXT'

Covered : profile composition, plugin activation, tool registration, argument schema.
Not yet : Web GUI rendering — verify once after delivering to ~/.dsh/profiles/web.
TXT
}

# -------------------------------------------------------------------- boot -----
cmd_boot() {
  ensure_profile web
  echo "starting an isolated dsh web on an OS-assigned port (Ctrl-C to stop)…"
  DSH_HOME="$DEV_HOME" "$DSH" --profile web --no-open --port 0
}

# -------------------------------------------------------------------- dump -----
cmd_dump() {
  ensure_profile web
  DSH_HOME="$DEV_HOME" "$DSH" --profile web --dump-config 2>&1 \
    | awk '/^# == /{keep = ($0 ~ /dsh-omni-article-markdown/)} keep'
}

# ------------------------------------------------------------------- clean -----
cmd_clean() {
  pkill -f "DSH_HOME=$DEV_HOME" 2>/dev/null || true
  rm -rf "$DEV_DIR"
  echo "removed $DEV_DIR"
}

# -------------------------------------------------------------------- main -----
guard_not_user_profile
DSH="$(resolve_dsh)"
mkdir -p "$DEV_DIR"

# Forward only real arguments, never pnpm's own --silent/--reporter flags.
args=()
for arg in "$@"; do
  case "$arg" in
    --silent|--reporter=*|-s) ;;
    *) args+=("$arg") ;;
  esac
done
set -- ${args[@]+"${args[@]}"}

case "${1:-check}" in
  check) shift || true; cmd_check "${1:-}" ;;
  boot) cmd_boot ;;
  dump) cmd_dump ;;
  clean) cmd_clean ;;
  *)
    echo "usage: dev.sh {check [--with-installed]|boot|dump|clean}" >&2
    exit 2
    ;;
esac