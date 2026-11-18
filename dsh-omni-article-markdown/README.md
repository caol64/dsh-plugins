# dsh-omni-article-markdown

DeepSeek Harness 插件，把 [墨探 / omni-article-markdown](https://github.com/caol64/omni-article-markdown) 这个纯提示词 skill 变成一项原生能力。

它只提供一样东西：**`md_article` 工具**。一次调用即可把网页 URL（或本地 HTML 文件）转换为干净的 Markdown。插件会定位或安装 `mdcli`、按工作目录解析相对路径、透传 `--truncate` / `--save` / `read` 参数、在瞬时故障时重试一次，并把 mdcli 的 stderr 翻译成可操作的指引。

插件**不注册 skill**。原版 skill 只是一组加载进模型上下文的固定指令，这部分行为如今已经落在代码里，再注册一个 skill 条目只会重复工具描述。一个“列出来但从不加载”的 skill 白白占用目录空间，一个“加载进来”的 skill 则白白消耗上下文。

## 安装

本插件是一个带 bundle patch（`dsh.bundle.patch`）的包，因此安装方式与其他 DSH 插件相同，**推荐使用 `dsh plugin add`**。

本仓库 [caol64/dsh-plugins](https://github.com/caol64/dsh-plugins) 按“每个子目录一个插件”组织，插件本体在 `dsh-omni-article-markdown/` 子目录中。pnpm 支持**仓库的子目录路径**语法 `<owner>/<repo>/<subdir>`，直接把这段路径当作包名安装即可，无需先克隆仓库。

### 方式一：`dsh plugin add`（推荐）

```bash
# 从 GitHub 仓库安装（无需克隆）
dsh plugin --profile web add "github:caol64/dsh-plugins/dsh-omni-article-markdown"

# 或已克隆到本地时，从子目录安装（相对路径按当前目录解析）
dsh plugin --profile web add "./dsh-plugins/dsh-omni-article-markdown"
```

`dsh plugin` 会：初始化 profile（首次运行时）、在该 profile 目录内调用 pnpm 安装、检查版本兼容性，并**自动把这个 bundle 追加进 `dsh.profile.bundles`**——因此上面的手动改 `package.json` 步骤可以完全跳过。随后重启宿主并刷新页面即可。

要点：

- `--profile <name>` 是 `dsh plugin` 的**必填参数**，用来指定插件装到哪个 app 的 profile。**应用名就是 profile 名**：装到 Web GUI 用 `web`，CLI 用 `tui`，一次性任务用 `headless`。
- 写在子命令 `add` **前面**；`dsh plugin add --profile web …` 不是有效写法。
- 路径参数建议加引号，避免 shell 展开。不带 `.` 前缀的 `~/…` 不会被 pnpm 展开，请写绝对路径或 `$HOME`。
- 安装成功后 `package.json` 里应出现依赖项，bundle 列表末尾多出 `dsh-omni-article-markdown`：

  ```json
  {
    "dependencies": { "dsh-omni-article-markdown": "github:caol64/dsh-plugins/dsh-omni-article-markdown" },
    "dsh": {
      "profile": {
        "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-omni-article-markdown"]
      }
    }
  }
  ```

### 方式二：手动 pnpm + 编辑 bundle 列表

不使用 `dsh plugin` 时，需要自己完成同样两件事：

```bash
# 从 GitHub 仓库安装（无需克隆）
cd ~/.dsh/profiles/web
pnpm add "github:caol64/dsh-plugins/dsh-omni-article-markdown"

# 或先克隆仓库，再从本地子目录安装
git clone https://github.com/caol64/dsh-plugins.git
cd ~/.dsh/profiles/web
pnpm add "file:$HOME/dsh-plugins/dsh-omni-article-markdown"
```

然后在 `~/.dsh/profiles/web/package.json` 的 bundle 列表里手动加入 `dsh-omni-article-markdown`：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-omni-article-markdown"
      ]
    }
  }
}
```

再重启 `dsh web`（或你使用的客户端）并刷新页面。

两种来源的区别：`file:` 安装会把整个插件目录拷进 profile 的 `node_modules`，因此**本机克隆路径变动后需要重新安装**；`github:` 方式由 pnpm 托管，重装即可拉到最新提交。

> 目前插件**未发布到 npm**，直接写包名安装会在 registry 中报 404，请始终使用上面的 `github:` 或 `file:` 形式。

### 环境要求与生效确认

环境要求：DSH `0.2.x`（声明为 `engines.dsh: >0.2.0-0 <0.2.2 || >=0.2.2-0 <0.3.0`）。dsh 把 `engines.dsh` 作为唯一的兼容门禁，**范围不匹配的 bundle 会被静默跳过**——普通的 `>=0.2.1` 永远匹配不到 `0.2.2-rc.1` 这类预发布版本。`dsh plugin` 在安装时会预检兼容性，拒绝时会提示用 `dsh plugin --profile web allow-version … --accept-risk` 显式放行（请谨慎使用）。新会话的工具集中应能看到 `md_article`。

### 更新与卸载

```bash
# 更新到默认分支最新提交（重新拉取后重启宿主）
dsh plugin --profile web add "github:caol64/dsh-plugins/dsh-omni-article-markdown"

# 卸载（同时从 bundle 列表移除）
dsh plugin --profile web remove dsh-omni-article-markdown
```

手动 pnpm 方式下，对应的更新/卸载命令相同，但需要自己从 bundle 列表中删除条目。

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