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
- **`defineTool.parameters` 用 authoring DSL，不是 JSON Schema**：
  - ✅ `{ url: { type: 'string', required: true } }`
  - 🚫 `{ type: 'object', properties: {...}, required: ['url'] }`（会抛 `JsonSchemaError`）
  - `output.schema` 才是 JSON Schema 子集。
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

每个项目的 `AGENTS.md` 应说明它自己的自测脚本入口。若项目尚无脚本，可参照上述模式新增一个 `scripts/dev.sh`。

## 4. 交付纪律

1. 改代码 → 跑该项目全部自测 → 修复直到全绿。
2. 安装到用户 profile 时，明确告知这是一次跨工作区写入。
3. 安装完成后提醒用户：**正在运行的宿主不会加载新代码，需要重启一次**。
4. 若改动涉及配置键、版本门禁或对外行为，同步更新该项目的 README 与开发记录。

## 5. 项目索引

| 项目 | 说明 | 专属规则 |
|---|---|---|
| `omni-article-markdown-plugin/` | 把墨探 `mdcli` 封装成 `md_article` 原生工具 | 见 `omni-article-markdown-plugin/AGENTS.md` |

新增插件时，请在上表登记，并在插件目录内提供自己的 `AGENTS.md`（写项目独有的目录结构、脚本入口、领域约束），通用规则不要复制过去。
