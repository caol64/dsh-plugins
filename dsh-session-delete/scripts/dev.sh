#!/usr/bin/env bash
#
# Self-test entry for dsh-session-delete. The harness itself lives in the
# repository's shared script so that it cannot drift between plugins:
#
#   scripts/dev.sh check                  headless host: assert the plugin activates
#   scripts/dev.sh check --with-installed also verify the installed copy's file set
#   scripts/dev.sh boot                   run an isolated `dsh web` for manual UI checks
#   scripts/dev.sh dump                   print the composed profile rows of this plugin
#   scripts/dev.sh clean                  stop isolated processes and delete .dev/
#
# This plugin registers no native tool, so `check` asserts activation only (the
# shared script does that when `dsh.tools` is absent). The package name comes
# from package.json, so this file needs no edit when it changes. See
# scripts/dev.sh at the repository root for the constraints that shaped it
# (isolated DSH_HOME, pnpm-only, the `~/.dsh` guard).
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# `pnpm run dev:check` invokes `bash scripts/dev.sh dev:check …`, so the first
# argument is the script name pnpm appended. Drop exactly that one — never every
# argument that looks like a script name, or a real `check` would be dropped too.
args=("$@")
first="${args[0]-}"
if [[ ${#args[@]} -gt 0 && ( "$first" == "dev:"* || "$first" == */dev.sh || "$first" == scripts/* ) ]]; then
  args=("${args[@]:1}")
fi

exec bash "$PLUGIN_DIR/../scripts/dev.sh" "$PLUGIN_DIR" ${args[@]+"${args[@]}"}