# gmail-mcp

把 Gmail 接到 AI 助手上。多个账号同时连，服务器是自己的。

[![MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/runs%20on-Cloudflare%20Workers-F38020?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/workers/)
[![MCP](https://img.shields.io/badge/protocol-MCP-6E56CF)](https://modelcontextprotocol.io/)
[![23 tools](https://img.shields.io/badge/tools-23-0b7285)](#能做什么)
[![tests](https://img.shields.io/badge/tests-66_passing-success?logo=bun&logoColor=white)](#开发)

*[English README](./README.md) · [日本語版](./README.ja.md)*

<p align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./docs/demo.zh-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="./docs/demo.zh-light.svg">
  <img src="./docs/demo.zh-light.svg" alt="助手先查工作和个人两个邮箱，再带着盖章的附件回复" width="760">
</picture>
</p>

**gmail-mcp** 把 Gmail 接到 Claude 和其他 [MCP](https://modelcontextprotocol.io/) 客户端上。它能**搜索和阅读**邮件，**发送、全部回复**并带上引用，**转发**，处理**附件和内嵌图片**，管理草稿、标签和会话，而且这些都可以**在多个 Google 账号上同时进行**。

它跑在**你自己的 Cloudflare Worker** 上，所以笔记本上的 Claude Code、浏览器里的 claude.ai、手机上的 Claude 连的是同一个地址。每个连接登录一个 Google 账号，刷新令牌留在**你自己的** Cloudflare 账号里。

来这里的人通常有两个理由。Claude 和 Google 自带的 Gmail 连接器能读信、能写草稿，但**发不出去**，而且一个助手账号只能绑一个 Google 账号。能发信的实现大多是本机进程，坐在电脑前好用，手机上够不着。

---

## 和其他方案的对比

<p align="center">
<img src="./docs/comparison-zh.svg" alt="gmail-mcp 与官方连接器、google_workspace_mcp、Gmail-MCP-Server 的对比" width="880">
</p>

<details>
<summary><b>更详细的对比</b> — 六个项目，十二项</summary>

<br>

| | **gmail-mcp** | [Claude](https://claude.com/connectors/gmail) · [Google](https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server) 官方 | [taylorwilsdon/<br>google_workspace_mcp](https://github.com/taylorwilsdon/google_workspace_mcp) | [ArtyMcLabin/<br>Gmail-MCP-Server](https://github.com/ArtyMcLabin/Gmail-MCP-Server) | [shinzo-labs/<br>gmail-mcp](https://github.com/shinzo-labs/gmail-mcp) | [aaronsb/<br>google-workspace-mcp](https://github.com/aaronsb/google-workspace-mcp) |
| :-- | :-: | :-: | :-: | :-: | :-: | :-: |
| 运行环境 | Cloudflare Workers | 厂商托管 | 自建服务器或本机 | 本机 | 本机 | 本机 |
| 手机上能用 | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| 多账号同时连 | ✅ 每个连接绑定一个 | ❌ | ✅ 调用时指定 | ❌ 仅别名 | ❌ | ✅ 调用时指定 |
| 发送邮件 | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ |
| 附件与 `cid:` 内嵌图片 | ✅ | 未公开 | ✅ | ✅ | ❌ | ✅ |
| 全部回复并引用原文 | ✅ | ❌ | 仅草稿 | 不带引用 | ❌ | ✅ |
| 转发 | ✅ | ❌ | ✅ | ❌ | ❌ | ✅ |
| 按各部分声明的字符集解码 | ✅ | — | ❌ 一律当 UTF-8 | ❌ 一律当 UTF-8 | ❌ | ❌ |
| 拒绝 CRLF 头注入 | ✅ | — | ✅ 框架层 | ✅ 过滤 | ❌ **无** | ✅ |
| 邮箱设置（过滤器、休假回复） | ❌ 不在授权范围 | ❌ | 过滤器 | 过滤器 | ✅ | ❌ |
| 工具数量 | 23 | 11–16 | 14（Gmail 部分） | 30 | 64 | 11 |
| 刷新令牌在谁手里 | 自己 | 厂商 | 自己 | 自己 | 自己 | 自己 |

[`google_workspace_mcp`](https://github.com/taylorwilsdon/google_workspace_mcp) 是这一类里最完整的项目。它覆盖整个 Workspace 而不只是 Gmail，还能附上 Gmail 签名、直接从 URL 取附件，这两点 gmail-mcp 没有做。[`shinzo-labs/gmail-mcp`](https://github.com/shinzo-labs/gmail-mcp) 用 64 个工具覆盖到休假回复、代理访问和 S/MIME；这些都属于 `gmail.settings.*`，而 gmail-mcp 从不申请这个范围，所以无论授权怎么流失，它们都够不到。

剩下的差别主要来自两处设计。用调用参数指定账号，意味着一份授权能碰到所有已连接的邮箱；把邮箱绑在连接上，参数写错也就什么都碰不到。读取那边，本机方案把每一部分都按 UTF-8 解码，ISO-2022-JP、GB2312 这类邮件会变成乱码，而 Gmail 存成附件的长正文会读出空白。

</details>

---

## 部署

大约十分钟，多数时间花在两个网页控制台上。需要一个绑好域名的 Cloudflare 账号、[bun](https://bun.sh)，以及一个 Google 账号。

### 1 · 建一个 Google OAuth 客户端

```sh
PROJECT="gmail-mcp-$(openssl rand -hex 3)"
gcloud auth login
gcloud projects create "$PROJECT" --name="gmail-mcp"
gcloud config set project "$PROJECT"
gcloud services enable gmail.googleapis.com
```

接下来两步 Google 没有提供 API，只能在控制台里点：

- **OAuth 同意屏幕** → *External*。应用没过审之前，把要连的邮箱都加到**测试用户**里。
- **凭据 → 创建凭据 → OAuth 客户端 ID** → *Web 应用*，把 `https://<你的域名>/callback` 填进已获授权的重定向 URI。记下客户端 ID 和密钥。

### 2 · 部署 Worker

```sh
git clone https://github.com/mkpoli/gmail-mcp && cd gmail-mcp
bun install
# 在 wrangler.jsonc 里把 `name` 和 routes 的 `pattern` 改成你的域名
bun run setup
```

`bun run setup` 会建好 KV 命名空间，问你要客户端 ID 和密钥，生成 Cookie 密钥，然后部署。只想换一个密钥时重跑它也没问题。

### 3 · 连接客户端

客户端 ID 和密钥那两栏留空，MCP 客户端会自己注册。

```sh
claude mcp add --transport http gmail-personal https://<你的域名>/mcp
claude mcp add --transport http gmail-work     https://<你的域名>/mcp/work
```

在 Claude Code 里执行 `/mcp`，分别用对应的 Google 账号登录。claude.ai 那边是**设置 → 连接器 → 添加自定义连接器**，填同一个地址。`/mcp/` 后面可以跟任意一级标签，有些客户端不接受两个地址相同的服务端，这样一个部署照样能带多个邮箱。

部署好的首页 `https://<你的域名>/` 就是这份说明。

---

## 能做什么

**读** — `whoami` · `search_messages` · `get_message` · `get_thread` · `get_attachment`

**写** — `send_message` · `reply_all` · `forward_message` · `create_draft` · `update_draft` · `send_draft` · `delete_draft` · `list_drafts`

**整理** — `list_labels` · `create_label` · `update_label` · `delete_label` · `modify_labels` · `modify_thread_labels` · `batch_modify_messages` · `trash_message` · `untrash_message` · `trash_thread` · `untrash_thread`

发出去的邮件结构和普通邮件客户端一样：纯文本配一份 HTML，附件，用 `cid:` 引用的内嵌图片，嵌套成 `multipart/mixed › multipart/related › multipart/alternative`。主题和显示名走 RFC 2047，文件名走 RFC 2231，中文、日文和 emoji 都能原样送到。

`reply_all` 读原信的 `Reply-To`、`From`、`To`、`Cc`，去掉你自己的地址，接上 `References` 链，并在纯文本和 HTML 两边都引用原文。`forward_message` 会重现转发信头，也可以把原信的附件一并带上。

读取这边设了上限。正文和会话按字符数、附件按大小截断，一条几百封的邮件列表不会把助手的上下文塞满。

---

## 使用的技术

- **[TypeScript](https://www.typescriptlang.org/) / [Cloudflare Workers](https://developers.cloudflare.com/workers/)** — 每个 MCP 会话一个 Durable Object，OAuth 授权存在 KV 里
- **[Hono](https://hono.dev/)** — OAuth 各端点、Google 回调和 `/` 首页的路由
- **[`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider)** — 供 MCP 客户端注册的 OAuth 2.1 服务端
- **[`agents`](https://github.com/cloudflare/agents)** — `McpAgent`，跑在 Durable Object 上的 MCP 传输层
- **[`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk)** 配 **[Zod](https://zod.dev/)** — 工具定义和参数校验
- **[Bun](https://bun.sh/)**、**[Biome](https://biomejs.dev/)**、**[Wrangler](https://developers.cloudflare.com/workers/wrangler/)** — 安装、测试、检查、部署

Gmail 本身用原生 `fetch` 直接调 [REST API](https://developers.google.com/workspace/gmail/api/reference/rest)。官方的 `googleapis` SDK 以 Node 为前提，装进 Worker 太重，所以邮件组装、MIME 解析和令牌刷新都写在 `src/gmail.ts` 和 `src/utils.ts` 里。

---

## 谁可以登录

由 `ALLOWED_EMAILS` 决定，比对的是 Google 返回的已验证地址，在同意屏幕之后、授权发出之前判断。

| 值 | 谁能进 |
| :-- | :-- |
| *(空)* | 谁都不行 |
| `you@gmail.com, work@company.com` | 只有这些账号 |
| `*@company.com` | 该域名下所有人 |
| `*` | 任何已验证的 Google 账号 |

一份授权只能碰到通过它登录的那个邮箱，所以放宽这份名单，不会扩大已连接邮箱的可达范围。设成 `*` 之后交给陌生人的，是你这个部署和你的 Google 客户端配额，用在他们自己的邮件上。

---

## 限制

为了不让公开的部署被用光，设了两个上限，都在 `wrangler.jsonc` 的 `vars` 里改。

| 设置 | 默认值 | 限制什么 |
| :-- | :-- | :-- |
| `MAX_ACCOUNTS` | `25` | 允许登录的 Google 账号总数。到上限后已连接的照常工作，只有新账号被拒。Google 对未审核应用的上限是 100 个用户，留在这之下。 |
| `CALLS_PER_MINUTE` | `120` | 单个账号每分钟能调用 Gmail 的次数，跨会话合并计算。 |

改完重新部署。限流由 Cloudflare 那边实现，所以 `unsafe.bindings` 里的 `limit` 要一起改成同一个值。个人使用保持默认即可。

---

## 安全

自己托管只是把信任换了个地方，并没有取消它，所以这里写清楚东西都在哪。

- **令牌留在你手里。** 刷新令牌加密后放在 OAuth 授权信息里，存进你自己的 KV 命名空间；有效期一小时的访问令牌放在会话的 Durable Object 里。邮件正文哪里都不存，只是流过去。
- **一个会话对应一个邮箱。** MCP 会话绑定在开启它的账号上，拿到别人的会话 ID 也操作不了别的邮箱。
- **授权范围压到最小。** `gmail.modify` 覆盖读取、发送、标签和回收站，不含彻底删除，也不含 `gmail.settings.*`。自动转发和过滤器外泄这两条常见后门，本来就在权限之外。
- **恶意邮件塞不进信头。** 发信头的值拒绝 CR 和 LF，正文里藏的指令即使驱动了模型，也加不上一个隐蔽的 `Bcc`。媒体类型会校验，引用部分会做 HTML 转义。
- **撤销是有效的。** 收紧 `ALLOWED_EMAILS` 可以挡住新的登录；在 [myaccount.google.com/connections](https://myaccount.google.com/connections) 撤销应用授权；重置 Google 客户端密钥可以一次性作废所有授权。

处理请求时 Worker 会在内存里解密邮件，做中继就避不开这一点。如果某个邮箱不能接受这一条，那个账号用本机的 MCP 服务端更合适。

---

## 测试

66 个单元测试覆盖邮件组装（MIME 嵌套、RFC 2047 折行、RFC 2231 文件名、CR/LF 拒绝、base64 换行）、跨字符集的正文提取、回复与转发的组装、Google 的令牌流程，以及登录名单的判定。

除此之外，每个工具都在真实的 Gmail 账号之间跑过，并由另一个账号核对收到的结果：

| 项目 | 结果 |
| :-- | :-- |
| 编码 | 日文主题折成多个 encoded word 后复原；emoji、ZWJ、阿拉伯语、组合符号和生僻汉字原样往返 |
| 附件 | 名为 `请求书.csv` 的文件发出、送达、再下载后逐字节一致；`cid:` 内嵌图片在收件方显示正常 |
| 会话 | `reply_all` 把原发件人放进收件人，保留第三方 `Cc`，去掉自己的地址，并在同一会话里引用原文 |
| 双账号 | 两个账号同时连到一个部署；一个账号的邮件 ID 在另一个账号上返回 `404` |
| 整理 | 建了一个嵌套的中日文标签，改名、批量应用、删除；会话和单封邮件的回收站操作都能撤回 |
| 规模 | 一个一万五千封邮件的邮箱，用 Gmail 搜索语法和分页查询，没有触发限流 |

---

## 开发

```sh
bun run dev     # wrangler dev，:8788
bun run check   # biome + tsc
bun test        # 66 个单元测试
bun run assets  # 重新生成明暗两套配图
bun run deploy
```

## 许可

Copyright © 2026 mkpoli，以 [MIT License](./LICENSE) 发布。

`src/workers-oauth-utils.ts` 来自 [cloudflare/ai](https://github.com/cloudflare/ai) 的 [remote-mcp-github-oauth 示例](https://github.com/cloudflare/ai/tree/main/demos/remote-mcp-github-oauth)，Copyright © 2025 Cloudflare, Inc.，依 MIT License 使用。详见 [THIRD-PARTY.md](./THIRD-PARTY.md)。
