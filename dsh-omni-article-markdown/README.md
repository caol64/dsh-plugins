# dsh-omni-article-markdown

DeepSeek Harness 插件，把 [墨探 / omni-article-markdown](https://github.com/caol64/omni-article-markdown) 这个纯提示词 skill 变成一项原生能力。

它只提供一样东西：**`md_article` 工具**。一次调用即可把网页 URL（或本地 HTML 文件）转换为干净的 Markdown。插件会定位或安装 `mdcli`、按工作目录解析相对路径、透传 `--truncate` / `--save` / `read` 参数、在瞬时故障时重试一次，并把 mdcli 的 stderr 翻译成可操作的指引。

插件**不注册 skill**。原版 skill 只是一组加载进模型上下文的固定指令，这部分行为如今已经落在代码里，再注册一个 skill 条目只会重复工具描述。一个“列出来但从不加载”的 skill 白白占用目录空间，一个“加载进来”的 skill 则白白消耗上下文。

## 安装

本插件是一个带 bundle patch（`dsh.bundle.patch`）的包，因此安装方式与其他 DSH 插件相同，**推荐使用 `dsh plugin add`**。

仓库 [caol64/dsh-plugins](https://github.com/caol64/dsh-plugins) 按「每个子目录一个插件」组织，插件本体在 `dsh-omni-article-markdown/` 子目录中。由于子目录不是仓库根，**不能**像单包仓库那样直接 `github:owner/repo` 安装；请从下表中选择一种方式：

| 方式 | 命令 | 适用场景 |
|---|---|---|
| **npm**（推荐） | `dsh plugin --profile web add dsh-omni-article-markdown` | 版本化、可回滚，安装前做兼容性预检 |
| **Release tar 包** | `dsh plugin --profile web add "<tarball URL>"` | 不想依赖 git，锁定某个版本 |
| **本地目录** | `git clone …` 后 `dsh plugin --profile web add "./dsh-plugins/dsh-omni-article-markdown"` | 要改代码、离线、或跟进最新提交 |

`dsh plugin` 会：初始化 profile（首次运行时）、在该 profile 目录内调用 pnpm 安装、检查版本兼容性，并**自动把这个 bundle 追加进 `dsh.profile.bundles`**——无需手动编辑 `package.json`。安装后重启宿主并刷新页面。

要点：

- `--profile <name>` 是 `dsh plugin` 的**必填参数**，用来指定插件装到哪个 app 的 profile。**应用名就是 profile 名**：装到 Web GUI 用 `web`，CLI 用 `tui`，一次性任务用 `headless`。
- 写在子命令 `add` **前面**；`dsh plugin add --profile web …` 不是有效写法。
- 路径/URL 建议加引号，避免 shell 展开。不带 `.` 前缀的 `~/…` 不会被 pnpm 展开，请写绝对路径或 `$HOME`。

### 方式一：从 npm 安装（推荐）

```bash
dsh plugin --profile web add dsh-omni-article-markdown
```

安装成功后 `package.json` 里应出现依赖项，bundle 列表末尾多出 `dsh-omni-article-markdown`：

```json
{
  "dependencies": { "dsh-omni-article-markdown": "^0.1.0" },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-omni-article-markdown"]
    }
  }
}
```

> 发布者：本仓库使用 `registry.npmmirror.com` 镜像，镜像不支持发布，请显式指定官方源：
> `pnpm publish --registry https://registry.npmjs.org --access public`。

### 方式二：从 GitHub Release 的 tar 包安装

每个版本都会在 [Releases](https://github.com/caol64/dsh-plugins/releases) 页附带 `dsh-omni-article-markdown-<version>.tgz`（由 `.github/workflows/release.yml` 构建，只含 `files` 白名单中的文件）：

```bash
dsh plugin --profile web add "https://github.com/caol64/dsh-plugins/releases/download/v0.1.0/dsh-omni-article-markdown-0.1.0.tgz"
```

也可以下载后传本地路径：

```bash
dsh plugin --profile web add "./dsh-omni-article-markdown-0.1.0.tgz"
```

代价：URL 里固定了版本，升级需要换 URL；tarball 不属于 registry spec，`dsh plugin` 的**安装前预检会被跳过**，兼容性检查在安装完成后才进行。

### 方式三：克隆仓库后从本地目录安装

```bash
git clone https://github.com/caol64/dsh-plugins.git
dsh plugin --profile web add "./dsh-plugins/dsh-omni-article-markdown"
```

相对路径按**执行命令时的当前目录**解析。这种方式装成 `link:`，指向克隆目录，之后 `git pull` 即拿到新代码——但这也意味着**克隆目录不能删或移动**。

> 也可以直接引用 git 仓库的子目录，但必须用 `#path:` 指定，**把子目录拼在仓库名后面是无效的**（pnpm 会把 `caol64/dsh-plugins/dsh-omni-article-markdown` 整体当成仓库名，报 `ERR_PNPM_GIT_RESOLVE_FAILED`）：
>
> ```bash
> dsh plugin --profile web add "github:caol64/dsh-plugins#path:/dsh-omni-article-markdown"
> ```

### 手动 pnpm + 编辑 bundle 列表

不使用 `dsh plugin` 时，需要自己完成同样两件事：

```bash
cd ~/.dsh/profiles/web
pnpm add dsh-omni-article-markdown                        # 或 tarball / file: 形式的 spec
```

然后在 `~/.dsh/profiles/web/package.json` 的 bundle 列表里手动加入 `dsh-omni-article-markdown`：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-omni-article-markdown"]
    }
  }
}
```

再重启 `dsh web`（或你使用的客户端）并刷新页面。卸载时除了 `pnpm remove`，还要手工删掉这条 bundle 条目。

### 环境要求与生效确认

环境要求：DSH `0.2.x`（声明为 `engines.dsh: >0.2.0-0 <0.2.2 || >=0.2.2-0 <0.3.0`）。dsh 把 `engines.dsh` 作为唯一的兼容门禁，**范围不匹配的 bundle 会被静默跳过**——普通的 `>=0.2.1` 永远匹配不到 `0.2.2-rc.1` 这类预发布版本。

`dsh plugin` 对 npm 包会在安装前预检兼容性，拒绝时提示用 `dsh plugin --profile web allow-version … --accept-risk` 显式放行（请谨慎使用）；tarball 与本地/git spec 只在安装完成后检查。新会话的工具集中应能看到 `md_article`。

### 更新与卸载

```bash
# npm：升级到最新版本
dsh plugin --profile web add dsh-omni-article-markdown@latest

