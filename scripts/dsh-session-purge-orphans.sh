#!/usr/bin/env bash
#
# dsh-session-purge-orphans — 清理"孤儿"会话数据。
#
# 用法:
#   dsh-session-purge-orphans                 # 预演：列出所有孤儿，不删除
#   dsh-session-purge-orphans --yes           # 真正删除
#   dsh-session-purge-orphans --yes -f        # 跳过"DSH 是否在运行"的检查
#   dsh-session-purge-orphans --cache-only    # 只处理孤儿缓存（不含记账）
#   dsh-session-purge-orphans --ledger-only   # 只处理孤儿记账
#
# 什么是"孤儿": 某个 sessionId 在某一处留有数据，但 sessions/ 下已经没有它的会话目录。
# 会话目录是唯一真相；没有目录 = 会话不存在，其余都是残留。
#
# 会处理三类残留:
#   A. 孤儿缓存    storages/session_projcache/sessions/<id>.json(.bak.*)  没有会话目录
#   B. 孤儿记账    storages/workspace.json 里的归属/归档/置顶              没有会话目录
#   C. 空会话目录  sessions/<项目>/<id>/ 完全为空                          没有任何数据
#
# 绝不会删除: 有会话目录的会话、attachments/、logs/、profiles/。
#
# 建议: 先完全退出 DSH 再运行（运行中的进程可能把投影缓存写回）。
set -euo pipefail

GREEN=''; YELLOW=''; RED=''; DIM=''; RESET=''
if [[ -t 1 ]]; then
  GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; DIM=$'\033[2m'; RESET=$'\033[0m'
fi

die() { printf '%s错误:%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }
note() { printf '%s\n' "$*"; }
warn() { printf '%s注意:%s %s\n' "$YELLOW" "$RESET" "$*"; }

usage() {
  sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 2
}

# bash 3.2 + `set -u` treats "${empty[@]}" as unbound; expand safely.
each() { # each <array-name> ; reads elements on stdout, one per line
  local name="$1"
  eval "local n=\${#$name[@]}"
  [[ "$n" -gt 0 ]] || return 0
  eval "printf '%s\\n' \"\${$name[@]}\""
}

# ---------------------------------------------------------------- 参数 -----
APPLY=0
FORCE=0
MODE=all
for arg in "$@"; do
  case "$arg" in
    --yes|-y) APPLY=1 ;;
    --force|-f) FORCE=1 ;;
    --cache-only) MODE=cache ;;
    --ledger-only) MODE=ledger ;;
    -h|--help) usage ;;
    *) die "未知参数: $arg" ;;
  esac
done

# --------------------------------------------------------------- DSH_HOME --
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
[[ -d "$DSH_HOME" ]] || die "找不到 DSH 目录: ${DSH_HOME} （可用 DSH_HOME=... 指定）"
DSH_HOME="$(cd "$DSH_HOME" && pwd -P)"

SESSIONS="$DSH_HOME/sessions"
CACHE_DIR="$DSH_HOME/storages/session_projcache/sessions"
WS_JSON="$DSH_HOME/storages/workspace.json"

# ------------------------------------------------------- DSH 是否在运行 ----
if [[ $APPLY -eq 1 && $FORCE -eq 0 ]]; then
  if pgrep -f "dsh( |$).*(--profile|web|headless)" >/dev/null 2>&1; then
    warn "检测到可能有 dsh 进程在运行。"
    note "  DSH 退出时可能把投影缓存写回，造成刚清掉的记录又出现。"
    note "  请先完全退出 DSH；确认无妨可加 -f 跳过此检查。"
    pgrep -fl "dsh( |$).*(--profile|web|headless)" 2>/dev/null | sed 's/^/    /' || true
    die "已中止。请关闭 DSH 后重试。"
  fi
fi

