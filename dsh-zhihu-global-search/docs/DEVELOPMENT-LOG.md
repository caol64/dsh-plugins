# 开发记录 — dsh-zhihu-global-search

## 1. 背景与目标

知乎开放平台提供"全网搜索"接口（`global_search`），也有官方文档站
<https://developer.zhihu.com/docs?key=global_search>。目标是把这条能力做成 DSH 原生工具，
让模型在"搜全网 / 看看知乎上怎么说"时直接调用，而不是靠抓网页。第二个需求来自用户：
**设置页要有 API Key 输入表单，并按 DSH 插件的安全准则存储密钥。**

约束：

- 官方文档站是 SPA（`curl` 只拿到空壳 `#root`），**拿不到权威字段说明**；
- 本机没有可用的知乎密钥，因此真实接口调用只能靠二手资料 + 宽松解析 + 离线替身测试；
- 插件必须零运行时依赖，且不能把密钥写进任何配置文件。

## 2. 模块职责（每个文件只有一个理由存在）

| 文件 | 唯一职责 |
|---|---|
| `index.mjs` | Host 入口：配置校验、每次调用实时解析密钥、注册工具、挂载设置 RPC |
| `client.js` | Client 半：设置页组件 + locale 字典 + 样式 |
| `src/endpoint.mjs` | 把模型参数变成合法的上游请求（**请求侧全部线缆命名集中于此**） |
| `src/respond.mjs` | 把上游响应变成不丢数据的条目列表（**响应侧全部命名集中于此**） |
| `src/errors.mjs` | 失败分类、可行动文案、可重试判定、脱敏 |
| `src/result.mjs` | 输出值组装、Markdown 渲染、引用来源投影 |
| `src/credentials.mjs` | 引用名校验、拒绝字面量键、credentials → 环境变量回退 |
| `src/settings.mjs` | 设置页的 Host 操作，保证返回值永不含密钥 |
| `src/search.mjs` | 一次搜索的编排：重试预算、超时、取消 |
| `src/tool.mjs` | 模型可见的契约：描述、参数、输出 schema、展示投影 |

## 3. 关键设计决策

### 3.1 密钥：引用而非值，浏览器永不读

DSH 的凭据域有两个半边：`ctx.credentials`（Host 服务）与 `ctx.credentialsController`
（暴露为 `ctx.remote.credentials`）。后者的方法集是 `describe(refs)`、`set(ref, value)`、
`unset(ref)` —— **没有任何读值的路径**，`describe` 只返回 `{ configured, source, writable }`。

最初设想让 `client.js` 直接调用 `ctx.remote.credentials.set(ref, value)`。放弃的原因是：
那需要浏览器持有引用名。引用是全局命名空间（`ZHIHU_ACCESS_SECRET`），任何面板都能拼出
别的插件的引用并覆盖它；而插件自己知道"我该写哪个引用"这件事根本不需要经手浏览器。

最终契约（`src/settings.mjs` + `index.mjs` 的 `mountSettingsRpc`）：

```
浏览器 ──host.call("settings")──────────▶ { ref, configured, source, writable, store }
       ──host.call("save", value)───────▶ 校验后 ctx.credentialsController.set(ref, value)
       ──host.call("clear")────────────▶ ctx.credentialsController.unset(ref)
```

`ref` 由 Host 从配置 `accessSecretEnv` 取出并**预绑定**：`settings`/`clear` 无参，`save`
只收裸字符串。浏览器因此无法寻址其他凭据，也永远拿不到值。

### 3.2 配置里出现字面量密钥 = 激活期失败

`resolveConfig` 对未知键的分类是"像不像密钥"：`accessSecret`、`apiKey`、`token`、
`password` 这类键会抛出带指引的错误（"打开设置页，或设置 `accessSecretEnv` 指定的环境变量"），
而不是被忽略或降级为警告。用户的 patch 文件经常被同步、被分享——让写入失败是最便宜的防线。

### 3.3 响应解析必须宽松，且不能丢数据

