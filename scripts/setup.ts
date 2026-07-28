#!/usr/bin/env bun
// Guided deployment: KV namespace, secrets, deploy. Every step is skippable,
// so re-running it to rotate one secret is safe.

import { $ } from "bun";
import { readFileSync, writeFileSync } from "node:fs";

const CONFIG = "wrangler.jsonc";

function ask(question: string): Promise<string> {
	process.stdout.write(question);
	return new Promise((resolve) => {
		const onData = (chunk: Buffer) => {
			process.stdin.off("data", onData);
			process.stdin.pause();
			resolve(chunk.toString().trim());
		};
		process.stdin.resume();
		process.stdin.on("data", onData);
	});
}

async function confirm(question: string): Promise<boolean> {
	const answer = (await ask(`${question} [Y/n] `)).toLowerCase();
	return answer === "" || answer === "y" || answer === "yes";
}

const config = readFileSync(CONFIG, "utf8");
const domain = config.match(/"pattern":\s*"([^"]+)"/)?.[1];
const kvId = config.match(/"binding":\s*"OAUTH_KV",\s*"id":\s*"([0-9a-f]*)"/s)?.[1] ?? "";

// The id committed here belongs to the account this server was first deployed
// from. A fork reaching Cloudflare with it is refused, and the message names
// the namespace rather than the config, so whether the id is one of this
// account's own is settled here instead of at upload.
async function kvNamespaceIsOurs(id: string): Promise<boolean> {
	if (!id) return false;
	try {
		const listed = await $`bunx wrangler kv namespace list`.text();
		return listed.includes(id);
	} catch {
		// Not signed in yet, or wrangler could not reach the API. The upload
		// will say so far more clearly than a guess here would.
		return true;
	}
}

console.log("\n  gmail-mcp setup\n");
console.log(`  config      ${CONFIG}`);
console.log(`  domain      ${domain ?? "(no custom domain configured)"}`);
console.log(`  redirect    https://${domain ?? "<your-domain>"}/callback`);
console.log("\n  The redirect URI above must exist on your Google OAuth client.\n");

if (await kvNamespaceIsOurs(kvId)) {
	console.log("  KV namespace already configured — skipping.\n");
} else {
	console.log(`  The configured KV namespace (${kvId || "none"}) is not in this account.`);
	console.log("  Every OAuth grant and token lives there, so one is needed here.\n");
	if (await confirm("  Create the OAuth KV namespace now?")) {
		const out = await $`bunx wrangler kv namespace create gmail-mcp-oauth`.text();
		const id = out.match(/"id":\s*"([0-9a-f]+)"/)?.[1];
		if (!id) {
			console.log("\n  Could not read the namespace id from wrangler's output.");
			console.log("  Copy it into wrangler.jsonc manually, then re-run.\n");
			process.exit(1);
		}
		writeFileSync(
			CONFIG,
			kvId ? config.replace(kvId, id) : config.replace(/("binding":\s*"OAUTH_KV",\s*"id":\s*")(")/s, `$1${id}$2`),
		);
		console.log(`\n  Wrote namespace ${id} into ${CONFIG}\n`);
	}
}

const secrets = [
	["GOOGLE_CLIENT_ID", "OAuth client id from Google Cloud Console"],
	["GOOGLE_CLIENT_SECRET", "OAuth client secret"],
	["ALLOWED_EMAILS", "who may sign in: addresses, *@domain, or * for anyone"],
] as const;

for (const [name, hint] of secrets) {
	if (await confirm(`  Set ${name} (${hint})?`)) {
		await $`bunx wrangler secret put ${name}`;
	}
}

if (await confirm("  Generate a fresh COOKIE_ENCRYPTION_KEY?")) {
	const key = crypto.getRandomValues(new Uint8Array(32));
	const hex = [...key].map((b) => b.toString(16).padStart(2, "0")).join("");
	// Piped rather than written to a file: a temp file would be readable by
	// anyone on the machine while it existed, and would survive a failed or
	// interrupted upload.
	await $`echo ${hex} | bunx wrangler secret put COOKIE_ENCRYPTION_KEY`;
}

if (await confirm("  Deploy now?")) {
	await $`bun run deploy`;
	console.log(`\n  Connect a client to https://${domain ?? "<your-domain>"}/mcp`);
	console.log("  Leave the client's OAuth client id and secret fields empty.\n");
}

process.exit(0);
