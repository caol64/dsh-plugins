# 开发复盘：把 omni-article-markdown skill 做成 DSH 插件

> 记录时间：2026-11-18
> 插件版本：0.1.0（`dsh-omni-article-markdown`）
> 运行环境：DSH 0.2.2-rc.1 · Node 24.14.1 · pnpm 10.33.0 · mdcli 0.2.4

---

## 1. 背景与目标

起点是一份**纯提示词 skill**：

- skill 只包含“怎么用 `mdcli`”的说明书；
- 模型读完说明书后，自己用 bash 拼命令、用 `command -v` 检查安装、自己处理 `-s` 路径与截断。

这套方式能跑，但每次调用都在“重新推导流程”：安装检查、路径解析、错误处理全靠模型临场发挥，难以稳定。

本次开发把它升级为一个 **DSH 插件**，交付物只有一个：原生工具 **`md_article`**。

```
调用方（模型） ── md_article(url, max_tokens, save, raw_html …) ──┐
                                                                 │
                     index.mjs（薄注册层：校验配置、注册工具）      │
                                                                 ▼
                     src/convert.mjs（一次转换的完整生命周期）
                        ├─ env.mjs    定位 mdcli、版本门禁
                        ├─ setup.mjs  缺失时自动安装 mdcli / Chromium
                        ├─ run.mjs    子进程调用、超时、取消、退出码
                        └─ errors.mjs 失败分类 → 可行动的提示文案
```

---

## 2. 模块职责（每个文件只有一个理由存在）

| 文件 | 唯一职责 | 关键导出 |
|---|---|---|
| `index.mjs` | 薄注册层：校验配置、注册工具、定义 `presentCall` | `name` `inject` `DEFAULTS` `resolveConfig` `apply` |
| `src/convert.mjs` | 一次调用的完整生命周期（解析目标 → 确保工具 → 执行 → 重试 → 投影结果） | `convertArticle` `resolveTarget` `resolveSaveTarget` `projectResult` |
| `src/env.mjs` | 定位 `mdcli` 并解析版本；`--truncate` 能力门禁 | `probeMdcli` `supportsTruncate` `TRUNCATE_MIN_VERSION` |
| `src/run.mjs` | 参数数组组装、spawn、超时、SIGTERM→SIGKILL、stderr 解析 | `buildArgs` `runMdcli` `TRUNCATE_MARK` |
| `src/errors.mjs` | mdcli 失败文本 → 分类 + 是否值得重试 + 可行动文案 | `classifyFailure` `shouldRetry` |
| `src/setup.mjs` | pipx → uv → pip 的安装策略、Chromium 补装、结果缓存 | `installMdcli` `installBrowser` |
| `src/tool.mjs` | 工具描述、参数 authoring DSL、输出 schema、中英文文案 | `PARAMETERS` `OUTPUT_SCHEMA` `stringsFor` |

依赖方向是单向的：`index → convert → {run, env, errors}`，`setup` 只通过 `index` 注入的 runtime 被 `convert` 调用。没有任何文件反向依赖 `index`，也没有循环。

**为什么 `index.mjs` 必须薄**：它是插件被 Cordis 加载的唯一入口，任何在这里抛出的异常都会导致插件激活失败（见 §4.2）。业务逻辑一旦堆进来，出错半径就会从“一次调用失败”扩大为“整个服务起不来”。

---

## 3. 关键设计决策

### 3.1 不注册 skill（原方案有，后删除）

最初把 skill 正文也注册进了 skill 目录，理由是“兼容原有工作流、方便排查”。复盘后判定三条理由都不成立：

- DSH 的 skill 与 Claude Code 的 skill 不互通，兼容性说法不成立；
- `bundled` 来源优先级更高，反而**覆盖**了用户原有的 skill；
- 工具描述本身已经进入模型上下文，skill 摘要是在重复它。

能力已经落成代码，再挂一个“只列不加载”的目录条目，既占目录空间又容易造成“到底哪份是准的”的混淆。因此删除 `src/skill.md` 与全部注册代码（`index.mjs` 238 → 178 行），并在测试里加了守护断言：**插件不得注册 skill、不得声明 skill 依赖、不得打包 skill 资源**。

### 3.2 `inject` 只放 `tools`，其余服务走守卫

`inject` 声明的是**必需**服务。把 `skills`、`i18n`、`workingDirectory`、`effect` 列进去，等于告诉 Cordis“缺了任何一个都别启动”，而插件对它们是可降级的。所以：