# ------------------------------------------------------------ 收集目标 ----
# 用 node 一次性算出全部结论，避免在 shell 里做复杂的集合运算。
# 输出格式（每行一个，字段以 \t 分隔）:
#   DIR<TAB>路径           空会话目录
#   CACHE<TAB>路径         孤儿缓存文件
#   LEDGER<TAB>说明         孤儿记账位置
SUMMARY="$(
  node - "$DSH_HOME" "$MODE" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [home, mode] = process.argv.slice(2);

const sessionsDir = path.join(home, "sessions");
const cacheDir = path.join(home, "storages", "session_projcache", "sessions");
const wsFile = path.join(home, "storages", "workspace.json");
const SID = /^session-[A-Za-z0-9._-]+$/;

/** Session ids that still have a directory, plus the empty ones. */
const live = new Set();
const emptyDirs = [];
if (fs.existsSync(sessionsDir)) {
  for (const project of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const projectPath = path.join(sessionsDir, project.name);
    for (const entry of fs.readdirSync(projectPath, { withFileTypes: true })) {
      if (!entry.isDirectory() || !SID.test(entry.name)) continue;
      const full = path.join(projectPath, entry.name);
      if (fs.readdirSync(full).length === 0) emptyDirs.push(full);
      else live.add(entry.name);
    }
  }
}

const out = [];
if (mode !== "ledger") for (const dir of emptyDirs) out.push(`DIR\t${dir}`);

// A. orphan cache documents: a cache id with no live session directory.
if (mode !== "ledger" && fs.existsSync(cacheDir)) {
  for (const file of fs.readdirSync(cacheDir)) {
    const match = /^(session-[A-Za-z0-9._-]+?)\.json(?:\.bak\..*)?$/.exec(file);
    if (!match) continue;
    if (live.has(match[1])) continue;          // real session — keep
    if (emptyDirs.some((dir) => path.basename(dir) === match[1])) continue; // its dir is empty, kept with C
    out.push(`CACHE\t${path.join(cacheDir, file)}`);
  }
}

