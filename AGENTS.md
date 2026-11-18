# AGENTS.md

本文件指导后续 AI 代理在**本工作区**内开发 DeepSeek Harness（DSH）插件。它只包含对所有插件都成立的通用规则；每个插件的专属约定写在该插件目录自己的 `AGENTS.md` 中，进入对应目录时会自动追加生效。

**动手前请完整读完第 0、1 节。**

## 0. 硬性限制（不可协商）

### 0.1 所有开发必须在 pnpm 环境下进行

本工作区统一使用 **pnpm**。**禁止**使用 npm / yarn / bun / npx 执行任何安装或脚本。

| 场景 | ✅ 正确 | 🚫 禁止 |
|---|---|---|
| 安装依赖 | `pnpm add <pkg>` / `pnpm add -D <pkg>` | `npm install` / `npm i` / `npm add` |
| 移除依赖 | `pnpm remove <pkg>` | `npm uninstall` |
| 运行脚本 | `pnpm <script>` / `pnpm run <script>` | `npm test` / `npm run` |
| 一次性执行 | `pnpm dlx <pkg>` | `npx <pkg>` |
| 安装到 DSH profile | `cd <profile> && pnpm add "file:…"` | `npm install file:…` |

- 只读查询（`pnpm list`、读锁文件）可以；任何会产生写入或下载的操作必须走 pnpm。
- 不要在仓库里生成 `package-lock.json`；发现历史 npm 痕迹应纠正为 pnpm。

### 0.2 不碰用户的真实 harness home

`~/.dsh` 是用户正在使用的运行时。**禁止**为了“验证一下”而修改 `~/.dsh/profiles/*`、`~/.npmrc`、`~/.agents` 等用户配置。

- 插件自测一律在**隔离 `DSH_HOME`** 内进行（见 §3）。
- 只有明确要求“交付/启用插件”时，才允许改动 `~/.dsh/profiles/<profile>`，且属于跨工作区写入，需要用户授权。
- 不要删除 `~/.npm` 缓存或用户已有全局包，除非用户点名。

### 0.3 保持插件零依赖

插件应只依赖宿主提供的 peer（`@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools` 等），不引入运行时依赖，也不需要 install 步骤。新增依赖前先证明无法用宿主已有能力实现。

## 1. 通用 DSH 插件知识（这些是真实踩过的坑）

- **`engines.dsh` 是唯一兼容门禁**，且 dsh 对不满足的 bundle 会**静默跳过**。
  - 必须带预发布锚点，例如 `>0.2.0-0 <0.2.2 || >=0.2.2-0 <0.3.0`；
  - 普通范围 `>=0.2.1` **匹配不到** `0.2.2-rc.1`（semver 预发布规则），会导致插件“文件都在、就是不生效”。
- **`inject` 只放真正必需的服务**。访问未注入的服务时 Cordis 会抛 `cannot get property "x" without inject`；由于 `inject` 声明的是必需服务，这个异常会让**插件激活失败**，严重时导致整个宿主启动失败（`N required plugins did not activate`）。
  - 可选服务（如 `skills`、`i18n`、`effect`）要通过守卫读取：

    ```js
    const optional = (ctx, key) => { try { return ctx[key]; } catch { return undefined; } };
    ```