```js
export const inject = ['tools'];

function optional(ctx, key) {
  try { return ctx[key]; }
  catch { return undefined; }   // Cordis 对未注入服务的访问会抛错
}
```

这是本次最重要的教训，详见 §4.2。

### 3.3 截断交给 mdcli，插件只做版本门禁

`mdcli 0.2.4` 起提供 `--truncate [N]`：按空行分块收尾、代码围栏不被劈坏、末尾 `…[truncated]`、可与 `-s` 组合。插件**不自研截断**（早期 0.2.2 时代曾设计过 `truncate.mjs`，0.2.4 后整体删除），只做两件事：

- 未传 `max_tokens` 时**不**附加该参数（裸 `--truncate` 会启用 800 的默认值）；
- 版本 < 0.2.4 且请求了截断时，直接给出升级指令，而不是静默降级或传入未知选项。

判定“是否被截断”只看输出是否以 `…[truncated]` 结尾，不在插件侧重复计算 token。

### 3.4 `save` 由插件先落盘目录

mdcli 只按 `Path.is_dir()` 判断 `--save`：路径**已存在为目录**才当目录，否则当作文件名写出。直接透传会得到两个坏结果：

- `save: "./out"`（目录不存在）→ 生成一个名为 `out` 的文件，标题丢失；
- `save: "notes/article"`（多级且不存在）→ 直接失败。

因此 `resolveSaveTarget()` 先按“有无扩展名”判定是文件还是目录，再 `mkdir -p`，然后交给 mdcli。

### 3.5 失败一律翻译成“下一步该做什么”

`classifyFailure()` 把 stderr 映射为六类：`extract` / `browser` / `timeout` / `ssl` / `empty` / `unsupported-option` / `other`，每类附带可执行建议，并标注是否值得自动重试一次。SSL 与网络类各重试一次；提取失败不重试（重试也没有意义）。

### 3.6 安装策略

缺失 `mdcli` 时依次尝试 `pipx` → `uv tool` → `python3 -m pip install --user`，全部是隔离环境，不污染系统 Python；成功/失败结果分别缓存 24 小时 / 1 小时，并用互斥锁避免并发重复安装。Chromium 只在 mdcli 明确报缺失时补装，且用 mdcli 自身的 shebang 解释器安装。

---

## 4. 踩坑记录（真实发生，逐条含根因与回归手段）

### 4.1 假 ctx 太宽松，掩盖了 `defineTool` 的 schema 契约

**现象**：单测全绿，但用真实 `@deepseek-ai/dsh-tools` 校验时报 `JsonSchemaError: parameters.type must be a value schema object`。

**根因**：`defineTool.parameters` 接受的是 **authoring DSL**（属性映射，键上标 `required: true`），不是 JSON Schema：

```js
// 错误：JSON Schema 形状
{ type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
// 正确：defineTool 的 authoring DSL
{ url: { type: 'string', required: true } }
```

**修复**：改写 `PARAMETERS`；**回归手段**改为拿真实 `defineTool` 跑一次编译，而不是用替身。

### 4.2 访问未注入的服务 → 整个 web 服务启动失败

**现象**：重启后插件无任何反应；`~/.dsh/logs/startup-*.log`：

```
omni-article-markdown (dsh-omni-article-markdown)
    Error: cannot get property "i18n" without inject
```

**根因**：`apply()` 读了 `ctx.i18n?.locale`，但 `inject` 未声明 `i18n`。Cordis 对未注入服务的属性访问**直接抛错**；又因为 `inject` 列的是必需服务，该异常让插件激活失败，并升级为 **整个 web 进程启动失败**（`2 required plugins did not activate`）。

**修复**：`inject` 仅保留 `tools`，可选服务改用 `optional()` 守卫。

**回归手段**：用 `Proxy` 构造一个“访问未注入服务就抛错”的 ctx，复现真实 Cordis 规则——这是原来的普通对象假 ctx 永远测不出来的。

### 4.3 `engines.dsh` 用了普通范围，bundle 被静默跳过

**现象**：插件文件齐全、模块可导入、profile 里也有 bundle 条目，但工具就是不出现，且没有任何报错。

**根因**：`engines.dsh: ">=0.2.1"` 在 semver 语义下**匹配不到预发布版本** `0.2.2-rc.1`（范围里没有预发布锚点时，预发布版本不参与匹配）。dsh 把 `engines.dsh` 当作唯一兼容门禁，不满足就**静默跳过整个 bundle**。

