# AGENTS.md — dsh-session-delete

本文件只写**本项目独有**的内容。通用规则（pnpm-only、隔离自测、DSH 插件坑位）见上级 [`../AGENTS.md`](../AGENTS.md)，不要在此重复。

## 1. 这个插件做什么

在侧栏工作区的会话行「…／右键」菜单**最下面**加一项「删除会话」，二次点击确认后：

1. 若该会话有运行中的回合，先 `sessionController.cancel()` 并等待其停下；
2. 删除会话日志目录（`<DSH_HOME>/sessions/<project>/<id>/`，含全部格式代与 `session.lock`）；
3. 删除投影缓存记录（`session_projcache` 域行 + 文档 + 备份）；
4. 清掉工作区记账、归档集合、置顶集合；
5. 发 `api-session/removed`，所有已连接浏览器立即移除该行（**这就是"刷新会话列表"**）。

```
index.mjs              Host 薄入口：resolveConfig + HTTP 路由挂载（ctx.inject(['connection'])）
client.js              Client 半：__ModuleLoader__ 懒工厂，注册会话菜单项 + 两段式确认
src/delete-session.mjs 删除编排（唯一实现删除链路的地方）；含 optional(ctx,key) 服务读取器
src/targets.mjs        路径推导与安全守卫（纯函数 + 一次 realpath）
src/errors.mjs         稳定错误码 DeleteFailure
src/i18n.mjs           Host 侧中英文案（日志与路由响应）
scripts/dev.sh         薄壳：转给仓库根 ../scripts/dev.sh
pnpm-lock.yaml         CI 必需（setup-node 的 pnpm 缓存与 --frozen-lockfile 都依赖它）
docs/DEVELOPMENT-LOG.md 设计决策与踩坑（改设计前先读）
locale/{zh,en}.json    Plugin Manager 展示元数据
icon.svg               原创图标
test/                  node --test（55+ 用例）
```

依赖方向单向：`index → {delete-session, errors, i18n}`，`delete-session → {errors, targets}`。

## 2. 命令

```bash
pnpm test                 # 离线单测（无网络、无真实宿主）
pnpm run check            # 隔离 DSH_HOME 起 headless 宿主，断言插件激活
pnpm run check:installed  # 追加校验安装副本文件集（不得含 test/、.dev/）
pnpm run dev:boot         # 隔离 dsh web（OS 分配端口、不打开浏览器）
pnpm run dev:dump         # 打印组合后的 profile 树中本项目那一行
pnpm run clean            # 停掉隔离进程并删除 .dev/
```

**本插件不注册原生工具**，所以 `package.json` 里没有 `dsh.tools`，`check` 只断言激活。

> `check` 末尾那行 "package RPC bridge present (settings page should mount…)" 是共享脚本对**任何** `dsh.client` 插件的通用提示，**不适用于本项目**：本插件没有设置页，客户端用的是 HTTP 路由（见 §3 第 3、9 条）。同理 `check` 全绿只证明插件激活，**不证明路由可用**——路由必须在 `dsh web` 下真机验证。

## 3. 本项目专属红线

1. **`inject` 必须保持 `[]`（空数组）**，所有服务经 `optional(ctx, key)` 读取。把 `sessions`、`sessionPersistence`、`connection` 之类写进 `inject` 会让缺该服务的宿主**激活失败**，headless 宿主首当其冲。
2. **`optional()` 必须优先走 `ctx.get(name)`**。`ctx.inject([...], child => …)` 的 child 上下文**只**对自己的依赖提供属性访问：在路由回调里读 `child.sessionPersistence` 是 `undefined`，而 `child.get('sessionPersistence')` 正常。这条踩过一次坑——见 §4。
3. **DELETE 路由路径必须是 `/api/<段>/<段>`**。`connection.fetch.register` 用 `endpointFromPath("/api", path)` 校验，只接受带 `/api` 前缀的形式；写成 `/dsh-session-delete/delete` 会被拒绝（`invalid exact Fetch route`），路由静默消失。
4. **路由注册失败必须抛，不许 catch 掉**。早期版本 try/catch 吞掉注册异常，结果是"插件看起来加载了，但每次删除都 404"。
5. **删除顺序不可调换**：定位与守卫（只读）→ 停回合 → 删缓存 → 删日志目录（不可逆点）→ 清记账 → 发事件。拒绝点必须在删文件之前，保证"拒绝 = 磁盘原样"。
6. **路径守卫不能放宽**：id 必须是单段 `[A-Za-z0-9][A-Za-z0-9._-]*`，日志目录的 `basename` 必须等于 id，`realpath` 后必须严格位于 `<DSH_HOME>/sessions` 之下。三者缺一不得删除。
7. **删除目录之后的所有步骤都只能是 warning**：日志没了会话就不存在了，残留的 pin/归档/列表行不能把成功说成失败。
8. **不删 `attachments/`**：内容寻址的附件在会话间共享，删了会损坏别的会话。
9. **`client.js` 不许 `require("host")`**：静态 `dsh.client` 包只有 `react` / `@deepseek-ai/cordis` / slots 等种子模块，没有 `host` 也没有 package RPC，浏览器只能同源 `fetch` 到宿主路由。同理不许 `document.body.append`、`querySelector`、`MutationObserver`。

## 4. 已知坑（已写进测试守护）

| 现象 | 原因 | 守护 |
|---|---|---|
| 每次删除都 404 | 路由路径缺 `/api` 前缀，注册被拒 | `test/route.test.mjs` 的路径形状断言 |
| 路由挂了但还是 404 | 注册异常被 try/catch 吞掉 | `apply` 现在不 catch，失败即激活失败 |
| 每次删除都 `session-not-found`，但 `session/list` 能看到该会话 | 在 inject child 上读 service 得到 `undefined` | `optional()` 优先 `ctx.get`；`test/delete-session.test.mjs` 的 "prefers ctx.get" 用例 |
| 删了会话重启后它又出现 | 只删了日志没删 `session_projcache` | 编排里先删域行再删文档，测试断言两者都消失 |

隔离真机验证的完整流程（超出 `check` 的部分）：起 `dsh web --no-open --port 0` → 用 token 换 cookie → `session/create` + `session/prompt` 让日志落盘 → `POST /api/dsh-session-delete/delete` → 断言目录、缓存、`session/list` 全部消失。**自测期间绝不对 `~/.dsh` 的真实会话执行删除。**

## 5. 发布

`.github/workflows/release.yml` 发现所有声明了 `dsh.bundle` 的目录，逐个 `pnpm install --frozen-lockfile` → `pnpm test` → `pnpm pack` → 挂到 `v<version>` Release。

- **改了 `devDependencies` 必须重新提交 `pnpm-lock.yaml`**（`pnpm install` 后提交），否则 CI 的 `--frozen-lockfile` 会失败。
- 发新版本：改 `package.json` 的 `version`，重跑 workflow；同一版本重跑是幂等的（只替换 asset）。
- 本地 `pnpm run pack:tarball` 产物在 `.dist/`，已被 `.gitignore` 忽略。

## 6. 改动后同步

- 配置键、错误码或对外行为变化 → 同步 `README.md`、`cordis.patch.yml` 注释、`docs/DEVELOPMENT-LOG.md`。
- 新增运行时文件 → 同步 `package.json` 的 `files` 与 `test/manifest.test.mjs`（测试守护运行期文件存在）。
- 新增错误码 → 同步 `src/errors.mjs` 的 `DELETE_ERROR_CODES`、`src/i18n.mjs` 两份字典、`client.js` 两份字典（`test/client.test.mjs` 会断言每个码都有中英文案）。