官方文档站只给出端点、鉴权、四个查询参数和 `Code/Message/Data` 外壳，**没有给出 `Data`
内部的字段名**。因此 `respond.mjs`：

1. 只从外壳读 `Code`/`Message`（大小写都接受）；
2. 条目容器按 `Items/items/List/list/Results/results/Data/data` 依次探测，退化为顶层数组；
3. 每个条目保留完整的 `raw`，再从候选键名表投影标题/链接/摘要/作者/时间；
4. **结构完全不认识时**，把整个 `Data` 作为一条 `raw` 保留，并给一条解释性 warning。

渲染时把"已投影字段"与 `raw` 中其余标量取并集，所以无论上游用 `Title` 还是
`question_title`，模型都能看到全部内容。

### 3.4 重试预算 = 1，且按失败类型区分

按次计费的接口，乱重试就是乱花钱。`errors.mjs` 把失败分成九类，只有 `timeout`、
`network`、`upstream` 可重试一次；`auth`、`quota`、`risk`、`argument` 绝不重试。
`30003`（风控）与 `30001/30002`（额度）的文案都明确写了"不要立即重复调用"。

### 3.5 设置页落在 `settings.section`，而不是插件管理页

`settings.section` 是宿主公开声明的设置页列表（`id`/`order`/`label`），注册一个新 id 就
会出现在侧栏设置里；插件管理页的 `plugins.item` 需要复刻它自己的配置表单模型（form 对象、
`plugins.row.config` 的 `entryKey`），耦合面大得多。需求只要求"插件配置页有 API Key 表单"，
`settings.section` 就是最弱且足够强的机制。

### 3.6 RPC 桥按形状发现，不作为必需服务

包 RPC 桥（浏览器 `require("host").call` 的对端）是宿主基础设施，不在本插件的 `inject`
里。`mountSettingsRpc` 依次尝试 `remote`/`rpc`/`hostRpc`/`packageRpc` 上下文键，只认
`method(name, fn)` 与 `register(table)` 两种形状；都没有时记一条 info 并继续——**搜索功能
不受影响**，只是设置页不可用。隔离宿主实测确有桥（`INFO: package RPC bridge present`），
说明该路径在当前版本是活的（注意：试图用 curl 直接命中 RPC 端点来做端到端验证**未成功**——
`/api/rpc` 之类路径在浏览器会话 Cookie 下是 404，说明包 RPC 不在普通 HTTP 路由上；这条验证线索
留给有浏览器控制的环境）。

### 3.7 Client 半的落地证据（在交付前实际抓取的）

设置页究竟有没有被 Web 宿主接纳，不靠猜。隔离 `dsh web`（`--port 0 --no-open`）启动后，
用根页面里的 bootstrap token 换到浏览器会话 Cookie，`/` 返回的 `__DSH_BOOT__` 里确实出现了本插件：

```
{"id":"dsh-zhihu-global-search","url":"plugins/??dsh-zhihu-global-search/client.js&rev=b90f3186c7e8","rev":"b90f3186c7e8","immediately":true}
```

随后 `GET /plugins/??dsh-zhihu-global-search/client.js&rev=…` 返回 200 与完整源码——说明
`dsh.client` 扫描、模块 URL 生成与静态分发这条链路是通的。**仍不能**借此证明设置页渲染正确：
浏览器内的 React 渲染、样式与交互没有在本环境验证。

## 4. 踩坑记录（真实发生，逐条含根因与回归手段）

### 4.1 `output.schema` 是 value DSL，不是 JSON Schema：根级 `required` 直接把插件打挂

**现象**：`pnpm run check` 报
`zhihu-global-search (dsh-zhihu-global-search): JsonSchemaError: unsupported JSON schema: schema.required is not supported by the value schema DSL`，
`DEVPROBE ... present=false`。