- **`defineTool` 的 `parameters` 和 `output.schema` 都用 value DSL，不是 JSON Schema**。
  两处都是"作者写 DSL → `defineTool` 编译成 JSON Schema"，编译在 `apply()` 里同步发生：
  写错会抛 `JsonSchemaError`，插件激活失败，工具根本不注册。
  - **节点键只有** `type` / `enum` / `const` / `oneOf`（与 `type` 互斥）/ `properties` /
    `additionalProperties` / `items`，外加注解 `description` / `title` / `default` / `examples`；
    属性上额外允许 `required`。其它键一律报 `xxx is not supported by the value schema DSL`。
  - ✅ 必填：属性级标记，由编译器提升到父对象的 `required` 数组 ——
    `{ type: 'object', additionalProperties: false, properties: { url: { type: 'string', required: true } } }`
  - 🚫 根级 `required: ['url']` **不是**合法节点（参数侧和输出侧都是），报
    `schema.required is not supported by the value schema DSL`。
  - 🚫 `type: 'object'` **必须**显式写 `additionalProperties: true|false`，漏写报
    `schema.additionalProperties must be explicitly true or false`。
  - 可选性只有一条规则：**没有 `required: true` 标记的属性都是可选的**（参数侧与输出侧相同，
    没有 `optional` 语法）。参数侧可以整个省略；输出侧要注意注册表校验的是**返回值的实际形态**，
    所以"可选但出现"的字段必须真写对，schema 不会替它补默认值。
  - 任意 JSON 值用 `{ type: 'json' }`（编译成空 schema `{}`，只做注解）。
  - `additionalProperties: false` 会让注册表**静默丢弃**多余字段，所以输出 schema 与
    实际返回值要成对维护，测试里要有 schema 自洽断言。
  - 具体节点规则以已安装包的 `lib/types/schema.js`（`runSchemaCompiler`）为准，本笔记只记录
    会让人踩坑的差异。要核对某条规则，可以直接对已安装包跑一小段断言，而不是读笔记：

    ```bash
    # 在任一插件目录下执行：对已安装的 dsh-tools 直接验证一条规则
    node -e '
      const path = require("node:path");
      const spec = process.argv[1];
      const schema = require(path.join(path.dirname(require.resolve(spec + "/package.json")), "lib/types/schema.js"));
      try {
        schema.valueSchemaSpecToJsonSchema({ type: "object", properties: { a: { type: "string" } }, required: ["a"] });
        console.log("accepted");
      } catch (error) {
        console.log("rejected:", error.message);
      }
    ' @deepseek-ai/dsh-tools
    ```
- **`cordis.patch.yml` 只写 `id` + `name`**，不要把整份 `config` 内联进去：用户覆盖是**替换**语义而非深合并，内联默认值会把用户的局部覆盖变成整块丢失。
- **`dsh <app>` 等价于 `--profile <app>`**：应用名就是 profile 名，`--profile` 只能出现一次；`--patch` 是启动器参数，需要显式 `--profile`。
- **`file:` 安装是拷贝**，且 pnpm 按版本号缓存：源码改了但版本号不变时，`pnpm add`/`pnpm install` 可能复用旧拷贝。刷新前先 `rm -rf <profile>/node_modules/<pkg>`。

## 2. 通用验证要求

插件的正确性要分三层证明，**下一层不能靠上一层的结论推出来**：

1. **单元测试**：纯逻辑用 `node --test`，子进程/网络行为用 fixture 替身。假 ctx 务必模拟真实约束（例如用 `Proxy` 复现“未注入服务即抛错”），否则会给出虚假的通过。
2. **隔离环境真机验证**：在临时 `DSH_HOME` 中真实启动宿主，断言插件确实被加载（而不是“模块能被 import”）。注意：
   - 直接 `import` 模块、或 `dsh --dump-config`，都**不能**证明插件被激活；
   - `web` 应用启动后不会跑模型步，事件型探针可能永不触发；需要跑一步的场景用 `headless` 应用；
   - 不同应用要各自的 profile（应用名即 profile 名）。
3. **交付后确认**：安装到用户 profile 后，由用户重启宿主确认。自测无法覆盖 UI 渲染。

验证结束后**必须清理**临时 `DSH_HOME`、探针文件与残留进程。

## 3. 推荐的本地自测方式

标准做法是“隔离 `DSH_HOME` + 已安装的 dsh 二进制”，不需要在 devDependencies 里再装一份 dsh（体积大、且版本会与用户实际运行时漂移）：

