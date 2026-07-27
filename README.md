# gmail-mcp

Connect Gmail to Claude and other AI assistants — several accounts at once, from a server you own.

[![MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/runs%20on-Cloudflare%20Workers-F38020?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/workers/)
[![MCP](https://img.shields.io/badge/protocol-MCP-6E56CF)](https://modelcontextprotocol.io/)

*[日本語版はこちら](./README.ja.md)*

The Gmail connectors built into Claude and Google can read your mail and write drafts, and they stop there — one Google account per assistant account, no sending. Assistants that do send usually run on your laptop, which puts them out of reach of your phone. gmail-mcp takes the third path: it deploys to Cloudflare Workers on your own domain, so your assistant reaches it from anywhere, and each connection signs in to its own mailbox. Work and personal live side by side, and your refresh tokens never leave your Cloudflare account.

---

## How it compares

| | **gmail-mcp** | [Claude](https://claude.com/connectors/gmail) · [Google](https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server) connectors | [google_workspace_mcp](https://github.com/taylorwilsdon/google_workspace_mcp) | [Gmail-MCP-Server](https://github.com/ArtyMcLabin/Gmail-MCP-Server) | [gmail-mcp](https://github.com/shinzo-labs/gmail-mcp) <sub>(shinzo-labs)</sub> |
| :-- | :-: | :-: | :-: | :-: | :-: |
| Where it runs | Cloudflare Workers | vendor-hosted | your own server | your laptop | your laptop |
| Reachable from phone | ✅ | ✅ | ✅ | ❌ | ❌ |
| Several mailboxes at once | ✅ per connection | ❌ | ✅ per call | ❌ | ❌ |
| Send mail | ✅ | ❌ drafts only | ✅ | ✅ | ✅ |
| Attachments · inline images | ✅ | undocumented | ✅ | ✅ | ❌ |
| Reply-all with quoted history | ✅ | ❌ | drafts only | no quoting | ❌ |
| Mailbox settings (filters, forwarding) | ❌ by design | ❌ | ❌ | filters | ✅ |
| Who holds your refresh token | you | vendor | you | you | you |

Two honest notes on that table. [google_workspace_mcp](https://github.com/taylorwilsdon/google_workspace_mcp) is the most complete project in this space and covers all of Workspace; it routes accounts by passing an address on every call, where gmail-mcp binds one mailbox per connection, so a stray argument cannot reach the wrong inbox. And [shinzo-labs/gmail-mcp](https://github.com/shinzo-labs/gmail-mcp) exposes 64 tools against our 22 — it reaches vacation responders, delegates, and S/MIME, which gmail-mcp deliberately leaves outside its OAuth scope.

<div align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./docs/architecture-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="./docs/architecture-light.svg">
  <img src="./docs/architecture-light.svg" alt="An MCP client connects to your Cloudflare Worker, which calls the Gmail API" width="720">
</picture>
</div>

---

## Deploy it

About ten minutes, most of it in two browser consoles. You need a Cloudflare account with a domain on it, [bun](https://bun.sh), and a Google account.

**1 · Create a Google OAuth client.** Install the [gcloud CLI](https://cloud.google.com/sdk/docs/install), then:

```sh
PROJECT="gmail-mcp-$(openssl rand -hex 3)"
gcloud auth login
gcloud projects create "$PROJECT" --name="gmail-mcp"
gcloud config set project "$PROJECT"
gcloud services enable gmail.googleapis.com
```

Google has no API for the next two steps, so they happen in the console:

- **OAuth consent screen** → *External*. While the app is unverified, add each mailbox you plan to connect under **Test users**.
- **Credentials → Create credentials → OAuth client ID** → *Web application*, with `https://<your-domain>/callback` as an authorized redirect URI. Keep the client ID and secret.

**2 · Deploy the Worker.**

```sh
git clone https://github.com/mkpoli/gmail-mcp && cd gmail-mcp
bun install
# in wrangler.jsonc, set `name` and the routes `pattern` to your domain
bun run setup
```

`bun run setup` creates the KV namespace, asks for the client ID and secret, generates a cookie key, and deploys. Re-running it to rotate one secret is safe.

**3 · Connect a client.** Leave the client ID and secret fields empty — MCP clients register themselves.

```sh
claude mcp add --transport http gmail-personal https://<your-domain>/mcp
claude mcp add --transport http gmail-work     https://<your-domain>/mcp/work
```

Run `/mcp` in Claude Code to sign each one in to its Google account. In claude.ai it's **Settings → Connectors → Add custom connector** with the same URL. Any single-segment label works after `/mcp/`, which is how one deployment serves several mailboxes to clients that reject two servers sharing a URL.

Your deployment serves its own setup guide at `https://<your-domain>/`.

---

## What it can do

**Read** — `whoami` · `search_messages` · `get_message` · `get_thread` · `get_attachment`

**Write** — `send_message` · `reply_all` · `create_draft` · `update_draft` · `send_draft` · `delete_draft` · `list_drafts`

**Organize** — `list_labels` · `create_label` · `update_label` · `delete_label` · `modify_labels` · `modify_thread_labels` · `batch_modify_messages` · `trash_message` · `untrash_message` · `trash_thread` · `untrash_thread`

Messages go out the way a mail client sends them: plain text with an HTML alternative, file attachments, and inline images referenced by `cid:`, nested as `multipart/mixed › multipart/related › multipart/alternative`. Subjects and filenames are RFC 2047 encoded, so Japanese, Chinese, and emoji arrive intact. `reply_all` reads the original's `Reply-To`, `From`, `To`, and `Cc`, drops your own address, carries the `References` chain, and quotes the original in both the text and HTML parts.

Reading is bounded on purpose. Message and thread bodies have character budgets and attachments a size ceiling, so a mailing-list thread cannot flood the assistant's context.

---

## Who can sign in

`ALLOWED_EMAILS` decides, and it is checked against the address Google reports as verified — after consent, before any grant exists.

| Value | Who gets in |
| :-- | :-- |
| *(empty)* | nobody |
| `you@gmail.com, work@company.com` | those accounts |
| `*@company.com` | anyone in that domain |
| `*` | any verified Google account |

Each grant reaches only the mailbox that authenticated it, so widening this list never widens access to mailboxes already connected. Setting `*` lets strangers use your deployment, and your Google client's quota, for their own mail.

---

## Security

Self-hosting moves the trust question rather than removing it, so here is where everything sits.

- **Your tokens stay yours.** Refresh tokens are encrypted inside their OAuth grant in your KV namespace. The hour-lived access token lives in the session's Durable Object. No mail is stored anywhere — messages pass through.
- **One session, one mailbox.** The MCP session is bound to the account that opened it, so a grant for one mailbox cannot act on another through a borrowed session id.
- **Scope minimalism.** `gmail.modify` covers reading, sending, labels, and trash. It excludes permanent deletion and all of `gmail.settings.*`, which keeps the classic mailbox backdoors — auto-forwarding rules and filter exfiltration — outside what any stolen grant could do.
- **Hostile mail can't smuggle headers.** Every outgoing header value rejects CR and LF, so an injected instruction in a message body cannot add a silent `Bcc`. Quoted history is HTML-escaped.
- **Revoking works.** Narrow `ALLOWED_EMAILS` to stop new sign-ins, revoke the app at [myaccount.google.com/connections](https://myaccount.google.com/connections), or rotate the Google client secret to invalidate every grant at once.

The Worker decrypts mail in memory while it serves a request, as any hosted relay must. If that is unacceptable for a particular mailbox, run a local MCP server for that one instead.

---

## Development

```sh
bun run dev     # wrangler dev on :8788
bun run check   # biome + tsc
bun test        # unit tests
bun run deploy
```

Tests cover message construction (MIME nesting, RFC 2047 headers, CR/LF rejection, base64 wrapping), body extraction across charsets, reply-recipient logic, the Google token flows, and the sign-in allowlist.

## License

[MIT](./LICENSE). `src/workers-oauth-utils.ts` comes from Cloudflare's [remote-mcp-github-oauth demo](https://github.com/cloudflare/ai/tree/main/demos/remote-mcp-github-oauth) (MIT).
