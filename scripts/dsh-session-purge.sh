#!/usr/bin/env bash
#
# dsh-session-purge — 在 DSH 关闭的情况下，按 sessionId 手动删除一个会话。
#
# 用法:
#   dsh-session-purge <session-id>            # 预演：只显示将删除什么
#   dsh-session-purge <session-id> --yes      # 真正执行
#   dsh-session-purge <session-id> --yes -f   # 跳过"DSH 是否在运行"的检查
#
# 会话 id 从 DSH 侧栏会话行的「…」菜单 →「复制 Session ID」获得，
# 形如 session-6caab27d-f091-43d2-a99d-c2a6677a5c57。
#
# 会删除三处：
#   1. $DSH_HOME/sessions/<项目编码>/<session-id>/     整个目录
#   2. $DSH_HOME/storages/session_projcache/sessions/<session-id>.json  （含 .bak.*）
#   3. $DSH_HOME/storages/workspace.json 中该 id 的记账（归属/归档/置顶）
#
# 设计原则：
#   - 默认只预演，必须显式 --yes 才动手；
#   - 删除前要求 DSH 未运行（避开进程退出时把投影缓存写回的问题）；
#   - id 只接受单段安全字符，防止误删到别的路径；
#   - 所有路径都在 $DSH_HOME 之下，删除前逐条打印。
set -euo pipefail

GREEN=''; YELLOW=''; RED=''; DIM=''; RESET=''
if [[ -t 1 ]]; then
  GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; DIM=$'\033[2m'; RESET=$'\033[0m'
fi

die() { printf '%s错误:%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }
note() { printf '%s\n' "$*"; }
warn() { printf '%s注意:%s %s\n' "$YELLOW" "$RESET" "$*"; }

usage() {
  sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 2
}

# ---------------------------------------------------------------- 参数 -----
[[ $# -ge 1 ]] || usage
case "${1:-}" in -h|--help) usage ;; esac
SID="$1"; shift

APPLY=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y) APPLY=1 ;;
    --force|-f) FORCE=1 ;;
    -h|--help) usage ;;
    *) die "未知参数: $arg" ;;
  esac
done

