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

**后续（见 4.10）**：这个 bug 追根到底是因为把 locale 当成了模块。现在 `locale` 是服务
（`ctx.locale`），状态变量叫 `localeId`，两者不可能再混淆；`test/client.test.mjs` 的"标签随 locale 变化"
用例守护它。

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

### 4.10 线上真实故障：`web boot` 报 `require("host") missed the module table`

**现象**（用户在真实浏览器里看到的原始日志，保持原样）：

```
Failed to load plugins
dsh-session-delete
dsh-zhihu-global-search
web boot: 2 entries did not activate
dsh-zhihu-global-search: import failed: client-modules: require("host") missed the module table
```

> 日志里的 `dsh-session-delete` 是同批加载、犯同类错误的另一个插件（其 `require("locale")`）。该插件
> 已废弃删除；此处保留原始日志作为事故记录。

**根因**：`dsh.client` 静态 bundle 的模块表**只有平台种子**。对 0.2.2-rc.5 逐包核实，宿主在
`window.__ModuleLoader__.create({ staticModules: … })` 里注入的表就是 11 个名字：

```
react, react/jsx-runtime, react-dom, react-dom/client, @deepseek-ai/cordis, zod,
@tanstack/react-virtual, @deepseek-ai/dsh-client-store,
@deepseek-ai/dsh-client-ui-slots, @deepseek-ai/dsh-client-ui-primitives, @deepseek-ai/dsh-client-ui-dockkit
```

`makeRequire` 的解析顺序是"种子 → 已物化模块 → 已注册的 package factory"，三者都没有就抛
`missed the module table`。本插件的 client 半用了三个**不存在**的名字：

| 写法 | 真实身份 | 正确做法 |
|---|---|---|
| `require("host")` | 只存在于**动态插件沙箱**（`cordis_run` 代码的闭包），静态 bundle 没有 | 走 Host 的 exact Fetch 路由（`POST /api/dsh-zhihu-global-search/settings`） |
| `require("locale")` | Client Cordis **服务** `ctx.locale` | `inject: ["slots", "locale"]`，然后用 `ctx.locale` |
| `require("styles")` | 不存在 | 自己 `document.createElement("style")` 插入；宿主会给它打 `data-plugin` 并在条目卸载/替换时移除 |

`dsh.client.external` **不能**补救：它只影响加载顺序与图边，不会凭空提供模块。

**为什么会写成这样，又为什么没被发现**：

1. 我原先的"package RPC 桥发现"（探测 `remote`/`rpc`/`hostRpc`/`packageRpc` 键）在宿主上**一个都不存在**，
   当时只记了一条 info 就继续；浏览器侧于是臆造了 `require("host")` 去配套——两个错误的猜测互相背书。
2. 上一轮记录里的"Client 半落地证据"只证明了 `__DSH_BOOT__` 里有本插件条目、静态文件能取到，
   **没有执行 factory**，而 import 失败发生在执行 factory 时。
3. 单测里 `require("host")` 从未被调用，`manifest.test.mjs` 甚至把 `require("host")`、`require("locale")`、
   `require("styles")` 写成了**必须存在**的断言——测试在保护错误。

**修复**：

- Host：`mountSettingsRoute()` 用 `ctx.inject(["connection"], …)` 注册
  `connection.fetch.register({ path: "/api/dsh-zhihu-global-search/settings", methods: ["POST"], requestBody: "buffered" })`，
  路由契约在 `src/settings-route.mjs`（`op: settings|save|clear`，引用名由 Host 预绑定）；
  路由被拒 **不吞异常**（宁可激活失败，也不要"看起来加载了、每个请求都 404"）。
- Client：只 `require("react")`；`ctx.locale` 服务；自插样式；`fetch` 调用上面的路由。

**守护**（三种，缺一仍会重演）：

1. `test/client.test.mjs`：把 `client.js` 放进**只会解析平台种子**的假模块表里真实执行 factory
   （未命中就抛与浏览器同文的错误），断言注册成功、标签随 locale 变化；
2. 同文件把 `require("host"|"locale"|"styles")` 逐个注入回去，断言 factory 以
   `missed the module table` 失败——故障注入是验证的一部分，不是补充；
