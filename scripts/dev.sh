#!/usr/bin/env bash
#
# Shared dev harness for every plugin in this repository.
#
# Each plugin keeps scripts/dev.sh as a thin shim that forwards its own
# arguments here; pass the plugin directory explicitly:
#
#   bash scripts/dev.sh <plugin-dir> {check [--with-installed]|boot|dump|clean}
#
# Everything runs against an ISOLATED DSH_HOME under the repository sandbox
# (`<repo>/.dev/home`; an existing legacy `<plugin>/.dev` is reused), so plugin
# changes can be verified without touching ~/.dsh, without real credentials,
# without port 3080, and without restarting the Web GUI.
#
# Nothing here is plugin-specific: the package name, the registered tool
# (`dsh.tools` in package.json) and whether the plugin ships a web Client half
# (`dsh.client`) are all read from the plugin's package.json, so this file works
# for a new plugin whose manifest declares them.
#
# Package manager: pnpm only (see AGENTS.md). Never npm/npx.
#
# Verified constraints (do not "simplify" these away):
#   * `dsh <app>` is shorthand for `--profile <app>`: the app name IS the
#     profile name, and `--profile` must be given exactly once.
#   * `--patch` is a launcher flag and needs an explicit `--profile`.
#   * The `web` app never runs a model step, so an `agent/pre-step` probe never
#     fires there; tool registration is proven with the `headless` app instead.
#   * `--port`/`--no-open` belong to the web app only.
#   * pnpm caches `file:` packages by VERSION, so an unchanged version number
#     silently reuses a stale copy; the copy is removed before every check.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  echo "usage: dev.sh <plugin-dir> {check [--with-installed]|boot|dump|clean}" >&2
  exit 2
}

[[ $# -ge 2 ]] || usage
command -v node >/dev/null 2>&1 || { echo "dev.sh: node is required on PATH" >&2; exit 2; }
[[ -d "$1" ]] || { echo "dev.sh: no such plugin directory: $1" >&2; exit 2; }
PLUGIN_DIR="$(cd "$1" && pwd)"
[[ -f "$PLUGIN_DIR/package.json" ]] || { echo "dev.sh: no package.json in $PLUGIN_DIR" >&2; exit 2; }
shift

# The sandbox lives at the repository root (one gitignored `.dev/`), not inside
# the plugin: nothing plugin-specific is produced in development, and the
# installed-copy comparison then never has to know about it. An existing
# in-plugin sandbox from the old per-plugin harness is reused until cleaned.
REPO_DIR="$(dirname "$PLUGIN_DIR")"
DEV_DIR="$REPO_DIR/.dev"
[[ -d "$PLUGIN_DIR/.dev" ]] && DEV_DIR="$PLUGIN_DIR/.dev"
DEV_HOME="${DEV_HOME:-$DEV_DIR/home}"
DSH=""
WORK=""

manifest_field() {
  node -e '
    const value = process.argv[2].split(".").reduce((node, key) => (node == null ? node : node[key]), require(process.argv[1]));
    if (value !== undefined) process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));
  ' "$PLUGIN_DIR/package.json" "$1"
}

PLUGIN="$(manifest_field name)" || { echo "dev.sh: package.json has no name" >&2; exit 2; }
# The tool the plugin registers, when it declares one. A JSON object form
# `"tools": {"zhihu_global_search": "..."}` yields its keys.
TOOLS="$(node -e '
  const dsh = (require(process.argv[1]).dsh ?? {});
  const tools = dsh.tools ?? dsh?.bundle?.tools;
  if (!tools) process.exit(0);
  process.stdout.write(Array.isArray(tools) ? tools.join(" ") : Object.keys(tools).join(" "));
' "$PLUGIN_DIR/package.json")"
HAS_CLIENT=0
[[ -n "$(manifest_field "dsh.client.platform")" ]] && HAS_CLIENT=1