# sessionId 必须是单段：字母数字开头，只含 [A-Za-z0-9._-]，且不含 ".."
[[ "$SID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "不是合法的 sessionId: $SID"
[[ "$SID" != *".."* ]] || die "sessionId 不得包含 '..': $SID"

# --------------------------------------------------------------- DSH_HOME --
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
[[ -d "$DSH_HOME" ]] || die "找不到 DSH 目录: ${DSH_HOME} （可用 DSH_HOME=... 指定）"
DSH_HOME="$(cd "$DSH_HOME" && pwd -P)"   # 规范化，去掉符号链接与尾部斜杠

SESSIONS="$DSH_HOME/sessions"
CACHE_DIR="$DSH_HOME/storages/session_projcache/sessions"
WS_JSON="$DSH_HOME/storages/workspace.json"

# ------------------------------------------------------- DSH 是否在运行 ----
if [[ $APPLY -eq 1 && $FORCE -eq 0 ]]; then
  if pgrep -f "dsh( |$).*(--profile|web|headless)" >/dev/null 2>&1; then
    warn "检测到可能有 dsh 进程在运行。"
    note "  DSH 运行时删除，进程退出时可能把投影缓存文件写回，留下孤儿记录。"
    note "  请先完全退出 DSH；确认无妨可加 -f 跳过此检查。"
    printf '  相关进程:\n'
    pgrep -fl "dsh( |$).*(--profile|web|headless)" 2>/dev/null | sed 's/^/    /' || true
    die "已中止。请关闭 DSH 后重试。"
  fi
fi

# ------------------------------------------------------------ 定位目标 ----
# 兼容 macOS 自带的 bash 3.2（没有 mapfile），用逐行读取构造数组。
read_lines() {
  local out=()
  while IFS= read -r line; do
    [[ -n "$line" ]] && out+=("$line")
  done
  printf '%s\n' "${out[@]+${out[@]}}"
}
to_array() { # $1 = array name, stdin = lines
  local name="$1" line
  eval "$name=()"
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    eval "$name+=(\"\$line\")"
  done
}

# 会话目录可能在任何项目编码目录下；按目录名精确匹配（不递归进会话目录内部）。
if [[ -d "$SESSIONS" ]]; then
  to_array SESSION_DIRS < <(find "$SESSIONS" -mindepth 2 -maxdepth 2 -type d -name "$SID" -print 2>/dev/null)
else
  SESSION_DIRS=()
fi

if [[ -d "$CACHE_DIR" ]]; then
  to_array CACHE_FILES < <(find "$CACHE_DIR" -mindepth 1 -maxdepth 1 \( -name "$SID.json" -o -name "$SID.json.bak.*" \) -type f -print 2>/dev/null)
else
  CACHE_FILES=()
fi

# workspace.json 里引用该 id 的位置（只读扫描，用于预演与删除）
ws_refs() {
  [[ -f "$WS_JSON" ]] || return 0
  node - "$WS_JSON" "$SID" <<'NODE'
const fs = require("node:fs");
const [file, sid] = process.argv.slice(2);
let doc;
try { doc = JSON.parse(fs.readFileSync(file, "utf8")); } catch { process.exit(0); }
const hits = [];
const g = doc.global ?? {};
for (const key of ["archivedSessionIds", "pinnedSessionIds"]) {
  if (Array.isArray(g[key]) && g[key].includes(sid)) hits.push(`global.${key}`);
}
for (const [id, ws] of Object.entries(doc.tables?.workspaces ?? {})) {
  if (Array.isArray(ws.sessionIds) && ws.sessionIds.includes(sid)) hits.push(`workspaces[${id.slice(0, 8)}…].sessionIds`);
}
if (hits.length) console.log(hits.join("\n"));
NODE
}
to_array WS_HITS < <(ws_refs)

# ------------------------------------------------------------- 预演输出 ---
note "DSH_HOME : $DSH_HOME"
note "sessionId: $SID"
note ""

if [[ ${#SESSION_DIRS[@]} -eq 0 && ${#CACHE_FILES[@]} -eq 0 && ${#WS_HITS[@]} -eq 0 ]]; then
  note "没有找到该会话的任何痕迹。"
  note "${DIM}可能 id 有误，或它已经被删除。${RESET}"
  exit 0
fi

note "将要删除:"
for dir in "${SESSION_DIRS[@]}"; do
  size=$(du -sh "$dir" 2>/dev/null | cut -f1 || echo "?")
  note "  ${RED}[日志目录]${RESET} $dir  ${DIM}(${size})${RESET}"
done
for file in "${CACHE_FILES[@]}"; do
  size=$(du -h "$file" 2>/dev/null | cut -f1 || echo "?")
  note "  ${RED}[缓存文档]${RESET} $file  ${DIM}(${size})${RESET}"
done
for hit in "${WS_HITS[@]}"; do
  note "  ${RED}[记账]${RESET}    $WS_JSON → $hit"
done
note ""

if [[ $APPLY -eq 0 ]]; then
  warn "这是预演，未做任何修改。确认无误后加 --yes 执行:"
  note "  $0 $SID --yes"
  exit 0
fi

# --------------------------------------------------------------- 执行 -----
stamp="$(date +%Y%m%d-%H%M%S)"
backup_dir="$DSH_HOME/.purge-backup/$stamp-$SID"
made_backup=0

# 1) 先改记账（改 JSON 不耗时，也最不容易半途而废）
if [[ ${#WS_HITS[@]} -gt 0 ]]; then
  mkdir -p "$backup_dir"
  cp -p "$WS_JSON" "$backup_dir/workspace.json"
  made_backup=1
  node - "$WS_JSON" "$SID" <<'NODE'
const fs = require("node:fs");
const [file, sid] = process.argv.slice(2);
const doc = JSON.parse(fs.readFileSync(file, "utf8"));
let changed = 0;
const strip = (list) => {
  if (!Array.isArray(list)) return list;
  const next = list.filter((id) => id !== sid);
  if (next.length !== list.length) changed += list.length - next.length;
  return next;
};
if (doc.global) {
  doc.global.archivedSessionIds = strip(doc.global.archivedSessionIds);
  doc.global.pinnedSessionIds = strip(doc.global.pinnedSessionIds);
}
for (const ws of Object.values(doc.tables?.workspaces ?? {})) ws.sessionIds = strip(ws.sessionIds);
if (changed > 0) {
  const tmp = file + ".purge.tmp";
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
  fs.renameSync(tmp, file);   // 原子替换
}
console.log(`  记账已清理 ${changed} 处`);
NODE
fi

# 2) 删缓存文档
for file in "${CACHE_FILES[@]}"; do
  rm -f -- "$file"
  note "  已删除缓存: $file"
done

# 3) 删会话目录（最后，耗时最长也最不可逆）
for dir in "${SESSION_DIRS[@]}"; do
  rm -rf -- "$dir"
  note "  已删除目录: $dir"
done

note ""
if [[ $made_backup -eq 1 ]]; then
  note "${GREEN}完成。${RESET}workspace.json 的备份在: $backup_dir"
else
  note "${GREEN}完成。${RESET}"
fi
note "${DIM}如果 DSH 侧栏还显示该会话，刷新页面即可。${RESET}"