3. `test/client.test.mjs` 的种子漂移守卫：从**已安装**的 `@deepseek-ai/dsh-web-frontend` 主包中解析
   `staticModules` 表，与 `test/client-seeds.mjs` 的常量逐项比对；宿主升级换表时测试直接变红。

**复盘：为什么会漏，以及以后怎么防**

- **把"能取到文件"当成"能跑起来"**。`__DSH_BOOT__` 有条目、`/plugins/??…/client.js` 返回 200，只证明分发链路通；
  必须**执行 factory** 才算验证。静态 bundle 的正确性 = 在真实模块表里跑通 factory。
- **两个猜测互相背书**。Host 端与 Client 端对同一套桥做了两次独立猜测，结果一致就被当成了证据。
  凡是没有在已安装包里找到实现的东西，不能写进代码，更不能两边各猜一次。
- **测试可以保护错误**。上一轮我把错误的 `require` 名字写成了必须存在的断言。写断言前先问
  "这条断言依据的是哪份实现"，没有依据的断言就是把 bug 焊死（已在 `manifest.test.mjs` 改成只允许平台种子）。
- **故障注入要打在不同层面**。上一轮只注入了 `dsh.tools` 名字；这次要注入的是"模块表里有什么"，
  所以必须有"只给平台种子"的假表。
- **共享现象要共享结论**。用户是同一次启动里发现两个插件出错的；拿到其中一份修复后，应当先比较
  "我们两边的 client 半是不是同一类错误"，而不是各自修。

**真机验证**：隔离 `dsh web`（`--port 0 --no-open`）启动后，`__DSH_BOOT__` 仍含本插件条目，
且用带浏览器会话的请求取 `plugins/??dsh-zhihu-global-search/client.js` 返回 200 与完整源码；
factory 在种子表里的执行由单测覆盖。**未覆盖**：浏览器内的 React 渲染与真实点击保存（需要用户重启后确认）。

### 4.11 设置页一片空白：组件渲染时抛 ReferenceError，注册却"成功"

**现象**：修好 `require("host")` 之后 `web boot` 不再报错，条目也注册了，但打开 **设置 → 知乎全网搜索**
只有一片空白。

**根因（两个，叠加在同一个组件上）**：

1. **`ZhihuSearchSettings` 在 factory 词法里，`apply()` 里是另一个 `ctx`**。组件引用的 `ctx` 在它的作用域里
   根本不存在 → 首帧渲染抛 `ReferenceError: ctx is not defined`。
2. **locale 服务的方法名是 `getSnapshot()`，不是 `getLocale()`**。该服务是 slot 系统的 `LocaleFace`
   （`getSnapshot`/`subscribe`/`register`），读一个不存在的方法会抛 `TypeError`。而宿主一侧的
   `settings.section` 壳子读取 `label()` 时也会走同一条错误路径。

两种情况都**不会让注册失败**：`ctx.slots.register()` 成功，只是组件一渲染就抛，壳子把该区渲染成空白。
这正是"注册成功 ≠ 页面能显示"的典型。

**为什么没被测到**：上一轮的 client 测试只验证"factory 能加载、注册了一个 slot"，从未**渲染**组件；
而 locale 替身被写成了 `{ getLocale() }`——替身照着错误代码的形状造，当然测不出错。

**修复**：

- 组件改为 `ZhihuSearchSettings(ownerProps, ctx)`，注册时用一个**不渲染 hooks 的包装**把 `apply` 的
  `ctx` 闭包进去：`() => (ownerProps) => ZhihuSearchSettings(ownerProps, ctx)`。
  - 注意包装本身**不能**调用 `React.createElement`：它也要走一遍 hooks 分派，会把页面组件的 hook 索引错位。
    第一版就踩了这个（`page` 组件拿到的 `state` 是 `undefined`）。
- locale 统一走 `localeService(ctx)` → `ctx.locale.getSnapshot()`，并用 `activeLocaleId()` 兜底 `zh-CN`。

**守护**：`test/client.test.mjs` 新增了一个**最小渲染器**（全局 hook 槽位，仿 React 的 dispatcher），
`bootClient` 现在会真正调用 `Component(ownerProps)`：