# ---------------------------------------------------------------- safety net --
# Refuse to run package operations anywhere near the real harness home. A past
# incident ran `pnpm add` inside ~/.dsh/profiles/web by mistake; this guard
# makes that impossible however the script is invoked.
guard_not_user_profile() {
  local real_home="$HOME/.dsh"
  local pwd_real
  pwd_real="$(pwd -P)"
  for candidate in "$pwd_real" "$PLUGIN_DIR" "$DEV_HOME"; do
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

# Compare an installed copy against the source tree. The package is the union
# of its shipped set (`files`, `*` within one path segment), package.json, and
# the development-only entries a link install resolves from the source; anything
# else either differs (a modified file or a stale copy) or is a shipped file the
# installed copy lost. Both outcomes are failures, with the exact paths printed.
# Exit status: 0 identical, 1 mismatch, 2 shipped file missing.
compare_installed() {
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const [installed, source] = process.argv.slice(1);
    const files = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8")).files ?? [];
    const skip = new Set(["node_modules", ".dev", ".pnpm-store", ".DS_Store"]);
    const shipped = (relative) => files.some((entry) => {
      if (entry === relative) return true;
      if (!entry.includes("/")) return relative.split("/")[0] === entry;
      const pattern = "^" + entry.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*") + "$";
      return new RegExp(pattern).test(relative);
    });
    const walk = (root) => {
      const out = new Map();
      const visit = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (skip.has(entry.name)) continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) { visit(full); continue; }
          out.set(path.relative(root, full).split(path.sep).join("/"), full);
        }
      };
      visit(root);
      return out;
    };
    const a = walk(installed);
    const b = walk(source);
    const problems = [];
    const lost = [];
    for (const [relative, full] of a) {
      if (!b.has(relative)) { problems.push("extra in installed copy: " + relative); continue; }
      if (!fs.readFileSync(full).equals(fs.readFileSync(b.get(relative)))) problems.push("differs: " + relative);
    }
    for (const relative of b.keys()) {
      if (a.has(relative) || relative === "package.json") continue;
      if (shipped(relative)) lost.push(relative);
    }
    for (const line of problems) console.log(line);
    for (const line of lost) console.log("missing shipped file: " + line);
    process.exit(lost.length > 0 ? 2 : problems.length > 0 ? 1 : 0);
  ' "$1" "$2"
}