// B. orphan ledger entries: an id recorded in workspace.json with no directory.
if (mode !== "cache" && fs.existsSync(wsFile)) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(wsFile, "utf8")); } catch { doc = undefined; }
  if (doc) {
    const seen = new Set();
    const report = (id, where) => {
      if (!SID.test(String(id)) || live.has(id)) return;
      if (emptyDirs.some((dir) => path.basename(dir) === id)) return;
      const key = `${id}\t${where}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(`LEDGER\t${where}\t${id}`);
    };
    const global = doc.global ?? {};
    for (const key of ["archivedSessionIds", "pinnedSessionIds"]) {
      for (const id of Array.isArray(global[key]) ? global[key] : []) report(id, `global.${key}`);
    }
    for (const [wsId, ws] of Object.entries(doc.tables?.workspaces ?? {})) {
      for (const id of Array.isArray(ws.sessionIds) ? ws.sessionIds : []) report(id, `workspaces[${wsId}].sessionIds`);
    }
  }
}

process.stdout.write(out.join("\n"));
NODE
)"

DIRS=(); CACHE_FILES=(); LEDGER_HITS=()
if [[ -n "$SUMMARY" ]]; then
  while IFS=$'\t' read -r kind a b; do
    case "$kind" in
      DIR) DIRS+=("$a") ;;
      CACHE) CACHE_FILES+=("$a") ;;
      # keep "where<TAB>id" so both the preview and the delete step can use it
      LEDGER) LEDGER_HITS+=("$a"$'\t'"$b") ;;
    esac
  done <<< "$SUMMARY"
fi

# ------------------------------------------------------------- 预演输出 ---
note "DSH_HOME : $DSH_HOME"
note "模式     : $MODE"
note ""

if [[ ${#DIRS[@]} -eq 0 && ${#CACHE_FILES[@]} -eq 0 && ${#LEDGER_HITS[@]} -eq 0 ]]; then
  note "${GREEN}没有发现孤儿数据，无需清理。${RESET}"
  exit 0
fi

if [[ ${#CACHE_FILES[@]} -gt 0 ]]; then
  note "孤儿缓存（${#CACHE_FILES[@]} 个文件）:"
  while IFS= read -r file; do
    [[ -n "$file" ]] || continue
    note "  ${RED}•${RESET} $file  ${DIM}($(du -h "$file" 2>/dev/null | cut -f1 || echo '?'))${RESET}"
  done < <(each CACHE_FILES)
  note ""
fi

if [[ ${#DIRS[@]} -gt 0 ]]; then
  note "空会话目录（${#DIRS[@]} 个）:"
  while IFS= read -r dir; do
    [[ -n "$dir" ]] || continue
    note "  ${RED}•${RESET} $dir"
  done < <(each DIRS)
  note ""
fi

if [[ ${#LEDGER_HITS[@]} -gt 0 ]]; then
  note "孤儿记账（${#LEDGER_HITS[@]} 处）:"
  while IFS= read -r hit; do
    [[ -n "$hit" ]] || continue
    where="${hit%%$'\t'*}"; id="${hit##*$'\t'}"
    note "  ${RED}•${RESET} $where  ${DIM}($id)${RESET}"
  done < <(each LEDGER_HITS)
  note ""
fi

if [[ $APPLY -eq 0 ]]; then
  warn "这是预演，未做任何修改。确认无误后加 --yes 执行:"
  note "  $0 --yes"
  exit 0
fi

# --------------------------------------------------------------- 执行 -----
stamp="$(date +%Y%m%d-%H%M%S)"
backup_root="$DSH_HOME/.purge-backup"

# 1) 记账：先备份再原子替换
if [[ ${#LEDGER_HITS[@]} -gt 0 ]]; then
  mkdir -p "$backup_root"
  cp -p "$WS_JSON" "$backup_root/$stamp-workspace.json"
  LEFTOVER="$(each LEDGER_HITS | cut -f2 | sort -u | paste -sd, -)"
  node - "$WS_JSON" "$LEFTOVER" <<'NODE'
const fs = require("node:fs");
const [file, list] = process.argv.slice(2);
const dead = new Set(list.split(",").filter(Boolean));
const doc = JSON.parse(fs.readFileSync(file, "utf8"));
const strip = (arr) => (Array.isArray(arr) ? arr.filter((id) => !dead.has(id)) : arr);
let removed = 0;
const track = (before, after) => { removed += before.length - after.length; return after; };
if (doc.global) {
  doc.global.archivedSessionIds = track(doc.global.archivedSessionIds ?? [], strip(doc.global.archivedSessionIds));
  doc.global.pinnedSessionIds = track(doc.global.pinnedSessionIds ?? [], strip(doc.global.pinnedSessionIds));
}
for (const ws of Object.values(doc.tables?.workspaces ?? {})) {
  ws.sessionIds = track(ws.sessionIds ?? [], strip(ws.sessionIds));
}
if (removed > 0) {
  const tmp = `${file}.purge.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
  fs.renameSync(tmp, file);
}
console.log(`  记账已清理 ${removed} 处`);
NODE
fi

# 2) 缓存文档
while IFS= read -r file; do
  [[ -n "$file" ]] || continue
  rm -f -- "$file"
  note "  已删除缓存: $file"
done < <(each CACHE_FILES)

# 3) 空目录
while IFS= read -r dir; do
  [[ -n "$dir" ]] || continue
  rmdir -- "$dir" 2>/dev/null || rm -rf -- "$dir"
  note "  已删除空目录: $dir"
done < <(each DIRS)

note ""
note "${GREEN}完成。${RESET}"
[[ -f "$backup_root/$stamp-workspace.json" ]] && note "${DIM}workspace.json 已备份到: $backup_root/$stamp-workspace.json${RESET}"
note "${DIM}如果 DSH 侧栏还有残留，刷新页面即可。${RESET}"