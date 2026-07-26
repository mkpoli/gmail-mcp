# gmail-mcp

**Your Gmail accounts, served to any MCP client, from your own Cloudflare Worker.**

gmail-mcp is a remote [MCP](https://modelcontextprotocol.io/) server that exposes Gmail as a set of tools — search, read, label, draft, send — over streamable HTTP with OAuth 2.1. It runs on Cloudflare Workers under your own domain, holds its tokens in your own account, and answers to an allowlist of your own addresses. One deployment serves any number of Google accounts and any MCP client that speaks the protocol: Claude Code, claude.ai, or anything else with OAuth support.

The multi-account model is the point. Hosted Gmail connectors bind a whole assistant account to a single Google login. Here, every *connection* performs its own Google sign-in, so `gmail-personal` and `gmail-work` coexist as two connections of the same Worker, each permanently bound to the mailbox chosen at its consent screen. Tool descriptions carry the bound address, so the model always knows which mailbox it is operating on.

## How it works

```
MCP client ──OAuth 2.1──▶ Worker (OAuthProvider) ──OAuth 2.0──▶ Google
                            │                                     │
                            └── McpAgent (Durable Object) ──REST──▶ Gmail API
```

- [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider) faces the MCP client: dynamic client registration, PKCE, grants stored in KV with the Google tokens encrypted inside the grant.
- `src/google-handler.ts` faces Google: authorization code flow with offline access, one-time state tokens bound to the browser session, double-submit CSRF, and a fail-closed email allowlist checked against Google's verified account email.
- `src/index.ts` is the agent. Each session lives in a Durable Object; access tokens refresh from the per-grant refresh token with a single-flight guard.
- `src/gmail.ts` talks to the Gmail REST API with plain `fetch` — chunk-safe base64, RFC 2047 subject encoding, MIME-tree body extraction with charset handling, and rejection of CR/LF in every outgoing header.

### Endpoints

| Path | Purpose |
| --- | --- |
| `/mcp` | MCP endpoint |
| `/mcp/<label>` | The same server under any label you like (`/mcp/work`, `/mcp/family`), for clients that refuse duplicate server URLs |
| `/authorize`, `/token`, `/register`, `/callback` | OAuth machinery |

### Tools

`whoami` · `search_messages` (Gmail query syntax, paginated) · `get_message` · `get_thread` · `list_labels` · `modify_labels` · `trash_message` · `create_draft` · `list_drafts` · `send_message`

The granted scope is `gmail.modify`: permanent deletion and account settings (filters, forwarding) stay out of reach by construction.

### Verified against live mailboxes

Every tool has passed an end-to-end run between two real Gmail accounts — one connected through this server, one independent account checking what actually arrived:

- `whoami`, `list_labels`, and `search_messages` against a mailbox of ~15k messages, including user labels with CJK names and pagination via `nextPageToken`.
- A multipart/alternative message (plain text + styled HTML table) sent with a Japanese subject line: the RFC 2047 subject, both MIME parts, and mixed 日本語・アイヌ語・中文 content arrived intact at the receiving account, HTML rendering confirmed from the recipient's side.
- Reply threading metadata (`Message-ID` capture on read, `In-Reply-To`/`References` on send).
- The draft lifecycle (`create_draft`, `list_drafts`), label round-trip (star and unstar via `modify_labels`), and `trash_message`.
- Body extraction on read: text decoded from the sender's own multipart, charset honored per part.

## Deploy your own

Requirements: a Cloudflare account, a domain on it, [bun](https://bun.sh), and a Google Cloud project.

1. **Google Cloud** — enable the Gmail API. Configure the OAuth consent screen (External; add each mailbox as a test user while the app is unverified). Create an OAuth client of type **Web application** with redirect URI `https://<your-domain>/callback`.
2. **Cloudflare** — adjust `name` and `routes` in `wrangler.jsonc` to your domain, create the KV namespace, and set the secrets:

   ```sh
   bun install
   bunx wrangler kv namespace create gmail-mcp-oauth   # put its id into wrangler.jsonc
   bunx wrangler secret put GOOGLE_CLIENT_ID
   bunx wrangler secret put GOOGLE_CLIENT_SECRET
   bunx wrangler secret put COOKIE_ENCRYPTION_KEY      # openssl rand -hex 32
   bunx wrangler secret put ALLOWED_EMAILS             # comma-separated addresses
   bun run deploy
   ```

3. **Connect** — no client ID or secret on the client side; MCP clients register themselves.

   ```sh
   claude mcp add --transport http gmail-personal https://<your-domain>/mcp
   claude mcp add --transport http gmail-work https://<your-domain>/mcp/work
   ```

   Authenticate each via `/mcp`, signing in with the matching Google account. On claude.ai: Settings → Connectors → Add custom connector with the same URL, credential fields empty.

For local development, copy `.dev.vars.example` to `.dev.vars`, fill in the same values, and add `http://localhost:8788/callback` to the Google client's redirect URIs.

## Security posture

- **Fail-closed access.** The MCP endpoint is public and clients self-register, so mailbox access hinges on the allowlist: a Google sign-in completes only for a verified email listed in `ALLOWED_EMAILS`. An empty list admits no one.
- **Nothing stored but tokens.** Mail passes through; message content never touches KV, Durable Object storage, or logs. Refresh tokens live encrypted inside their grant; the hour-lived access token is cached in the session's Durable Object.
- **Injection defenses.** Outgoing header values reject CR/LF and NUL, closing the header-smuggling path from prompt-injected tool arguments. Message and thread bodies are truncated at fixed budgets before they reach the client.
- **Scope minimalism.** `gmail.modify` withholds `gmail.settings.*` and permanent delete — the classic mailbox-backdoor vectors (auto-forwarding rules, filter exfiltration) are outside what a stolen grant could do.
- **Revocation.** Remove an address from `ALLOWED_EMAILS` to block new sign-ins; revoke the app at [myaccount.google.com/connections](https://myaccount.google.com/connections) or rotate the Google client secret to kill existing grants.

Trust boundary, stated plainly: the Worker decrypts mail in memory while serving a request, as any hosted relay must. If that is unacceptable, run the mail client on your own hardware.

## Development

```sh
bun run dev     # wrangler dev on :8788
bun run check   # biome + tsc
bun test        # unit tests (RFC822 building, MIME parsing, token flows)
bun run deploy
```

## License

[MIT](./LICENSE). `src/workers-oauth-utils.ts` is vendored from Cloudflare's [remote-mcp-github-oauth demo](https://github.com/cloudflare/ai/tree/main/demos/remote-mcp-github-oauth) (MIT).