# 本地目录：拉取新代码后重新安装（pnpm 会按版本号复用旧拷贝，先清掉）
git -C ~/dsh-plugins pull
rm -rf ~/.dsh/profiles/web/node_modules/dsh-omni-article-markdown
dsh plugin --profile web add "$HOME/dsh-plugins/dsh-omni-article-markdown"

# 卸载（同时从 bundle 列表移除）
dsh plugin --profile web remove dsh-omni-article-markdown
```

tarball 安装的升级方式是用新版本的 URL 再执行一次 `add`。任何方式更新后都需要重启宿主。

## 工具参数

| 参数 | 对应 | 说明 |
|---|---|---|
| `url`（必填） | 位置参数 | `http(s)://` URL 或本地 `.html` 路径；相对路径按工作目录解析 |
| `max_tokens` | `--truncate N` | 不传则输出全文。截断在 mdcli 内部按块边界完成，并以 `…[truncated]` 结尾；传 `800` 等同于 mdcli 的默认值 |
| `save` | `-s PATH` | 目录（文件名取自文章标题）或完整文件路径；`raw_html` 时忽略此项 |
| `no_verify_ssl` | `--no-verify-ssl` | 仅用于证书链损坏的场景 |
| `raw_html` | `read` 子命令 | 返回抓取到的原始 HTML；适合用来区分 JS 空壳页与真实页面 |
| `prettify` | `read -p` | 需配合 `raw_html` 使用 |

输出是一个结构化的规范对象（`markdown`、`saved_path`、`truncated`、`mode`、`warnings`）；模型看到的是 Markdown 正文，或一句“已保存到 …”的确认。

由插件负责的行为：