**修复**：改为 `>0.2.0-0 <0.2.2 || >=0.2.2-0 <0.3.0`，并用 semver 实测：`0.2.1-rc.2`/`0.2.2-rc.1`/`0.2.2` 匹配，`0.1.9`/`0.3.0-rc.1` 不匹配。

### 4.4 bundle patch 内联整份 config，覆盖语义是“替换”

**根因**：patch 里写了一整块 `config`，而用户在 profile 里覆盖时是**整体替换**不是深合并——一条只写 `allowInstall` 的覆盖行会把 `timeoutMs` 等重置为默认值。

**修复**：bundle patch 只写 `id` + `name`，全部走默认值；README 注明“覆盖时只写要改的键”。

### 4.5 `save` 指向不存在的目录 → 生成了错误文件名的文件

**现象**：`save: "/tmp/omni-test"` 返回“已保存”，但实际生成的文件就叫 `/tmp/omni-test`。

**根因**：mdcli 的 `save()` 只认已存在的目录，其余一律当文件名。插件还把目录路径当作“已保存文件”返回。

**修复**：`resolveSaveTarget()` 预先创建目录/父目录（见 §3.4）。

### 4.6 验证手段本身有漏洞

**现象**：连续三次“自测通过”，但真实 host 里插件从未生效。

**根因**：验证链上每一环都可能与真实环境不一致——

- 假 ctx 不校验 `inject`；
- 直接 `import` 模块不等于 Cordis 会加载它；
- `dsh --dump-config` 只做组装、**不启动**，看不到激活失败；
- 运行中的旧进程不会因为文件改动而重新加载。

**结论**：判断“插件能否加载”必须用**真实 host 启动**，且探针要在宿主进程内读取 `ctx.tools.definitions()`。

---

### 4.7 自测链路自身会给出假结果（建立 `dev.sh` 时暴露）

搭建无人值守自测时，连续踩到四个让“自测通过”失去意义的问题：

**现象 1：探针永不退出。** 在隔离 HOME 启动 `dsh web` 后进程一直挂着。
**根因**：`web` 应用启动后不会跑任何模型步，挂在 `agent/pre-step` 的探针永远不会被调用。
**修复**：工具注册改用 `headless` 应用验证（它会执行一次模型步），`web` 只用于人工看 UI。

**现象 2：把故障注入后 check 仍然通过（假阳性）。**
**根因**：pnpm 按版本号缓存 `file:` 包；源码改了但版本号没变，`pnpm install` 复用了旧拷贝，测的其实还是旧代码。
**修复**：每次 check 前 `rm -rf <profile>/node_modules/<pkg>`，强制从源码重新拷贝。

**现象 3：`--patch` / `--profile` 各种参数错误。**
**根因**：`dsh <app>` 本身就是 `--profile <app>` 的简写，应用名即 profile 名，`--profile` 只允许出现一次；`--patch` 是启动器参数，必须与显式 `--profile` 搭配且写在应用参数前；`--no-open`/`--port` 只属于 web 应用。
**修复**：脚本固定写成 `dsh --profile <app> --patch <file> [web-only flags]`。

**现象 4：隔离启动仍想绑定 3080。**
**根因**：web 服务器端口来自 `webStartup.port ?? 3080`，与环境变量无关。
**修复**：用 web 应用自带的 `--port 0`（OS 分配空闲端口）与 `--no-open`。

**另外的教训**：验证过程中曾在 `~/.dsh/profiles/web` 误执行 `pnpm add`（已核实无副作用）。`dev.sh` 因此加了守卫——任何操作路径落在 `~/.dsh` 下直接拒绝执行。

---

### 4.8 文档里写了一个不存在的 pnpm spec：`github:<owner>/<repo>/<subdir>`

**现象**：按 README 执行 `dsh plugin --profile web add "github:caol64/dsh-plugins/dsh-omni-article-markdown"`，得到
`ERR_PNPM_GIT_RESOLVE_FAILED`，git 去拉的仓库是 `github.com/caol64/dsh-plugins/dsh-omni-article-markdown.git`。

**根因**：pnpm 的 `github:` 解析器只认 `owner/repo`（可选 `#ref`），**没有子目录语法**；第三段被当作仓库名的一部分。README 当时凭印象写了“pnpm 支持 `<owner>/<repo>/<subdir>`”，属于事实性错误——用户撞上后才发现。

**修复与约束**：

