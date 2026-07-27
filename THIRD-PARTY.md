# Third-party notices

gmail-mcp includes material from the projects below. Their license terms apply
to that material in addition to the [MIT License](./LICENSE) covering the rest
of this repository.

## cloudflare/ai — remote-mcp-github-oauth demo

`src/workers-oauth-utils.ts` is derived from the
[remote-mcp-github-oauth demo](https://github.com/cloudflare/ai/tree/main/demos/remote-mcp-github-oauth)
in [cloudflare/ai](https://github.com/cloudflare/ai), with the approval dialog
text adapted for this server and the approved-clients cookie changed to
`SameSite=Strict`.

```
MIT License

Copyright (c) 2025 Cloudflare, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Runtime dependencies

Installed from npm and not vendored here; each carries its own license, listed
in `package.json` and resolvable with `bun pm ls`.

| Package | License |
| :-- | :-- |
| [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider) | MIT |
| [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) | MIT |
| [`agents`](https://github.com/cloudflare/agents) | MIT |
| [`hono`](https://github.com/honojs/hono) | MIT |
| [`zod`](https://github.com/colinhacks/zod) | MIT |
