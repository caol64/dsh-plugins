# 开发记录 — dsh-session-delete

记录设计决策与踩坑。改设计前先读本文件；新踩的坑追加到第 4 节，并补一条能复现它的用例。

## 1. 需求与方案选择

需求：在侧栏「工作区」的会话行上右键 / 点「…」，弹出上下文菜单，**最下面**加「删除」；确认后删除磁盘上该会话的全部相关文件，并刷新会话列表。

### 1.1 先找现成项目

搜索到多个同类社区插件，结论是**没有可直接复用的**，但它们的 README 印证了本方案的几个关键判断：

| 项目 | 做法 | 判断 |
|---|---|---|
| [dsh-sess](https://github.com/youridol/dsh-sess) | 只允许删"冷"会话；菜单项用 **DOM/React fiber 注入** | 依赖 DOM 结构，宿主改版即失效 |
| [dsh-session-cleaner](https://github.com/haoranwang0921/dsh-session-cleaner) | 自建 `/api/session-cleaner` 路由 + 设置页 | 入口不在行菜单 |
| [dsh-session-delete](https://www.npmjs.com/package/@hualiong/dsh-session-delete)、[@pepsi-ai/…](https://www.npmjs.com/package/@pepsi-ai/dsh-plugin-session-delete)、[@heeweelee/…](https://www.npmjs.com/package/@heeweelee/dsh-session-plugin)、[dsh-forget-session](https://github.com/2026heshao/dsh-forget-session) | 行菜单加删除项 + 确认弹窗 | 思路一致，但各自绑定其开发时的版本 |

`dsh 0.2.2-rc.1` 已经提供了本需求的**全部官方扩展点**，因此不引入第三方代码，自写一个零运行时依赖的插件。

### 1.2 官方扩展点（全部经 `cordis_inspect_query` / 安装包源码核实）

| 需要 | 机制 |
|---|---|
| 菜单项 | 槽位 `sidebar.workspaces.session.menu.item`（`list`，按 `order` 升序，**渲染在内置 Archive 之前**） |
| 菜单项拿会话 | owner props `{ sessionId, displayTitle }` |
| 关菜单 | `useMenuOpenState()` → `[open, setOpen]` |
| 定位磁盘文件 | `ctx.sessionPersistence.stat(id).location.path`（**不自己拼 `<root>/<cwd>/<id>`**） |
| 清投影缓存 | `ctx.storageDomain.get('session_projcache').table('sessions').delete(id)` |
| 清工作区记账 | `workspaceRegistry.unarchiveSession/unpinSession` + 每个 workspace 的 `detachSession(id)` |
| 刷新会话列表 | `ctx.emit('api-session/removed', id)`；客户端 `ClientSessions.handleSessionRemoved` 已订阅 |
| 浏览器 → 宿主 | `ctx.connection.fetch.register({ path, methods, requestBody, fetch })`（静态包唯一可用的桥） |

## 2. 关键设计

### 2.1 为什么菜单项排在"最下面"

槽位文档写明：外部条目按 `order` 升序**渲染在内置 Archive 之前**——内置项由 `ctx.contextMenus` 渲染，槽位排序改不了它们。因此本项用 `order: 1000`（大于内置 pin=100 / rename=200 / fork=300 / id=450 / archive=600），效果是排在 Archive 之后，即用户看到的"最下面"。

### 2.2 为什么确认放在菜单里

菜单项只在菜单打开时渲染，关闭即卸载；而当前 DSH 没有静态包可调用的对话框服务（`client` 侧 `Service.listService` 里没有 dialog/modal/confirm）。所以确认做成**菜单内两段式**：第一次点击变成「再次点击确认删除」，4 秒内不点自动还原；取消 = 不点或关闭菜单。

成功后先在仍打开的菜单里显示「会话已删除」，900ms 后再关菜单——否则结果会被关闭动作吞掉，用户看不到任何反馈。

### 2.3 为什么先删缓存、再删目录

删除目录是不可逆点。缓存是派生数据（`session_projcache` 文档里写得很清楚：记录过旧只意味着重新 fold 代价更高，从不会错），先删它不会造成任何损失；反过来若先删日志、再删缓存时失败，会留下一条指向不存在会话的缓存行。两者都删完再发事件，避免列表刷新与删除竞争。

### 2.4 为什么运行中的会话要先 cancel

日志目录被删除后，仍在跑的回合会继续 append 到一个不存在的目录。因此：`agents.get(id)?.status === 'running'` 时先 `sessionController.cancel()`，再在 `stopTimeoutMs`（默认 8s）内等它停下；停不下来就拒绝删除（`agent-stuck`），**一个文件都不动**。`allowDeleteRunning: false` 时直接 `agent-busy` 拒绝。

## 3. 安全边界

- id 必须是单段：`^[A-Za-z0-9][A-Za-z0-9._-]*$`，且不含 `..`。`../x`、`a/b`、空串、超长串全部在**任何 I/O 之前**拒绝。
- 日志目录的 `basename` 必须等于 id，否则 `denied-path`。
- `realpath` 之后必须严格位于 `<DSH_HOME>/sessions` 之下（符号链接也解析后比较）。
- 只接受同源认证 POST（由 `connection.fetch` 载体先做 Host/Origin 围栏和 owner-Peer 校验），请求体上限 4 KiB。
- **不删附件**：`attachments/` 是内容寻址、跨会话共享的。

## 4. 踩坑记录

### 4.1 路由路径必须带 `/api` 前缀 —— 否则静默 404

最初 `DELETE_ROUTE = "/dsh-session-delete/delete"`。`connection.fetch.register` 用 `endpointFromPath("/api", path)` 校验，只接受 `/api/<段>/<段>`，因此注册直接抛 `connection: invalid exact Fetch route`。

**守护**：`test/route.test.mjs` 断言路径形状；`DELETE_ROUTE` 现在带上 `/api`。浏览器侧用相对路径 `api/dsh-session-delete/delete`，随页面挂载点走。

### 4.2 注册失败被 try/catch 吞掉 —— "加载了但全 404"

§4.1 的错误最初被 `apply` 里的 `try { … } catch { logger.warn }` 吃掉。结果：插件激活成功、`check` 全绿、每个删除请求都 404 且日志里毫无痕迹（web 宿主不往 stdout 写日志）。

**教训**：插件**唯一职责**的注册失败必须抛出（激活失败是可见的），不能降级成 warn。
**排查手段**：写一个 `--patch` 探针插件，在 `ctx.inject(['connection'], …)` 里打印 `register` 的结果，才看到真实异常。

### 4.3 inject child 上下文读 service 全是 `undefined` —— 每次删除都 session-not-found

路由挂上之后，每次删除都回 `session-not-found`，可 `session/list` 明明能看到该会话。探针在真实宿主里打印：

```
PROBE2 sessionPersistence=undefined   sessions.get=undefined   agent status=none
```

原因：`ctx.inject(['connection'], child => …)` 的 **child 上下文只对自己的依赖提供属性访问**。`child.sessionPersistence` 是 `undefined`（不抛 `without inject`，就是 undefined），而 `child.get('sessionPersistence')` 正常。

**修复**：`optional(ctx, key)` 优先 `ctx.get(name)`，属性访问只作回退。
**守护**：`test/delete-session.test.mjs` 的 "optional() prefers ctx.get, which a nested inject child needs"，用一个只能通过 `get` 取到服务的 fake 上下文复现。

### 4.4 `check` 绿 ≠ 路由可用

`scripts/dev.sh check` 用 headless 宿主，只证明"插件激活、工具注册"。本插件的 HTTP 路由在 headless 下根本不挂载（没有 `connection`），**必须**用 `dsh web` 真机验证。最终验证流程见本文件 §5。

### 4.5 夹具要复刻真实的"服务不可见"约束

早期几个测试用"返回 undefined 的假 ctx"，让 `optional()` 的 bug 蒙混过关。现在假 ctx 用 `Proxy`：未注入的服务**抛错**（复现 `without inject`），inject child 复现"属性不可见但 `get` 可见"。

## 5. 验证记录（2026-11-18）

1. **单测**：`pnpm test` → 57 用例全绿（targets / 编排 / 路由 / client 半 / manifest / i18n）。
2. **隔离 headless**：`pnpm run check` → `PASS: dsh-session-delete activates in a real isolated host`。
3. **隔离 `dsh web` 端到端**（新起 `--port 0`，绝不占 3080）：
   - token 换 cookie → `session/create` → `session/prompt`，日志落盘；
   - `POST /api/dsh-session-delete/delete` → `{"ok":true,…,"removed":1,"warnings":[]}`；
   - 断言：`sessions/<project>/<id>/` 整个目录消失、`session_projcache` 记录消失、`session/list` 返回空；
   - 未认证请求 → 401；`../etc` → 400 `invalid-id`；不存在 → 404 `session-not-found`；
   - 运行中的会话（默认 `stopRunning`）删除同样成功。
4. **清理**：`dev.sh clean` 删除 `.dev/` 与探针文件，未触碰 `~/.dsh`。

## 6. 未做/后续

- 不级联删除子代理会话（每个会话按行独立删除）。
- 不做设置页：唯一配置项是超时与两个开关，`cordis.patch.yml` 覆盖即可。
- 若宿主未来提供静态包可用的确认对话框服务，应把两段式确认换成原生弹窗。