- "rendering the page produces the actual form, not an empty section"——断言渲染文本含标题、`Access Secret`、
  保存/移除按钮，且密码框为空、表单 onSubmit 是函数；
- "the page falls back to English …"——英文 locale 下渲染英文；
- locale 替身改为**真实形状** `realLocaleService()`（`getSnapshot`/`subscribe`/`register`，**没有** `getLocale`），
  再加一个 `strictService()` 代理：读不存在的成员就像真服务一样抛错。

**故障注入（都已实测）**：

- 把 `getLocale()` 调用与宽松的 `localeService` 放回去 → 2 条 locale 用例变红；
- 让组件在渲染时直接 `throw` → 7 条渲染/标签用例变红。

**复盘：为什么会"修好一处、坏在另一处"**

- **只验证"注册"是这类 UI bug 的通用盲区**。槽位系统对组件抛错是**静默吞掉**（控制台有
  `slot entry crashed`），页面上只表现为空白。凡是注册 React 组件，测试就必须**渲染一次并断言文本**。
- **替身照着我的错误代码写**，等于用错误证明错误。替身的形状要取自**已安装包的真实实现**
  （`dsh-client-locale` 的 README/types、`ui-settings-general` 的真实注册代码）。
- **"找不到的成员"在真实对象上会抛**。我的 `localeService` 用 `typeof service?.getSnapshot === "function"`
  做了能力探测，但调用处却用了另一个方法名——探测和调用必须指向同一个方法。
- **hook 顺序是很脆的东西**。任何在渲染路径上插入 `React.createElement` 的包装都会改变 hook 索引；
  包装只应做闭包，不应自己渲染。

**一个尚未闭环的点（诚实记录）**：隔离 web 宿主里 `POST /api/dsh-zhihu-global-search/settings` 能通
（200/400/401 都符合预期），但返回 `store:false`——该 profile 里 `credentialsController` 与
`credentials` 都没有挂到插件可见的作用域。已把控制器改为**每次操作时查找**（而不是激活时快照），
并在真实 profile 里确认 `settings-controller` 与 `credentials`（`@deepseek-ai/dsh-credentials-local`）
都在组合中；用户重启后若设置页显示"当前环境没有可用的凭据存储"，需要据实回报，而不是再猜一次。

### 4.12 空白页的真正根因：注册项返回了"组件函数"而不是元素

**现象**：4.11 的修复上线后，设置页**依然是空白**，而且连我新加的"页面渲染失败"提示都不出现。

**根因（用真实 React 复现后一句话说清）**：

```
Functions are not valid as a React child. This may happen if you return Component
instead of <Component /> from render.
```

注册时我写的是 **`() => (ownerProps) => renderPageSafely(ownerProps, ctx)`**——宿主把 `Component`
当组件渲染，`Component(ownerProps)` 的返回值被当作**子节点**；它返回的是**函数**，React 不会去调用它，
于是渲染出空内容。`renderPageSafely` 里的 try/catch 根本没机会执行，所以也不会有我设计的提示。

**为什么前面的"修复"都看不见效果**：

| 尝试 | 实际结果 |
|---|---|
| 组件内部 `ctx` → 闭包传入 | 是必要的修复，但组件根本没被执行 |
| locale `getLocale()` → `getSnapshot()` | 同上，没被执行 |
| 用函数包装捕获渲染异常 | 返回的是函数，React 不执行它 |
| 手写 hook 替身"渲染成功" | **替身比 React 宽松**：它遇到函数就调用，于是给出了假阳性 |

**这次是怎么定位的（方法本身值得记）**：

1. 先确认**注册是真的**：`cordis_inspect_query` 在你的真实宿主上看到
   `{ id: "zhihu-global-search", order: 25, active: true }`——排除"没注册"。
2. 再确认**分发的代码是对的**：从隔离 web 宿主取 `__DSH_BOOT__` 与 `plugins/??…client.js`，
   bundle 里 `renderPageSafely` 在、`getLocale` 只剩注释。
3. 最后**用真实 React 渲染这份分发出去的 bundle**：装 `react` + `react-dom`，用
   `renderToStaticMarkup` 渲染注册项，React 直接给出上面那条错误，`HTML length: 0`。
