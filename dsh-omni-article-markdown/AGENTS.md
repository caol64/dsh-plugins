# AGENTS.md — dsh-omni-article-markdown

本文件只写**本项目独有**的内容。通用规则（pnpm-only、隔离自测、DSH 插件坑位）见上级 [`../AGENTS.md`](../AGENTS.md)，不要在此重复。

## 1. 这个插件做什么

把墨探 `mdcli` 封装成 DSH 原生工具 **`md_article`**：输入网页 URL 或本地 HTML 文件，输出干净的 Markdown。

对外只提供这一个工具，**不注册 skill**（这是刻意设计，勿回退，测试里有守护断言）。

```
index.mjs            薄注册层：配置校验 + 注册工具 + presentCall/presentResult
src/convert.mjs      一次转换的完整生命周期（核心业务）
src/env.mjs          定位 mdcli、解析版本、--truncate 能力门禁
src/run.mjs          参数数组组装、spawn、超时、取消、stderr 解析
src/errors.mjs       失败文本 → 分类 + 是否重试 + 可行动文案
src/setup.mjs        缺失时自动安装 mdcli（pipx→uv→pip）与 Chromium
src/tool.mjs         工具描述、value DSL 的参数与输出 schema、中英文文案
locale/{en,zh}.json  插件列表页的显示名与简介（meta.title / meta.description），不进模型上下文
icon.svg             插件列表页图标（按真实渲染器 resvg 出图核对，尺寸 36×36 viewBox）
scripts/dev.sh       薄壳：把参数转给仓库根的共享自测脚本 ../scripts/dev.sh
docs/DEVELOPMENT-LOG.md  设计决策与全部踩坑记录（改设计前先读）
```

依赖方向单向：`index → convert → {run, env, errors}`。`setup` 只经 `index` 注入的 runtime 被 `convert` 调用。

## 2. 命令

```bash
pnpm test                    # 单元测试（离线，66 个用例，fixture 模拟 mdcli）
pnpm run check               # 隔离 DSH_HOME 启动真实 host，断言 md_article 已注册
pnpm run check:installed     # 追加校验安装副本的文件集
pnpm run dev:boot            # 隔离 dsh web（OS 分配端口、不打开浏览器），人工看 UI
pnpm run dev:dump            # 打印组合后的 profile 树中本项目那一行
pnpm run clean               # 停掉隔离进程并删除 .dev/
```

隔离沙箱在仓库根 `.dev/`（已 gitignore）。自测实现全部在仓库根的 `../scripts/dev.sh`，本目录的 `scripts/dev.sh` 只是薄壳；`~/.dsh` 守卫、`pnpm` 版本缓存清理、安装副本比对都在共享脚本里。`check` 断言的工具名来自 `package.json` 的 `dsh.tools`——**改名 `md_article` 时必须同步这个声明**，否则自测会对着旧名字断言。

交付到用户 profile（**跨工作区写入，需用户授权**，且之后再重启宿主）。优先用 `dsh plugin`，它会同步 `dsh.profile.bundles`，省掉手动改 `package.json`：

```bash
rm -rf ~/.dsh/profiles/web/node_modules/dsh-omni-article-markdown   # pnpm 会按版本号复用旧拷贝
dsh plugin --profile web add "$HOME/work/projects/dsh-plugins/dsh-omni-article-markdown"
# 等价的手动写法（需要自己把包名加进 bundles）：
#   cd ~/.dsh/profiles/web && pnpm add "file:$HOME/work/projects/dsh-plugins/dsh-omni-article-markdown"
```

### 安装 spec 只允许这几种

本仓库是「一仓库多插件」，插件位于子目录，所以**不能**用 `github:<owner>/<repo>` 直接安装（根目录没有 `package.json`）。合法写法：

| spec | 说明 |
|---|---|
| `dsh-omni-article-markdown` / `…@latest` | npm registry（发布后可用，`dsh plugin` 会做安装前预检） |
| `https://github.com/caol64/dsh-plugins/releases/download/v<ver>/dsh-omni-article-markdown-<ver>.tgz` | Release tar 包，由 `.github/workflows/release.yml` 构建 |
| `./相对路径`、`file:$HOME/…` | 克隆后的本地子目录（装成 `link:`，**路径不能删/移**） |
| `github:caol64/dsh-plugins#path:/dsh-omni-article-markdown` | 唯一合法的 git spec，子目录必须走 `#path:` |

**`github:caol64/dsh-plugins/dsh-omni-article-markdown` 是错的**：pnpm 会把整个路径当仓库名，报 `ERR_PNPM_GIT_RESOLVE_FAILED`。不要在任何文档里恢复这种写法，也不要假设 pnpm 支持 `<owner>/<repo>/<subdir>`。

发版：改 `package.json` 的 `version` 并推到 `main`，workflow 会跑测试、`pnpm pack`、创建/更新 `v<version>` Release。`package.json` 的 `files` 白名单决定 tar 包内容，新增运行时文件必须同步进去。

## 3. 本项目专属红线

1. **`inject` 只能有 `tools`**。`skills`、`i18n`、`workingDirectory`、`effect` 一律通过 `optional(ctx, key)` 读取。
2. **禁止恢复 skill 注册**，也禁止重新引入 `src/skill.md`。
3. **截断逻辑属于 mdcli，不属于插件**。插件只负责把 `max_tokens` 转成 `--truncate N`（未请求时不传该参数），并用输出末尾的 `…[truncated]` 判定是否被截断。不要在插件里重新实现分块/计数。
4. **`save` 必须先落盘目录**。mdcli 只把“已存在的目录”当目录，否则会把路径当文件名写出；`resolveSaveTarget()` 负责 `mkdir -p`，不要绕过它直接把参数透传给 mdcli。
5. **`index.mjs` 保持薄**。业务逻辑放 `src/` 对应文件；入口抛异常会导致插件激活失败。
6. **错误必须翻译成可行动文案**（`errors.mjs`），不要把原始 stderr 直接抛给模型。

## 4. 领域约束

- **mdcli ≥ 0.2.4** 才有 `--truncate`。低于该版本且请求截断时，应给出升级指令而不是降级或传未知参数。
- 动态渲染站点由 mdcli 自行切换浏览器；插件只在报错提示缺 Chromium 时补装一次并重试。
- 重试策略：超时 / SSL / 连接类各重试 **一次**；提取失败不重试。
- 自动安装只走隔离环境（pipx / uv tool / pip --user），不污染系统 Python。

## 5. 改动后同步

- 配置键或对外行为变化 → 同时更新 `README.md`、`cordis.patch.yml` 注释、`docs/DEVELOPMENT-LOG.md`。
- 新的踩坑经验 → 追加到 `docs/DEVELOPMENT-LOG.md` 第 4 节，并在测试里补一条能复现它的用例。
