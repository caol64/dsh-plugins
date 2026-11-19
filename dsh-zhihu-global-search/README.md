---
description: "A DeepSeek Harness plugin that exposes the Zhihu Open Platform global search API as the native zhihu_global_search tool, with a settings page that keeps the Access Secret in the harness credential store."
---

# dsh-zhihu-global-search

把知乎开放平台的**全网搜索**（`GET /api/v1/content/global_search`）注册为 DSH 原生工具 **`zhihu_global_search`**，并在 **设置 → 知乎全网搜索** 提供一个只做一件事的设置页：填写 / 替换 / 移除 **Access Secret**。

密钥遵循 DSH 的安全准则——**配置不放明文，也不占用共享凭据文档**：设置页写入的是**本插件自己的存储目录**
`<DSH_HOME>/storages/dsh-zhihu-global-search/secret.json`（目录 `0700`、文件 `0600`、原子写），
不会写入 `~/.dsh/.credentials.yaml`；卸载插件时删掉这个目录，密钥就一起消失。
环境变量 `accessSecretEnv`（默认 `ZHIHU_ACCESS_SECRET`）保留为**只读回退**，存储里的值优先。

## 功能

- 一个工具，一次搜索，返回结构化结果（标题 / 链接 / 摘要 / 作者 / 时间 + 上游原始对象），失败一律翻译成"下一步该做什么"。
- 参数：`query`（必填）、`count`（1–20，越界钳制）、`filter`（上游过滤表达式，原样透传）、`search_db`（`all`/`realtime`/`static`）、`max_chars`（渲染文本预算）。
- 设置页：密码输入框 + 保存 / 移除，状态只显示"是否已配置、来源、是否可写"，**任何接口都不返回值**。
- 浏览器与宿主之间只有一条 exact Fetch 路由（`POST /api/dsh-zhihu-global-search/settings`），Client 半只依赖平台种子模块，不会因模块表缺失导致 `web boot` 失败。
- 零运行时依赖；Host 半与 Client 半都在同一个包里。

## 安装

本仓库是"一仓库多插件"，插件位于子目录。合法安装方式（用 pnpm / `dsh plugin`，不要用 npm）：

```bash
# 1) 清掉可能被 pnpm 版本缓存而复用的旧拷贝
rm -rf ~/.dsh/profiles/web/node_modules/dsh-zhihu-global-search

# 2) 安装（会同步 dsh.profile.bundles）
dsh plugin --profile web add "$HOME/work/projects/dsh-plugins/dsh-zhihu-global-search"

# 3) 重启宿主（正在运行的宿主不会加载新代码；Client 半也要靠重启后的客户端扫描生效）
```

安装到 `~/.dsh/profiles/<profile>` 属于跨工作区写入，请自行确认。卸载：

```bash
dsh plugin --profile web remove dsh-zhihu-global-search
```

## 配置密钥（两种方式，任选）

**方式一（推荐）：设置页。** 重启后打开 **设置 → 知乎全网搜索**，粘贴 Access Secret 并保存。密钥进入本插件自己的存储
（`<DSH_HOME>/storages/dsh-zhihu-global-search/secret.json`，页面底部会显示实际路径），不写入任何 `cordis.patch.yml`、
不写入 `~/.dsh/.credentials.yaml`、不进日志、不进工具输出；下次搜索立即生效，无需重启。

若要彻底清除：点「移除」，或直接删除该目录。

- 输入框始终是空的：它只显示"已配置（来源：…）"或"尚未配置"。
- 若该密钥来自环境变量，输入框只读并注明来源；要在这里修改，先取消环境变量再重启。

**方式二：环境变量。** 在启动 DSH 的环境里 `export ZHIHU_ACCESS_SECRET=…`。存储值优先于环境变量。

Access Secret 在 <https://developer.zhihu.com> 申请。`accessSecretEnv` 只允许是 POSIX 标识符；在配置里写 `accessSecret`、`apiKey` 之类的键会在**激活期直接报错**——这是刻意的，防止明文进配置。