- **安装。** `mdcli` 缺失时，首次调用会依次尝试 `pipx install`、`uv tool install`、`python3 -m pip install --user`，且始终安装到隔离的工具环境中。可用 `allowInstall: false` 关闭。
- **版本门禁。** `--truncate` 需要 mdcli ≥ 0.2.4；对更早的版本给出明确的升级指引，而不是静默输出全文或抛出未知参数错误。
- **浏览器兜底。** 如果 mdcli 报告缺少 Playwright/Chromium，插件会把 Chromium 安装到 mdcli 自己的解释器中，并重试一次。
- **重试。** 超时、SSL 与连接类错误各重试**一次**；提取失败不重试。
- **取消。** abort 信号会终止 mdcli 子进程（先 `SIGTERM`，2 秒后 `SIGKILL`）。

## 配置

所有键都是可选的（`cordis.patch.yml` 中展示了默认值）：

| 键 | 默认值 | 含义 |
|---|---|---|
| `command` | `''` | `mdcli` 路径；为空时先探测 `PATH`，再探测 `~/.local/bin/mdcli` |
| `allowInstall` | `true` | 缺失时是否自动安装 mdcli |
| `installTimeoutMs` | `600000` | 自动安装 mdcli / Chromium 的超时时间 |
| `timeoutMs` | `120000` | 单次调用 mdcli 的超时时间（动态页面会启动浏览器，因此较长） |

在 `~/.dsh/profiles/web/cordis.patch.yml` 中覆盖：

```yaml
- id: omni-article-markdown
  config:
    allowInstall: false
```

配置对象是**整体替换**而非深合并：只列出你要修改的键，否则部分覆盖会把其余键静默重置为默认值（正因为如此，bundle patch 完全不携带 `config` 块）。

## 故障排查

| 现象 | 处理 |
|---|---|
| `mdcli 未安装…` | 执行 `pipx install omni-article-markdown`（或 `uv tool install omni-article-markdown`），或启用 `allowInstall` |
| `不支持 --truncate` | 升级：`uv tool upgrade omni-article-markdown` |
| `浏览器渲染不可用` | 使用 mdcli 自己的解释器执行 `python -m playwright install chromium`（即 `mdcli` 脚本首行指向的那个 python） |
| 提取失败 | 先试 `raw_html: true`；若 HTML 中没有正文文本，说明该站点是 JS 渲染的——正常调用，让浏览器兜底逻辑生效 |
| 输出混乱 | 在 <https://github.com/caol64/omni-article-markdown/issues> 反馈该 URL |

Docker 替代方案（本地无需 Python）：`docker run --rm caol64/omnimd <url>`。

## 开发

本仓库**只使用 pnpm**；不要使用 npm、yarn、bun 或 npx。完整规则见 [`../AGENTS.md`](../AGENTS.md)（通用插件规则）与 [`AGENTS.md`](AGENTS.md)（本项目规则）。

```bash
pnpm test                  # 单元测试：node --test，离线，用 fixture 模拟 mdcli
pnpm run check             # 隔离 DSH_HOME：启动真实宿主，断言 md_article 已注册
pnpm run check:installed   # 同上，并校验安装副本的文件集
pnpm run dev:boot          # 在 OS 分配端口上启动隔离的 `dsh web`，用于人工检查 UI
pnpm run dev:dump          # 打印组合后的 profile 树中本插件对应的一行
pnpm run clean             # 停止隔离进程并删除 .dev/
```

`pnpm run check` 不下载任何东西、不需要 API key、从不触碰 `~/.dsh`、从不占用 3080 端口，也不需要重启你正在使用的 Web GUI。它会针对隔离的 `DSH_HOME`（`.dev/home`，已 gitignore）启动 **headless** 应用，并断言 `md_article` 已进入宿主的工具注册表。`web` 应用只用于 `dev:boot`，因为它不会执行模型步，`agent/pre-step` 探针在那里永远不会触发。

`check` **不覆盖**的内容：工具在 Web GUI 中的渲染效果。交付到真实 profile 后请人工确认一次。

Peer 依赖（`@deepseek-ai/dsh-tools`、`@deepseek-ai/cordis` 等）由宿主提供；插件没有任何运行时依赖，也不需要安装步骤。

设计决策与开发中踩过的所有坑记录在 [`docs/DEVELOPMENT-LOG.md`](docs/DEVELOPMENT-LOG.md)。

## 许可证

MIT。转换行为改编自 omni-article-markdown 项目（MIT，© caol64）；`mdcli` 本身需单独安装。