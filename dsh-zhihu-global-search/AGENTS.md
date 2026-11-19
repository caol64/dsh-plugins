# AGENTS.md — dsh-zhihu-global-search

本文件只写**本项目独有**的内容。通用规则（pnpm-only、隔离自测、DSH 插件坑位）见上级 [`../AGENTS.md`](../AGENTS.md)，不要在此重复。

## 1. 这个插件做什么

把知乎开放平台的**全网搜索** `GET /api/v1/content/global_search` 封装成 DSH 原生工具 **`zhihu_global_search`**，并提供 **设置 → 知乎全网搜索** 一页，让用户填写 / 替换 / 移除 Access Secret。

```
index.mjs              Host 薄入口：resolveConfig + 每次调用实时解析密钥的闭包 + tools.register + 设置路由挂载
client.js              Client 半：window.__ModuleLoader__ 懒工厂，注册 settings.section 设置页
src/tool.mjs           工具描述、value DSL 的参数与输出 schema、展示投影
src/search.mjs         一次搜索的完整生命周期（重试预算、取消、超时都在这里）
src/endpoint.mjs       请求整形：query 校验、count 钳制、search_db 枚举、URL 组装（**全部线缆命名集中在此**）
src/respond.mjs        响应解码：Code/Message、条目容器探测、候选键名投影（**响应命名集中在此**）
src/errors.mjs         失败 → { kind, text, retryable }，文案可行动、可重试判定
src/result.mjs         输出值组装 / Markdown 渲染 / 引用来源投影
src/credentials.mjs    密钥解析：拒绝字面量键、插件存储 → 环境变量回退
src/secret-store.mjs   插件自有存储：<DSH_HOME>/storages/dsh-zhihu-global-search/（0700/0600、原子写、损坏即报错）
src/settings.mjs       设置页的三个 Host 操作（settings / save / clear），返回值永不含密钥
src/settings-route.mjs 设置页唯一的 Host 路由（/api/dsh-zhihu-global-search/settings）：解析、状态码、错误码
scripts/dev.sh         薄壳：把参数转给仓库根的共享自测脚本 ../scripts/dev.sh
docs/DEVELOPMENT-LOG.md  设计决策与踩坑（改设计前先读）
locale/{zh,en}.json    Plugin Manager 展示元数据
icon.svg               原创图标（不复用知乎商标）
```

依赖方向单向：`index → {search, settings, tool, credentials, endpoint}`，`search → {credentials, endpoint, errors, respond, result}`。

## 2. 命令

```bash
pnpm test                    # 离线单测（DSH_HOME 固定为临时目录；fetch 替身 + 真实 React 渲染 + 种子表）
pnpm run check               # 隔离 DSH_HOME 启动 headless 宿主，断言 zhihu_global_search 已注册
pnpm run check:installed     # 追加校验安装副本文件集（不得含 test/、.dev/）
pnpm run dev:boot            # 隔离 dsh web（OS 分配端口、不打开浏览器），人工看设置页
pnpm run dev:dump            # 打印组合后的 profile 树中本项目那一行
pnpm run clean               # 停掉隔离进程并删除 .dev/
```

自测实现全部在仓库根的 `../scripts/dev.sh`，本目录的 `scripts/dev.sh` 只是薄壳。`check` 断言的工具名来自 `package.json` 的 `dsh.tools`——**改名 `zhihu_global_search` 时必须同步这个声明**。

交付到用户 profile 用 `dsh plugin --profile web add <本地目录>`（跨工作区写入，需用户授权），并先 `rm -rf ~/.dsh/profiles/web/node_modules/dsh-zhihu-global-search`（pnpm 按版本号缓存 `file:` 拷贝）。

## 3. 本项目专属红线

