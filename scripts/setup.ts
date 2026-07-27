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
const kvPlaceholder = config.includes("REPLACE_AT_DEPLOY");

console.log("\n  gmail-mcp setup\n");
console.log(`  config      ${CONFIG}`);
console.log(`  domain      ${domain ?? "(no custom domain configured)"}`);
console.log(`  redirect    https://${domain ?? "<your-domain>"}/callback`);
console.log("\n  The redirect URI above must exist on your Google OAuth client.\n");

if (kvPlaceholder) {
	if (await confirm("  Create the OAuth KV namespace now?")) {
		const out = await $`bunx wrangler kv namespace create gmail-mcp-oauth`.text();
		const id = out.match(/"id":\s*"([0-9a-f]+)"/)?.[1];
		if (!id) {
			console.log("\n  Could not read the namespace id from wrangler's output.");
			console.log("  Copy it into wrangler.jsonc manually, then re-run.\n");
			process.exit(1);
		}
		writeFileSync(CONFIG, config.replace("REPLACE_AT_DEPLOY", id));
		console.log(`\n  Wrote namespace ${id} into ${CONFIG}\n`);
	}
} else {
	console.log("  KV namespace already configured — skipping.\n");
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
	await Bun.write("/tmp/.gmail-mcp-key", hex);
	await $`cat /tmp/.gmail-mcp-key | bunx wrangler secret put COOKIE_ENCRYPTION_KEY`;
	await $`rm -f /tmp/.gmail-mcp-key`;
}

if (await confirm("  Deploy now?")) {
	await $`bun run deploy`;
	console.log(`\n  Connect a client to https://${domain ?? "<your-domain>"}/mcp`);
	console.log("  Leave the client's OAuth client id and secret fields empty.\n");
}

process.exit(0);