### 可选配置

在 profile 的 `cordis.patch.yml` 里覆盖，只列要改的键（config 是**替换**语义，不是深合并）：

```yaml
- id: zhihu-global-search
  config:
    accessSecretEnv: ZHIHU_TEAM_SECRET   # 默认 ZHIHU_ACCESS_SECRET
    baseURL: https://developer.zhihu.com # 网关/代理；激活期校验 http(s)
    timeoutMs: 30000                     # 单次请求超时
```

## 工具行为

| 场景 | 行为 |
|---|---|
| 未配置密钥 | 不发请求，提示去设置页或设置环境变量 |
| `query` 空白 / `search_db` 非法 | 参数错误，模型可自纠 |
| `count` 越界 | 钳制到 1–20 并警告 |
| 401 / Code 20001 | 鉴权失败：提示重新填写密钥，**不重试** |
| 429 / Code 30001、30002 | 额度或限频：提示可能已用尽，**不重试** |
| Code 30003 | 风控：**不重试** |
| 超时 / 网络 / 5xx | **重试一次** |
| 非 JSON 响应 | 归类上游异常，只保留脱敏前缀 |
| `Code === 0` 但结构不认识 | 原始 `Data` 作为 `items[0].raw` 保留，附警告，绝不丢数据 |
| 调用被取消 | 透传取消，不算上游故障 |

每次调用按次计费并消耗知乎每日免费额度；工具描述里已要求模型优先用一次精准查询。

## 输出

```json
{
  "query": "...", "count": 10,
  "items": [{ "title": "...", "url": "...", "snippet": "...", "author": "...",
              "published_at": "2026-05-11T10:17:11.000Z", "raw": { } }],
  "has_more": true, "truncated": false, "warnings": []
}
```

`raw` 永远保留上游原始对象；渲染文本在 `max_chars` 预算内按条目边界截断，并置 `truncated: true`。

## 开发与自测

```bash
pnpm test                 # 离线单测（fetch 替身 + 真实 React 渲染设置页，不联网）
pnpm run check            # 隔离 DSH_HOME 启动 headless 宿主，断言工具已注册
pnpm run check:installed  # 追加校验安装副本文件集
pnpm run dev:boot         # 隔离 dsh web（OS 分配端口、不打开浏览器），人工看设置页
pnpm run dev:dump         # 打印组合后的 profile 树中本项目那一行
pnpm run clean            # 停掉隔离进程并清理 .dev/
```

自测实现（隔离 `DSH_HOME`、`~/.dsh` 守卫、pnpm 缓存清理、安装副本比对）在仓库根的共享脚本 [`../scripts/dev.sh`](../scripts/dev.sh)，本目录的 `scripts/dev.sh` 只是转参薄壳；隔离沙箱在仓库根 `.dev/`（已 gitignore），不会碰 `~/.dsh`。`check` 断言的工具名来自 `package.json` 的 `dsh.tools`。项目专属规则见 [AGENTS.md](AGENTS.md)，设计决策与踩坑见 [docs/DEVELOPMENT-LOG.md](docs/DEVELOPMENT-LOG.md)。

## 已知限制

- **请求/响应字段名来自二手资料**：官方文档站是 JS 渲染的，本插件按 `Query`/`Count`/`Filter`/`SearchDB` 与 `Code`/`Message`/`Data` 实现，并把所有命名集中在 `src/endpoint.mjs` 与 `src/respond.mjs` 的候选表里。若真实接口命名不同，只需改这两处，工具契约不变。
- 只实现 `global_search` 一个端点；知乎站内搜索、热榜、直答不在本插件范围内。
- 不做本地额度计数（避免与平台真实额度产生偏差），只在额度错误文案里提示。
- `has_more` 无游标时不会发明翻页参数。

## 许可

MIT。