- 仓库内所有文档只使用四种合法 spec：npm 包名、Release `.tgz` URL、本地路径（`./x`、`file:$HOME/x`）、`github:<owner>/<repo>#path:/<subdir>`。
- 已实测：`github:caol64/dsh-plugins#path:/dsh-omni-article-markdown` 解析正确；不带 `#path:` 时报的是“仓库不存在”。
- 由于一仓库多插件、根目录无 `package.json`，`github:owner/repo`（整仓）不可用；且即便补成 pnpm workspace，git 安装时 workspace 子包的 peer/engines 也不会被装上，版本门禁会“看起来通过”。
- 分发因此改为两条腿：npm（发布时显式 `--registry https://registry.npmjs.org`，本机默认是 npmmirror 镜像，不能发布）+ `.github/workflows/release.yml` 把 `pnpm pack` 产物挂到 Release。

**另一处同类误判**：`dsh plugin add ./相对路径` 是否可用，取决于调用时的 cwd——`anchorPathSpec` 在 launcher 里完成解析，profile 目录执行 pnpm 时已经是绝对路径。自测时必须**从仓库外**（例如 `/`）执行，才能复现用户真实操作。

### 4.9 固化了"验证方法"却不保护"验证器"：两份 dev.sh 漂移，自测出现假阳性

**背景**：`dsh-zhihu-global-search` 出现后，`scripts/dev.sh` 被整个复制了一份。基线比对显示差异并不只是
包名：`dev:dump` 的行提取在 omni 副本里是错的（`awk` 的 `keep` 在首个不匹配的 banner 之后**永久为真**，
会打印整棵树）；同时两份副本的探针断言写法不同。为了"每个插件都真的会被断言"，决定把实现收敛到仓库根的
[`scripts/dev.sh`](../../scripts/dev.sh)，插件目录只留转参薄壳。

**收敛过程中暴露的三个真实缺陷**（都发生在共享脚本里，全部已修）：

1. **`pnpm run <script>` 会把脚本名再追加进参数**：`pnpm run dev:check` 实际执行
   `bash scripts/dev.sh dev:check`。薄壳若把 `$@` 原样转发，共享脚本收到的是
   `<plugin-dir> dev:check`，动作变成路径——于是只打印 usage。更糟的是：若薄壳"过滤掉像脚本名的参数"来
   绕过它，真正的 `check` 也会被一起过滤掉。正确做法是只丢掉**第一个**且形如 `dev:*` / `*/dev.sh` /
   `scripts/*` 的参数。
2. **探针的断言语义有两条分支，检查却只做子串匹配**：探针在"没有声明任何工具"时也会打印
   `present=true`，而 `check` 用 `grep 'DEVPROBE .*present=true'` 判断——于是**任何**情况都能通过。
3. **同一个概念有两个变量**：`TOOLS`（真正传进探针的值）和 `TOOL`（只用于显示标签）。故障注入时拷了旧
   脚本到临时备份，回滚把 `TOOLS` 也一起还原，`TOOL` 却仍带着被注入的假值，一度把"注入了假工具名却通过"
   归因给了 grep。

**修复**：

- 单一变量 `TOOLS`（来自 `package.json` 的 `dsh.tools`），`check` 解析探针那一行：声明了工具就必须出现
  `tool=<该工具> present=true`，出现 `present=false` 一律失败。
- 安装副本比对不再用 `diff` + `sed` 拼字符串（mac 的 BSD sed 对含 `/` 的路径转义直接报
  `bad flag in substitute command`，而该错误被 `2>/dev/null` 吞掉，等于**从不报告缺失文件**），改为一个
  Node 比较器：逐字节比对 + 用 `files` 规则（含单段 `*`）找出"应该发布但缺失"的文件，退出码区分
  `1=内容不同` / `2=缺发布文件`。
- 沙箱位置统一到仓库根 `.dev/`，`clean` 幂等。

**回归手段**：故障注入必须**真的注入到实际生效的变量**，并在两个入口（`pnpm run check`、`bash
scripts/dev.sh check`）各验一次：`dsh.tools` 写成不存在的工具名时，两者都必须以非 0 退出并打印
`DEVPROBE missing=<名>`。只改显示标签不算注入——这次就是这样发现 `TOOL`/`TOOLS` 双变量问题的。

**教训**：把"验证方法"产品化成脚本时，脚本本身就是被验证的对象。「自测全绿」只有在有人真的用坏输入把
它打红过之后，才是一个结论。

## 5. 验证方法论（可直接复用）

分三层，**下一层不能靠上一层的结论推出来**。这三层现已固化进 `scripts/dev.sh`。

### 5.1 单元测试