cleanup_work() { [[ -n "$WORK" && -d "$WORK" ]] && rm -rf "$WORK"; WORK=""; }
# A directory without pnpm-workspace.yaml makes pnpm materialise a local
# `.pnpm-store/` beside it on every run. Drop it when we are done.
cleanup_store() {
  [[ -d "$PLUGIN_DIR/.pnpm-store" ]] && rm -rf "$PLUGIN_DIR/.pnpm-store"
  [[ -d "$REPO_DIR/.pnpm-store" ]] && rm -rf "$REPO_DIR/.pnpm-store"
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
  PLUGIN="$PLUGIN" PLUGIN_DIR="$PLUGIN_DIR" APP="$app" OUT="$dir/package.json" node -e '
    const fs = require("node:fs");
    const { PLUGIN, PLUGIN_DIR, APP, OUT } = process.env;
    const bundles = { web: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"],
                      headless: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] }[APP];
    if (!bundles) { console.error(`dev.sh: unknown app ${APP}`); process.exit(2); }
    bundles.push(PLUGIN);
    fs.writeFileSync(OUT, JSON.stringify({
      name: `dsh-profile-${APP}`, private: true,
      dependencies: { [PLUGIN]: `file:${PLUGIN_DIR}` },
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

# The probe reads the host's tool registry on the first model step, then exits.
# With nothing to assert it prints what the host loaded and exits 0, so a plugin
# without a declared tool can still be checked for activation.
write_probe() {
  local dir="$1"
  cat >"$dir/probe-plugin.mjs" <<'EOF'
export const name = 'dev-probe';
export const inject = ['tools'];
export const apply = (ctx) => {
  ctx.on('agent/pre-step', async () => {
    const names = ctx.tools.definitions().map((d) => d.name);
    const wanted = (process.env.DEVPROBE_TOOL ?? '').trim();
    if (wanted === '') {
      console.log(`DEVPROBE tools=${names.length} present=true has_bash=${names.includes('bash')}`);
      process.exit(0);
    }
    const missing = wanted.split(/\s+/).filter((name) => !names.includes(name));
    console.log(`DEVPROBE tools=${names.length} tool=${wanted} present=${missing.length === 0} has_bash=${names.includes('bash')}`);
    if (missing.length > 0) console.log(`DEVPROBE missing=${missing.join(',')}`);
    process.exit(missing.length === 0 ? 0 : 3);
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

  local label="${TOOLS// /,}" log="$WORK/boot.log" code=0
  label="${label:-$PLUGIN}"
  set +e
  DEVPROBE_TOOL="$TOOLS" DSH_HOME="$DEV_HOME" "$DSH" --profile headless --patch "$WORK/probe.patch.yml" "noop" >"$log" 2>&1
  code=$?
  set -e

  echo "--- isolated headless host ---"
  grep -vE '^\s+at |^\s*$' "$log" | head -15 || true

  # The probe prints `present=true` both when it asserted the declared tools and
  # when nothing was declared, so the check reads the two arms apart: a declared
  # tool needs a line that names it with present=true, and a missing tool always
  # fails, whatever else the log says.
  local line
  line="$(grep -m1 'DEVPROBE tools=' "$log" || true)"
  local missing=1
  if [[ -n "$TOOLS" && "$line" == *" tool="*" present=true"* ]]; then missing=0; fi
  if [[ -z "$TOOLS" && "$line" == *"DEVPROBE tools="* && "$line" != *"present=false"* ]]; then missing=0; fi
  if [[ $missing -eq 1 ]]; then
    echo "FAIL: $label did not register (exit $code)" >&2
    sed -n '/Failed plugins/,/^$/p' "$log" >&2 || true
    exit 1
  fi
  if [[ -n "$TOOLS" ]]; then
    echo "PASS: $label is registered in a real isolated host"
  else
    echo "PASS: $PLUGIN activates in a real isolated host (no tool declared in package.json)"
  fi

  # A Client half talks to its Host half through an exact Fetch route, which only
  # exists once a web carrier is mounted. A headless host therefore has no route,
  # and that is expected — say so instead of leaving it ambiguous.
  if [[ $HAS_CLIENT -eq 1 ]]; then
    echo "INFO: the client half ships with this plugin; its Host route mounts on a web carrier (web app), not on this headless host"
  fi

  if [[ $with_installed -eq 1 ]]; then
    local installed report=0
    installed="$(profile_dir web)/node_modules/$PLUGIN"
    [[ -d "$installed" ]] || { echo "FAIL: installed copy missing: $installed" >&2; exit 1; }
    set +e
    report="$(compare_installed "$installed" "$PLUGIN_DIR")"
    code=$?
    set -e
    [[ -n "$report" ]] && printf '%s\n' "$report" | head -20 >&2
    case "$code" in
      0) echo "PASS: installed copy matches the source tree" ;;
      2) echo "FAIL: shipped files are missing from the installed copy" >&2; exit 1 ;;
      *) echo "FAIL: installed copy differs from source" >&2; exit 1 ;;
    esac
    if [[ -d "$installed/test" || -d "$installed/.dev" ]]; then
      echo "FAIL: installed copy ships files it must not" >&2
      exit 1
    fi
    echo "PASS: no test assets in the installed copy"
  fi

  cat <<'TXT'

Covered : profile composition, plugin activation, tool registration, argument schema.
Not yet : UI rendering and a real upstream call — verify after delivering the plugin
          to ~/.dsh/profiles/web and restarting the host.
TXT
}

# -------------------------------------------------------------------- boot -----
cmd_boot() {
  ensure_profile web
  echo "starting an isolated dsh web on an OS-assigned port (Ctrl-C to stop)…"
  DSH_HOME="$DEV_HOME" "$DSH" --profile web --no-open --port 0
}

# -------------------------------------------------------------------- dump -----
# One row per line, for the rows whose composed `name:` is this plugin. Matching
# the composed value rather than the `# == <layer>` banner is deliberate: a
# bundle's rows can follow a banner naming another layer, and a prefix match on
# the plugin name also hits the banner line and makes the whole dump look
# plugin-owned (that regression already happened once in a per-plugin copy).
cmd_dump() {
  ensure_profile web
  DSH_HOME="$DEV_HOME" "$DSH" --profile web --dump-config 2>&1 \
    | awk -v want="$PLUGIN" '/^- / { if (block ~ ("\n  name: .*" want "\\n")) printf "%s", block; block = $0 "\n"; next } { block = block $0 "\n" } END { if (block ~ ("\n  name: .*" want "\\n")) printf "%s", block }'
}

# ------------------------------------------------------------------- clean -----
cmd_clean() {
  pkill -f "DSH_HOME=$DEV_HOME" 2>/dev/null || true
  # Both locations: the repository sandbox holds every plugin's profile, and a
  # relocated $DEV_HOME must go too.
  rm -rf "$REPO_DIR/.dev" "$PLUGIN_DIR/.dev" "$DEV_HOME"
  echo "removed $REPO_DIR/.dev and $PLUGIN_DIR/.dev"
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
  *) usage ;;
esac