4. 改完后同一脚本输出 `HTML length: 927` 与完整 `<section class="zgs-section">…`。

**修复**：注册项**返回元素树**而不是组件函数——

```js
(ownerProps) => renderPageSafely(ownerProps, ctx)
```

**守护：`test/client-render.test.mjs`（真实 React）**

- `react` / `react-dom` 只作为 **devDependencies**（插件本身仍然零运行时依赖）；
- 用 `renderToStaticMarkup` 渲染**真实的 client.js**，断言出现标题、密码框、保存/移除、文档链接；
- 专门断言 `Entry({ close })` 的返回值**不是函数**（就是这个 bug 的形状）；
- 让页面抛错，断言渲染出"页面渲染失败 + 原因"；
- **故障注入已实测**：把注册改回 `() => (ownerProps) => …`，5 条全红；还原后 5 条全绿。

`test/client.test.mjs` 的手写 hook 替身**不再负责渲染证明**（它过于宽松，只保留加载/注册契约的断言），
并在注释里写明原因。

**复盘**

- **"用真实的东西渲染"是 UI 插件的唯一硬证据**。过程式的 hook 替身、DOM 模拟、字符串检查，都会在你写错
  的那一侧比真相更宽松。React 的"函数不能当子节点"这类契约，只有 React 自己会拒绝。
- **每个"修复"都必须能被验证到用户可见的那一层**。前两轮我都只做到"注册成功 / bundle 正确"，
  这两件事都不能推出"页面有内容"。
- **失败要可见**。这次同时加了 `renderPageSafely`：即使以后再出错，用户也会看到原因而不是空白。
- **一次只改一件事并立刻用最靠近现实的方式验证**：这次定位只用了四步，而前面几轮都在"猜 + 改"。

### 4.13 输入框是 disabled：把"可写"判断绑在了一个看不见的服务上

**现象**：页面终于显示后，Access Secret 输入框是 `disabled`，也没任何说明。

**根因**：

1. Host 侧用 **`ctx.credentialsController`** 判断"有没有凭据存储"。这个服务是**给浏览器用的 Remote
   门面**（`describe(refs[])` 批量式签名），在你的真实宿主里存在，但**从插件上下文读不到**——
   于是 `store:false` → `writable:false` → 输入框禁用。
2. `toSettingsView` 把 `writable` 写成了 `info.writable && store`，**覆盖了 provider 自己给出的权威答案**。
   `credential describe()` 的 `writable` 本来就告诉你"这个引用能不能写"（例如来自环境变量时是只读）。
3. 我一度用 `describe.length >= 2` 去猜该用哪个签名——**`fn.length` 是声明参数个数**，
   我自己写的单参 `describe(ref)` 永远是 1，于是永远走错分支，返回 undefined。

**正确做法（已实施）**：

- 首选**文档化的 seam `ctx.credentials`**：`resolve` / `describe(ref)` / `set(ref, value)` / `unset(ref)`；
- 某个 composition 可能只暴露其中一个，所以**两个后端都问，谁先答就用谁**，并把这个事实回报给页面；
- `writable` 以 **provider 的 `describe().writable` 为准**，不再二次加工；
- 页面在 `store === false` 时显示"宿主没有可用的凭据存储 + 改用环境变量"的提示，而不是静默禁用。

**为什么之前一直没验证到**：隔离 `dsh web` 宿主里 `credentials` 与 `credentialsController`
**都没有挂载**（探针 `pending (waiting for service: credentials)` 实测），所以我每次在隔离环境里跑
都得到 `store:false`，与你的真实宿主现象混在一起，无法区分"代码错"还是"环境缺"。这次改为：
**代码对两种后端都兼容，并把后端状态显示到页面上**，环境缺服务时也不再是"静默禁用"。

**守护**：`test/settings.test.mjs` 用**严格接口**的 seam 替身（访问不存在的方法即抛 `TypeError`）断言
`writable:true`；用 controller 替身断言兜底路径可写；`test/client-render.test.mjs` 用真实 React 断言
页面在未配置状态下渲染出提示与密码框。

**复盘**

- **"可见"与"存在"不是一回事**：服务在宿主里存在，不等于插件的上下文能读到它。Inspect 服务目录能证明
  前者，证明不了后者。