1. **Host 的 `inject` 只能有 `tools`**（Client 半的 `inject` 是 `["slots", "locale"]`）。`credentials`、`credentialsController`、`i18n`、`effect` 一律走 `optional(ctx, key)` 守卫；`connection` 用 `ctx.inject(["connection"], …)` 等待，不进 `inject`。历史上把 `credentials` 写进 `inject` 会让插件停在 `pending (waiting for service: credentials)` 而静默不注册（已用故障注入复现）。
2. **密钥字面量永不进入**：配置、patch、日志、错误文案、工具输出、`presentationMeta`、设置页 state。`resolveConfig` 对形如 `*secret*` / `*token*` / `*apiKey*` 的键**在激活期抛错**，不要"放宽成警告"。
3. **密钥只存插件自有目录**：`<DSH_HOME>/storages/dsh-zhihu-global-search/secret.json`（目录 `0700`、文件 `0600`、原子写、损坏即报错），**绝不写 `~/.dsh/.credentials.yaml` 的 `refs`**，也不用官方 record（它落在同一文件里，见 4.14）。环境变量 `accessSecretEnv` 只作只读回退，存储值优先。设置操作**不依赖任何宿主服务**——可写性不由宿主服务的可见性决定（4.13）。输入框被禁用时页面必须显示原因与存储位置。
4. **浏览器永远不读密钥**：设置页只向 Host 的 exact Fetch 路由 `/api/dsh-zhihu-global-search/settings` 发 `POST {op: settings|save|clear}`，返回值只有 `{ ok, ref, configured, source, writable, store }`。**禁止**在 `client.js` 里直接调 `ctx.remote.credentials.*`——那需要浏览器知道引用名，等于允许面板寻址其他插件的凭据。
5. **路由契约固定**：`op` 只有 `settings` / `save` / `clear`，`save` 的载荷是 `value` 字符串；引用名由 Host 从 `accessSecretEnv` 预绑定，请求里带了 `ref` 也一律忽略。不要改成 `save(ref, value)` 形式。
6. **注册项必须返回元素树，渲染证明用真实 React**：注册写成 `(ownerProps) => renderPageSafely(ownerProps, ctx)`；
   **绝不能**写成 `() => (ownerProps) => …`——`Component()` 返回函数，React 会报
   `Functions are not valid as a React child` 并且**什么都不渲染**（这就是 4.12 的空白页）。
   locale 服务是 `getSnapshot()/subscribe()/register()`，**没有** `getLocale()`。
   渲染证明在 `test/client-render.test.mjs`（devDependency 的真实 `react` + `react-dom/server`）；
   `test/client.test.mjs` 的手写 hook 替身**只**证明加载与注册，不证明页面能显示。
7. **Client 半只能 `require` 平台种子**（当前 11 个：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`zod`、`@tanstack/react-virtual`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`）。`locale` 是**服务**（`ctx.locale`，写进 `inject: ["slots", "locale"]`），样式自己插入 `<style>`（宿主会打 `data-plugin` 标记并在卸载时移除），与 Host 通信只走 `fetch`。`require("host")` / `require("styles")` / `require("locale")` 会让整个 client 条目 import 失败、`web boot` 报错（`test/client.test.mjs` 与种子漂移守卫会拦住）。
8. **响应解析必须宽松**：知乎官方文档站是 JS 渲染的，`Data` 内字段名没有权威资料。新增字段只能加候选键名 / 容器名，**不得**把某一种命名当唯一真相，也不得在结构不认识时丢数据（必须把原始 `Data` 留在 `items[0].raw`）。
9. **重试预算固定为 1**：只有 `timeout` / `network` / `upstream` 可重试；`auth`、`quota`、`risk`、`argument` 绝不重试（不仅因为没用，还因为按次计费）。
10. **`index.mjs` 保持薄**：业务逻辑放 `src/`；入口抛异常会导致插件激活失败。
11. **不注册 skill**：工具声明本身承载能力与用法（与 omni 插件一致）。
12. **描述保持三句式，且必须显式声明与内置 `web_search` 的优先关系**：能干什么 / 何时用它（`Prefer it over web_search …` + 理由 + `fall back … only if it fails`）/ 怎么调（`count`、`filter`、`search_db`）。约 400 字符，**上限 500 字符、4 句**（见 4.15）。模型不会因为描述更长就选它，只会因为**写明偏好**；冗长反而稀释那句话。`test/tool.test.mjs` 有守护。

## 4. 领域约束

- 官方接口契约（截至实现时，来自二手资料互证）：`GET {baseURL}/api/v1/content/global_search`，`Authorization: Bearer <Access Secret>` + `X-Request-Timestamp`（秒级），参数 `Query`（必填）/`Count`（1–20，默认 10）/`Filter`/`SearchDB`（`all`/`realtime`/`static`），响应 `{Code, Message, Data}`；业务码 `10001/20001/30001/30002/30003/40004/40005/40006/50002/90001`。
- 全网搜索**按次计费**并有每日免费额度；工具描述里要求模型优先一次精准查询，额度相关失败一律不重试。
- `has_more` 没有配套游标时**不发明翻页参数**。
- 设置页文案走 locale：`client.js` 里 `localeCtx.register(NS, DICTS)` 注册字典，中文为默认。新增文案必须同时补 `zh-CN` 与 `en` 两份，否则测试里没有守护、英文用户会看到中文。

## 5. 改动后同步

- 配置键、错误码映射或对外行为变化 → 同时更新 `README.md`、`cordis.patch.yml` 注释、`docs/DEVELOPMENT-LOG.md`。
- 新增运行时文件 → 同步 `package.json` 的 `files` 与 `test/manifest.test.mjs` 的 `RUNTIME_FILES`（测试会守护）。
- 新的踩坑经验 → 追加到 `docs/DEVELOPMENT-LOG.md` 第 4 节，并补一条能复现它的用例。