**根因**：`defineTool` 的 `output.schema` 走 `valueSchemaSpecToJsonSchema`，是**作者 DSL**：
每个节点只允许 `type`、注解（`description`/`title`/`default`/`examples`）、以及对象节点的
`properties`/`additionalProperties`；`required` 只能作为**属性上的 `required: true` 标记**
（编译时被提升到父对象），根级 `required: []` 数组是非法键。参数侧 `parameters` 同理（AGENTS.md
早就写过），但"输出 schema 是 JSON Schema 子集"这句话很容易让人误以为根级 `required` 合法。

**修复**：改成属性级 `required: true`；`raw` 用 DSL 的 `{ type: "json" }` 节点。

**回归**：`test/tool.test.mjs` 的"the output schema uses the tools value DSL"用例守护
"根级不得出现 `required` 数组、属性级 `required` 必须为 `true`"。**注意**：单测用假的
`defineTool`（恒等函数）是发现不了这个问题的，只有隔离宿主真实启动才能暴露——这正是
"三层验证不能互相替代"的实例。

### 4.2 把可选服务写进 `inject` 会让插件静默停在 pending

**现象**（故障注入复现）：把 `inject` 改成 `["tools", "credentials"]` 后，宿主只打印
`1 entry did not activate` / `pending (waiting for service: credentials)`，工具不注册，
`check` 失败。真实 profile 里 `credentials` 通常存在，但精简 profile 或加载顺序变化时
就会踩到。

**回归**：`test/plugin.test.mjs` 用 `Proxy` 复现"未 inject 即抛"，并有一条"只有 tools 的
上下文下 apply 不 reject"的用例；`dev.sh check` 在真实宿主上再验一次。

### 4.3 空容器 vs 未知结构：`Items: []` 不能被当成"结构不认识"

**现象**：插件级测试期望空结果 `items: []`，实际得到 `items: [{ raw: { Items: [] } }]`。

**根因**：最初 `decodeResponse` 用 `locateItems(...) ?? []`，丢失了"找到了但为空"与"没找到"
的区别；`buildOutput` 只看 `items.length === 0`，于是把空容器也当成了未知结构。

**修复**：`decodeResponse` 不再兜底 `[]`（`items` 可以缺省），`buildOutput` 用
`itemsLocated` 区分三种情况：有列表但为空 → 真空结果；无列表但有 `Data` → 保留 `raw` 并警告；
两者都无 → 空结果。

**回归**：`test/search.test.mjs` 的"unrecognized Data shape"与插件级"空容器是真空结果"两条用例。

### 4.4 时间戳断言写错：反例说明"预期值必须算过"

`publish_time: 1778494631` 的 ISO 不是笔算出来的 `2026-05-06T11:37:11Z`，而是
`2026-05-11T10:17:11.000Z`。测试失败后改用 `node -e` 计算再回填。教训：涉及换算的断言
不要凭直觉写期望值。

### 4.5 `--dump-config` 的行提取把整棵树的插件行都打出来了

**现象**：`pnpm run dev:dump` 输出了几十个内置插件行。

**根因**：dumper 为每个 patch 层打印一行 `# == <层名>`，而本插件的行**不是紧跟在**自己那层
banner 之后——基座层和 web 层里也有名字匹配不到的 banner。原脚本用的是"当前 banner 匹配则保留"，
导致只要有一次不匹配，后面所有行（直到下一个 banner）都被打印。

**修复**：先改为"只保留紧跟在匹配 banner 之后的第一个 `- id:` 行块"；收敛到共享脚本后进一步改为
**按行的 `name:` 值匹配**（banner 只是注释层信息，行本身才是事实），不再依赖 banner。

**后续（见 4.9）**：该修复连同脚本一起收敛到仓库根 `scripts/dev.sh`。

### 4.6 `check:installed` 因 `.gitignore` 判失败

安装副本（`files` 白名单）不含 `.gitignore`，而 `diff -r` 不排除它。排除清单里补上
`.gitignore`（与 `pnpm-lock.yaml`、`AGENTS.md` 同类）。

### 4.7 locale 变量遮蔽：`const [locale, …]` 覆盖了 `require("locale")`