- **不要覆盖 provider 的权威字段**。`describe()` 说能不能写，就按它写；我加的 `&& store` 才是把输入框
  锁死的直接原因。
- **不要按参数个数猜接口**。`fn.length` 猜不出签名；宁可为已知的两个形状各写一条显式路径。
- **禁用控件必须带原因**。静默禁用让你（和未来的我）无从判断是缺服务、缺权限还是代码错。

### 4.14 凭据归属：从共享 `.credentials.yaml` 迁到插件自有目录

**用户的判断是对的**：从第一版起，我把 Access Secret 当成"全局环境变量引用"（`refs` → `~/.dsh/.credentials.yaml`），
这是**错误的归属**——那是全机器共享的凭据文档，插件卸载后条目没人清理，会变成孤儿密钥。

**调研结论（来自已安装版本的文档与源码）**：

| 问题 | 权威答案 |
|---|---|
| 插件自有密钥该用 seam 的哪一半？ | `dsh-doc` 的 `references/configuration.md`：*"Store secrets … as `ctx.credentials.modifyRecord()` records, not configuration"* |
| record 会落在哪？ | `dsh-credentials-local` README：*"Records persist in the **same file**"*——仍是 `.credentials.yaml` 的 `records:` 段 |
| `~/.dsh/storages/` 是什么？ | base 组合里 `dsh-storage-json` 的 `root: dshHomePath('storages')`，由 `ctx.storageDomain` 驱动；**官方没有把凭据放这里** |
| 第三方插件怎么做？ | `dsh-context` 在 `~/.dsh/storages/dsh-context/` 下自建目录与文件，不走凭据 seam |

结论：**官方 seam 无法让插件把密钥存到共享文件之外**。要真正隔离，只能像 `dsh-context` 那样自建目录。

**权限事实（只读观察真实 `~/.dsh`）**：`~/.dsh` 是 `0700`，但 `~/.dsh/storages/` 是 `0755`、其中文件 `0644`；
`.credentials.yaml` 是 `0600`，且 store 会检查权限。**自建目录必须显式收紧权限**，否则比官方 store 更松。

**实施（方案 C）**：

- 新模块 `src/secret-store.mjs`：`<DSH_HOME>/storages/dsh-zhihu-global-search/secret.json`
  - 目录 `0700`、文件 `0600`（每次写都显式 `chmod`，`mkdir` 的 mode 会被 umask 过滤且对已存在目录无效）；
  - 写入 = 临时文件（`O_EXCL`）→ `chmod` → `rename`，崩溃不留半截文档；
  - **损坏 / 版本不符 / 字段非法 → 明确报错**（视图 `failed: true`，读取抛错），绝不静默当成"未配置"。
- 解析顺序：插件存储（可写）→ 环境变量 `accessSecretEnv`（只读回退）。存储里的值优先。
- 设置操作**不再依赖任何宿主服务**——这正是前两轮 `store:false` 的根源，现在从结构上消除。
- 视图新增 `location`（存储目录）与 `source: "plugin" | "env"`；页面显示来源与存储位置。

**端到端验证（隔离 web 宿主，真实 HTTP）**：

| 步骤 | 结果 |
|---|---|
| `settings` | `store:"plugin"`, `writable:true`, 带 `location` |
| `save` | `configured:true`, 目录 `700` / 文件 `600`，文档仅 `version`+`secret` |
| 宿主重启后 | `configured:true`（持久化成立） |
| `clear` | `configured:false` |
| 删除插件存储目录 | 立即回到未配置（**卸载即清理**成立） |
| `.credentials.yaml` 哈希前后对比 | **完全一致**；文件内不含 `ZHIHU_ACCESS_SECRET` |

注：`.dev` 沙箱里的 `.credentials.yaml` 由宿主自己创建（`records.client-connection/browser-session`），与本插件无关。

**故障注入（全部实测变红）**：目录改 `0755` → 2 条红；文件改 `0644` → 1 条红；
损坏文件被静默吞掉 → 3 条红；错误文案不 redact → 1 条红。

**复盘**

