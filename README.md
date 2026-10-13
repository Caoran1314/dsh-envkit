# dsh-envkit 🔧

**DeepSeek Harness 环境工具插件**：在"某类操作莫名失败"时先探明环境，而不是猜。

三个工具都来自真实事故的沉淀（详见 [为什么](#为什么有这三个工具)）。

---

## 工具

### `env_probe` — 一次性探明环境

| 探什么 | 为什么 |
|---|---|
| 网络端点可达性（npm / GitHub API / raw / codeload / jsDelivr / PyPI） | 某个源不通时，换另一个（如 API 限流就改走 codeload tarball） |
| 代理环境变量 | 用户开了代理但工具没继承时，症状会伪装成"服务挂了" |
| 临时目录 / 家目录 / 当前目录可写性 | 安装器或包管理器报 `拒绝访问` 时先确认到底哪里不可写 |
| **子进程管道 spawn 能力** | 受限沙箱下 Node `spawn(stdio:'pipe')` 会 `EPERM`，表现为"命令莫名跑不起来" |
| 平台 / Node 版本 | 版本相关的坑很多 |

返回里还带 `hints`——按探测结果给出针对性建议，而不是丢一堆原始数据。

### `safe_json_edit` — 无 BOM 安全改写 JSON

DSH 的头号杀手：**profile 的 `package.json` 被写入 UTF-8 BOM**，之后 `dsh plugin` 全命令报
`SyntaxError: Unexpected token '﻿'`。

本工具：读取时**容忍 BOM**，写回时**保证无 BOM、原子替换**，默认**留一份备份**，并支持点路径操作：

```jsonc
{
  "file": "C:\\Users\\you\\.dsh\\profiles\\desktop\\package.json",
  "set": { "dsh.profile.bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-edict"] },
  "del": ["dependencies.something-old"]
}
```

`{"inspectOnly": true}` 只检查（是否带 BOM、能否解析、缩进与换行风格），不改文件。

### `git_repair` — `.git` 元数据丢失检测与重建

`.git/objects` 和 `refs` 还在、但 `HEAD` / `config` / `index` 被删时，git 会报
`not a git repository`。本工具识别这种状态（`metadata-lost-objects-intact`）并给出重建步骤：

```
git init → git branch -M main → git remote add origin <remote>
→ git fetch origin → git reset --mixed origin/main   # 保留工作区改动
```

**默认 `dryRun: true`**，只列命令不执行；确认后传 `dryRun: false`。

---

## 安装

```bash
dsh plugin --profile desktop add dsh-envkit
```

装完**重启 DSH**：设置页会出现「环境工具」面板（可视化展示探测结果 + 一键检查本机各 profile 的 BOM 与 bundles 状态）。

无 UI 时也可用命令：`env-probe`、`env-json-check <file>`、`env-git-check [dir]`。

## 设置页面板

- 网络端点可达性（✓/✗ + 状态码 + 耗时）
- 运行环境（子进程管道、各目录可写性、代理变量）
- 提示（按探测结果生成）
- **「检查我的 profile」**：只读列出每个 profile 的 `hasBom`、`bundles/deps` 数量、以及"已装但未启用"的插件

---

## 为什么有这三个工具

这份插件的每一条都对应本仓库作者真实踩过的坑：

| 事故 | 症状 | 对应工具 |
|---|---|---|
| profile 被写入 BOM | `dsh plugin` 全命令 `SyntaxError` | `safe_json_edit` |
| 沙箱剥离 TLS 凭据 / 限制命名管道 | `schannel: SEC_E_NO_CREDENTIALS`、`spawn EPERM` | `env_probe` |
| GitHub API 匿名限流 60/h | 安装/探测报"无法安装"，但插件本身没问题 | `env_probe`（提示改走 codeload） |
| `.git` 元数据被删 | `not a git repository`，但 objects/refs 都在 | `git_repair` |

## 安全边界

- `env_probe` **只做只读探测**（GET 请求 + 临时文件写入后立即删除）
- `safe_json_edit` 会**改文件**，因此：默认备份、原子写、支持 `inspectOnly`
- `git_repair` 默认 `dryRun`，且只做 init/fetch/reset（**不删任何东西**）

## 开发

```bash
npm test          # 契约测试 + 冒烟测试
npm run contract  # 只跑契约测试（校验 dsh.bundle / dsh.client / exports 成对 / 路由存在）
```

契约测试与 [`dsh-plugin-authoring`](https://github.com/Caoran1314/dsh-edict) 技能里的范式一致。

## License

MIT