```bash
DSH_HOME=<repo>/.dev/home dsh --profile <app> --patch ./probe.patch.yml "noop"
```

- `headless` 应用会执行一次模型步，可在 `agent/pre-step` 读取 `ctx.tools.definitions()`；
- `web` 应用可加 `--no-open --port 0`（OS 分配空闲端口、不打开浏览器），**绝不占用 3080**；
- 首次运行会因缺少凭据报 `MISSING_CREDENTIAL`——只有在需要真的调用模型时才需要凭据，插件注册阶段不受影响。

### 3.1 自测脚本是共享的：`scripts/dev.sh` + 两行薄壳

仓库根目录的 [`scripts/dev.sh`](scripts/dev.sh) 是**唯一**的自测实现（上面的标准做法、`~/.dsh` 守卫、`pnpm` 缓存清理、安装副本比对都已固化进去）。每个插件只保留一个薄壳 `scripts/dev.sh`，它把参数原样转给共享脚本：

```bash
exec bash "$PLUGIN_DIR/../scripts/dev.sh" "$PLUGIN_DIR" "${args[@]}"
```

共享脚本**不写死任何插件**，全部从插件的 `package.json` 读取：

| 读什么 | 用来做什么 | 缺省时 |
|---|---|---|
| `name` | profile 里的依赖名、安装副本路径、`dev:dump` 的行匹配 | 必填 |
| `dsh.tools`（数组或对象） | `check` 在真实宿主里断言这些工具已注册 | 不声明时只验证插件激活 |
| `dsh.client` | 是否汇报包 RPC 桥（设置页能否挂载） | 不汇报 |

新增插件时：写一个薄壳、在 `package.json` 声明 `dsh.tools`（注册了原生工具就必须声明），**不要**再复制一份完整脚本——复制出的副本已经漂移过一次（见 `docs/DEVELOPMENT-LOG.md` 的 4.9）。

## 4. 交付纪律

1. 改代码 → 跑该项目全部自测 → 修复直到全绿。
2. 安装到用户 profile 时，明确告知这是一次跨工作区写入。
3. 安装完成后提醒用户：**正在运行的宿主不会加载新代码，需要重启一次**。
4. 若改动涉及配置键、版本门禁或对外行为，同步更新该项目的 README 与开发记录。

## 5. 项目索引

| 项目 | 说明 | 专属规则 |
|---|---|---|
| `omni-article-markdown-plugin/` | 把墨探 `mdcli` 封装成 `md_article` 原生工具 | 见 `omni-article-markdown-plugin/AGENTS.md` |
| `dsh-zhihu-global-search/` | 知乎开放平台全网搜索 → `zhihu_global_search` 工具 + 设置页录入 Access Secret（凭据存储） | 见 `dsh-zhihu-global-search/AGENTS.md` |
| `dsh-session-delete/` | 侧栏会话菜单最下面的「删除会话」：停回合 → 删日志目录 / 投影缓存 → 清记账 → `api-session/removed` 刷新列表（Host 路由 + Client 菜单项，无原生工具） | 见 `dsh-session-delete/AGENTS.md` |
| `scripts/` | 仓库级共享自测脚本（`dev.sh`），被每个插件的薄壳调用 | — |

新增插件时，请在上表登记，并在插件目录内提供自己的 `AGENTS.md`（写项目独有的目录结构、脚本入口、领域约束），通用规则不要复制过去。

**新插件目录必须带上 `pnpm-lock.yaml`**（在插件目录里跑一次 `pnpm install` 生成并提交）。`.github/workflows/release.yml` 按 `${{ matrix.plugin.dir }}/pnpm-lock.yaml` 打开 `actions/setup-node` 的 pnpm 缓存，文件不存在时 workflow 直接在 setup 步骤失败（`Some specified paths were not resolved, unable to cache dependencies`），且 CI 用 `pnpm install --frozen-lockfile` 安装，没有 lockfile 也过不去。