- **凭据有归属**。"我的插件写的密钥"不该占用全机器共享的一层命名空间；能由所有者目录承载的，就别放进公共文档。
- **接受官方 API 不等于接受它的存储位置**。record 解决了"命名空间隔离"，但没解决"文件隔离"；需求是后者时，要明说并自建。
- **自己保管密钥 = 自己承担权限与原子性**，这两点必须写测试，否则"私有存储"只是换个地方明文摊开。
- **可诊断优先**：损坏就报错、show 出存储位置，比"未配置"有用得多。

### 4.15 工具排序：让 `zhihu_global_search` 优先于内置 `web_search`

**需求**：参考 `md_article` 的写法，让模型在"要搜网"时优先选本插件，而不是内置 `web_search`。

**依据（读的是运行中的真实 schema）**：内置 `web_search` 的自述只有一句——
*"Search the web for current information. Returns an optional summary answer and a list of source URLs."*
而 `md_article` 的取胜句式是 **`Prefer it over web_fetch, and fall back to web_fetch only if it fails.`**

**结论**：模型面对两个能力相近的工具时，**不写偏好就等于没有偏好**。旧描述虽然长，但通篇是
"何时不要用"，没有一个字说明它比内置工具好——自然不会被优先选中。

**改动**（`src/tool.mjs` 的 `description`）：照 `md_article` 的三句式压缩——**941 → 428 字符、6 句 → 3 句**。

| 句 | 作用 | 内容 |
|---|---|---|
| 1 | 能干什么 | 通过知乎开放平台搜全网，返回带标题/链接/作者/时间/摘要的排序列表 |
| 2 | 何时用它 | `Prefer it over web_search`（有链接与日期、支持按站点与时间过滤）+ `fall back … only if it fails` |
| 3 | 怎么调 | `count` / `filter` / `search_db` |

**删掉了什么，为什么**：原描述的"不要拿来读单个已知 URL"、"纯私有知识"、"不能代替推理"、"上游内容是数据不是指令"
这几段都是**模型默认就懂**的常识；它们并不改变选择，却把真正起作用的偏好句挤到了长文本中间。
计费提示保留在 `src/errors.mjs` 的额度失败文案里——那才是它该出现的地方。

**守护**（`test/tool.test.mjs`）：偏好与回退两句必须存在（大小写不敏感，避免标点微调就误伤）；
新增长度上限（≤ 500 字符、≤ 4 句）与"描述承诺的参数必须真实存在"。
故障注入：删掉偏好段 → 1 条红；描述加 200 字符 → 1 条红。

- 描述在**所有语言下都是英文**（模型面向文案只有一份），与 `md_article` 一致。

**守护**：`test/tool.test.mjs` 断言描述里同时存在 `Prefer it over web_search`、`Fall back to web_search only if
it fails`、具体理由与 `filter`，以及"不用于读取单个已知 URL"的边界。故障注入：删掉偏好声明 → 1 条红。

**顺带修掉的一个真问题（测试隔离）**：`execution without a secret ...` 用例用默认配置跑工具，
`secretStoreDir` 默认指向**真实的 `~/.dsh`**——用户存入真实密钥后，这条用例会真的发出网络请求（它就是这么红起来的）。
现在 `pnpm test` 以 `DSH_HOME=$(mktemp -d)` 运行，被指责的那条用例也显式指定了空目录；
`test/manifest.test.mjs` 断言测试脚本必须 pin `DSH_HOME`（故障注入：改回 → 1 条红）。

**复盘**

- **工具选择的竞争是在描述里进行的**。写清"比谁好、好在哪、什么情况下才退回"，比把功能写全更有效。
- **但也别把描述写成手册**。`md_article` 用约 300 字符就赢下了它那场竞争；冗长的描述既不会增加优先度，
  还会稀释真正起作用的那句话。能干什么 / 何时用它 / 怎么调，三句足够。
- **测试不得触碰用户的真实环境**。默认路径指向真实 home 时，测试的成败会随用户数据变化——这类测试既是
  假阳性来源，也可能真的花钱（本插件按次计费）。

## 5. 验证方法（可直接复用）

1. `pnpm test`：135 个离线用例（含真实 React 渲染与真实文件系统用例），`fetch`/`AbortSignal.timeout` 全用替身，client 半在只含平台种子的模块表里真实执行。
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