设置页里既需要 `activeLocaleId` 做状态，又需要 locale 服务。最初写作
`const [locale, setLocale] = useState(...)`，但外层已经 `const locale = require("locale")`，
块级遮蔽让 `ctx.effect`（`apply` 作用域）里的 `locale.register` 指向了**状态值字符串**。
改正为 `localeId`/`setLocaleId`，并给 `apply`/`label` 里的读取补了 `?? "zh-CN"` 兜底。

### 4.8 自测自身的两处假象（留给后来者）

- `pnpm run check` 的探针只有在真实宿主跑一次模型步时才会打印；`web` 应用不跑模型步，
  所以只能验证注册，不能验证渲染。
- 故障注入必须做：把 `TOOL` 故意写错时 `check` 必须以退出码 1 失败（已实测），否则"通过"
  毫无意义。

### 4.9 自测脚本已收敛到仓库根：`dsh.tools` 成为契约的一部分

本插件最初带一份完整的 `scripts/dev.sh`，与 omni 的副本出现漂移（dump 行提取在两边行为不同）。
现在实现只有一份：仓库根 [`scripts/dev.sh`](../../scripts/dev.sh)，本目录的 `scripts/dev.sh` 是转参薄壳。
共享脚本从 `package.json` 读三件事：`name`、`dsh.tools`（`check` 断言这些工具在真实宿主里已注册）、
`dsh.client`（是否汇报包 RPC 桥）。因此：

- **工具改名时必须同步 `dsh.tools`**，否则 `check` 会对旧名字断言并非 0 退出（这是有意的：断言名必须
  来自声明，而不是脚本里再写一遍）；
- 沙箱从 `dsh-zhihu-global-search/.dev/` 移到仓库根 `.dev/`，`check:installed` 不再需要排除插件内 sandbox；
- 故障注入要在两个入口都验：`pnpm run check` 与 `bash scripts/dev.sh check`。`pnpm run` 会把脚本名追加进
  `$@`，薄壳必须先丢掉它，否则动作参数会被吞掉。

三个假阳性细节（`pnpm` 追加脚本名、探针两条分支共用一个子串匹配、`TOOL`/`TOOLS` 双变量）记在
[omni 的 4.9](../../dsh-omni-article-markdown/docs/DEVELOPMENT-LOG.md)。

## 5. 验证方法（可直接复用）

1. `pnpm test`：89 个离线用例，`fetch`/`AbortSignal.timeout` 全用替身。
2. `pnpm run check`：隔离 `DSH_HOME`（`.dev/home`）启动 `headless`，探针在 `agent/pre-step`
   读 `ctx.tools.definitions()`，断言 `zhihu_global_search` 在场；同时报告 RPC 桥是否存在。
3. `pnpm run check:installed`：安装副本与源码一致、且不含 `test/`、`.dev/`。
4. 故障注入：`TOOL` 改名 → 必须失败；`inject` 加 `credentials` → 必须失败（两处都已实测并还原）。
5. `pnpm run clean` 清理。

**未覆盖**：设置页的浏览器渲染、真实知乎接口调用（没有密钥）。这两项由用户在重启宿主后确认。

## 6. 已知限制

- 上游字段名可能与本实现的候选表不完全一致；真机差异只需改 `src/endpoint.mjs`（请求）与
  `src/respond.mjs`（响应）两处，工具契约不变。
- 不做分页（`has_more` 无游标时不发明参数）、不做本地额度计数、不做站内搜索/热榜/直答。
- 设置页的样式 token 用了 `--dsw-alias-text-*`、`--dsw-alias-surface-*`、`--dsw-alias-border-*`、
  `--dsw-alias-accent-primary` 等命名并带字面回退；若某个 token 在本版本不存在，外观退化但
  不会破坏渲染。

## 7. 交付

```bash
rm -rf ~/.dsh/profiles/web/node_modules/dsh-zhihu-global-search
dsh plugin --profile web add "$HOME/work/projects/dsh-plugins/dsh-zhihu-global-search"
# 重启宿主后在 设置 → 知乎全网搜索 填写 Access Secret
```
