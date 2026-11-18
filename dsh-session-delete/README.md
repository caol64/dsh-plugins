# dsh-session-delete

DeepSeek Harness（DSH）插件：在侧栏工作区的会话菜单里加一个**「删除会话」**，确认后把该会话在磁盘上的文件彻底删除，并立即从会话列表移除。

> ⚠️ **删除不可恢复。** 这是永久删除，不是归档/隐藏。

## 功能

在侧栏任意会话行上点「…」（或右键）打开菜单，**最下面**（内置的置顶 / 重命名 / 分支 / 复制 ID / 归档之后）出现红色的「删除会话」。点击后该行变为「再次点击确认删除」，4 秒内不点自动还原；关闭菜单即取消。

确认后 Host 依次执行：

1. **停掉正在运行的回合**（若有）：通过会话控制器取消，并在限定时间内等待其停下；停不下来就拒绝删除，**一个文件都不动**。
2. **定位**：用 `sessionPersistence.stat()` 报出的日志路径定位会话目录，并做归属校验（见「安全边界」）。
3. **删投影缓存**：`session_projcache` 域记录 + 文档 + 备份。
4. **删日志目录**：`<DSH_HOME>/sessions/<project>/<session-id>/` 整个目录（含所有格式代与 `session.lock`）。
5. **清记账**：工作区归属、归档集合、置顶集合。
6. **刷新列表**：发出官方的 `api-session/removed` 事件，所有已连接的浏览器立即移除该行，无需刷新页面。

## 安装

```bash
# 从本地目录
dsh plugin --profile web add file:/absolute/path/to/dsh-session-delete

# 或从 npm（发布后）
dsh plugin --profile web add dsh-session-delete
```

安装后**重启宿主**：正在运行的进程不会加载新代码。

卸载：

```bash
dsh plugin --profile web remove dsh-session-delete
```

## 配置

全部可省略。要覆盖时，在 profile 自己的 patch 文件（`~/.dsh/profiles/web/cordis.patch.yml`）里写一条**只包含要改的键**的行——配置是替换语义，不要整块重写：

```yaml
- id: session-delete
  config:
    stopTimeoutMs: 15000
```

| 键 | 默认 | 说明 |
|---|---|---|
| `stopTimeoutMs` | `8000` | 取消运行中回合后等待其停止的上限（毫秒，0–120000）。超时则拒绝删除。 |
| `allowDeleteRunning` | `true` | `false` 时，运行中的会话直接拒绝（`agent-busy`），不尝试取消。 |
| `deleteProjectionCache` | `true` | 是否同时删除投影缓存记录。 |

## 安全边界

删除是危险操作，因此路径必须能被**证明**属于该会话：

- 会话 id 必须是单段 `[A-Za-z0-9][A-Za-z0-9._-]*`；`..`、路径分隔符、空串在**任何 I/O 之前**拒绝。
- 日志目录的目录名必须恰好等于会话 id。
- `realpath` 解析后必须严格位于 `<DSH_HOME>/sessions` 之下（符号链接会被解析后比较）。
- 拒绝发生在删除任何文件**之前**：拒绝 = 磁盘原样。
- 删除目录之后的所有收尾步骤失败只记录为 warning，不会把成功报成失败。
- **不删除附件**：`attachments/` 是内容寻址、多个会话共享的。
- 请求只接受同源、已认证的 POST（宿主 Web 载体的 Host/Origin 围栏 + owner-Peer 校验），请求体上限 4 KiB。

## 错误码

失败时接口返回 `{ ok: false, code, message, removed }`，菜单里显示对应文案：

| code | HTTP | 含义 |
|---|---|---|
| `invalid-id` | 400 | 会话 id 不合法 |
| `session-not-found` | 404 | 会话已不存在 |
| `agent-busy` | 409 | 会话在运行，且配置禁止删除运行中的会话 |
| `agent-stuck` | 409 | 运行中的回合未在限定时间内停止，未删除任何文件 |
| `denied-path` | 403 | 无法证明文件属于该会话，未删除任何文件 |
| `delete-failed` | 500 | 删除过程中出错，可能只删除了一部分 |
| `internal` | 500 | 意外错误，详见宿主日志 |

## 开发

```bash
pnpm test                 # 离线单测
pnpm run check            # 隔离 DSH_HOME 起 headless 宿主，断言插件激活
pnpm run dev:boot         # 隔离 dsh web（OS 分配端口、不打开浏览器），人工看菜单
pnpm run clean            # 停掉隔离进程并删除 .dev/
```

结构与约束见 [`AGENTS.md`](./AGENTS.md)，设计决策与踩坑见 [`docs/DEVELOPMENT-LOG.md`](./docs/DEVELOPMENT-LOG.md)。

## 许可证

MIT