```bash
pnpm test        # 65 个用例，全程离线
```

用 `test/fixtures/fake-mdcli.mjs` 以环境变量驱动 mdcli 的各分支（成功 / 截断 / 保存 / 报错 / 超时 / 浏览器缺失）。

### 5.2 隔离 DSH_HOME 自测（`pnpm run check`）

不碰 `~/.dsh`、不占 3080、不需要凭据、不需要重启 GUI：

```bash
pnpm run check              # 断言 md_article 已注册
pnpm run check:installed    # 追加校验安装副本文件集
```

实现要点（都是实测出来的约束，别“优化”掉）：

- `DSH_HOME` 指向仓库内 `.dev/home`，profile 由脚本按应用模板生成；
- `dsh <app>` 等价于 `--profile <app>`，应用名即 profile 名，`--profile` 只能出现一次；
- `--patch` 是启动器参数，必须显式 `--profile`，且要写在应用参数之前；
- **`web` 应用启动后不跑模型步**，`agent/pre-step` 探针永不触发 → 用 `headless` 应用验证工具注册；
- `--no-open` / `--port 0` 只属于 web 应用，用于 `pnpm run dev:boot` 人工看 UI；
- 每次 check 前 `rm -rf` 安装副本：pnpm 按版本号缓存 `file:` 包，版本号不变时会复用旧代码，导致**假阳性**；
- 脚本内置守卫：任何操作路径落在 `~/.dsh` 下直接拒绝。

探针在宿主进程内读取 `ctx.tools.definitions()`，实测对照：

| 场景 | 结果 |
|---|---|
| 未装插件 | `tools=25 md_article=false` |
| 装插件后 | `tools=26 md_article=true has_bash=true` |
| 故意注入未知配置键 | `md_article=false`，退出码 1，并打印根因 |

> 探针与临时 HOME 由脚本在结束时清理；手工验证同样必须删除。

### 5.3 交付后确认

安装到 `~/.dsh/profiles/web` 后，副本一致性可先本地核对：

```bash
diff -r ~/.dsh/profiles/web/node_modules/dsh-omni-article-markdown . \
  -x test -x docs -x scripts -x node_modules -x .dev -x .DS_Store -x AGENTS.md
```

自测能证明“工具已注册”，**不能**证明 GUI 渲染效果；那一步仍需用户重启宿主后确认。

### 5.4 端到端

对真实站点跑：全文 / `max_tokens` 截断 / `save` 到新目录 / `save` 到指定文件 / `raw_html` / 错误目标（`ftp://`、不存在的文件）。

---

## 6. 已知限制

- Web GUI 没有专属的调用卡片或设置面板，结果以 Markdown 文本呈现。
- 用户原有的 `~/.agents/skills/omni-article-markdown/SKILL.md` 与工具描述功能重复；是否移除由用户决定，插件不再覆盖它。
- `file:` 安装是**拷贝**而非软链：改完源码必须重新 `pnpm add` 才会同步到 profile；直接改源码后重启服务**不会**生效。
- 自测沙箱验证的是“插件能被加载并注册工具”，**不覆盖** Web GUI 的渲染效果；UI 相关改动仍需交付后人工确认。
- 隔离沙箱需要一个可用的 `dsh` 可执行文件（默认取 `PATH`，其次 `~/Library/pnpm/dsh`），可通过 `DSH_BIN` 指定。

---

## 7. 依赖与包管理器核查（npm 全局清理结论）

| 检查项 | 结论 |
|---|---|
| 插件依赖 | **零运行时依赖**，项目下没有 `node_modules`，从未执行过 install |
| 本次安装动作 | 仅有 `pnpm add "file:…"`（profile）与 `pnpm remove`，**未使用** `npm install` / `npm i` / `npx` |
| npm 全局根 `~/Library/pnpm/nodejs/24.14.1/lib/node_modules` | 只有 `@google`、`@qwen-code`、`corepack`、`npm`，安装时间 2026-04/05，与本次开发无关 |
| `~/.npm` 缓存（476 MB） | 用户既有缓存，**不含**本项目任何制品 |
| pnpm 全局 store | 没有 `omni-article-markdown` 相关制品；`dsh-skill`、`semver` 等 mtime 早于本次开发 |

**结论：本次开发没有向全局 npm 仓库写入任何依赖或环境，无需清理。**
唯一需要纠正的是文档里误用的 `npm test`，已改为 `pnpm test`。请**不要**为了“清理”而删除 `~/.npm`——那是用户长期积累的缓存。