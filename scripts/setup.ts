#!/usr/bin/env bun
// Guided deployment: domain, KV namespace, secrets, deploy. Every step is
// skippable, so re-running it to rotate one secret is safe.

import { $ } from "bun";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const TEMPLATE = "wrangler.jsonc";
const LOCAL = "wrangler.local.jsonc";
const REDIRECT = ".wrangler/deploy/config.json";

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

// Both config files keep their comments on their own lines, which is the only
// JSONC this has to survive.
function parseJsonc(text: string): Record<string, unknown> {
	return JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));
}

type Namespace = { id: string; title: string };

async function namespaces(): Promise<Namespace[] | null> {
	try {
		const out = await $`bunx wrangler kv namespace list`.text();
		const array = out.slice(out.indexOf("["), out.lastIndexOf("]") + 1);
		return JSON.parse(array);
	} catch {
		// Not signed in yet, or wrangler could not reach the API. Saying so is
		// left to the command that needs the answer.
		return null;
	}
}

const template = readFileSync(TEMPLATE, "utf8");
const local = existsSync(LOCAL) ? (parseJsonc(readFileSync(LOCAL, "utf8")) as Record<string, any>) : null;

const configuredDomain: string | undefined = local?.routes?.[0]?.pattern;
const configuredKv: string | undefined = local?.kv_namespaces?.[0]?.id;

console.log("\n  gmail-mcp setup\n");
console.log(`  template    ${TEMPLATE}`);
console.log(`  deployment  ${LOCAL}${local ? "" : " (not written yet)"}`);
console.log(`  domain      ${configuredDomain ?? "(workers.dev)"}`);
console.log(`  redirect    https://${configuredDomain ?? "<worker>.<subdomain>.workers.dev"}/callback`);
console.log("\n  The redirect URI above must exist on your Google OAuth client.\n");

let domain = configuredDomain;
if (!domain || !(await confirm(`  Keep ${domain} as this deployment's domain?`))) {
	const answer = await ask("  Custom domain, on a zone in this Cloudflare account (blank for workers.dev): ");
	domain = answer || undefined;
}

// A namespace the account cannot see is one that belongs to somebody else, and
// binding it fails at upload with a message about the id rather than the config.
let kvId = configuredKv;
const listed = await namespaces();
if (listed && !listed.some((ns) => ns.id === kvId)) {
	const existing = listed.find((ns) => ns.title.includes("gmail-mcp-oauth"));
	if (existing && (await confirm(`  Bind the existing ${existing.title} namespace (${existing.id})?`))) {
		kvId = existing.id;
	} else if (await confirm("  Create a KV namespace for the OAuth grants now?")) {
		const out = await $`bunx wrangler kv namespace create gmail-mcp-oauth`.text();
		kvId = out.match(/"id":\s*"([0-9a-f]+)"/)?.[1];
		if (!kvId) {
			console.log("\n  Could not read the namespace id from wrangler's output.");
			console.log(`  Put it in ${LOCAL} under kv_namespaces, then re-run.\n`);
			process.exit(1);
		}
	}
}

const config = parseJsonc(template) as Record<string, any>;
if (kvId) config.kv_namespaces[0].id = kvId;
if (domain) config.routes = [{ pattern: domain, custom_domain: true }];

writeFileSync(
	LOCAL,
	[
		"// This deployment's own domain and KV namespace, written by `bun run setup`.",
		`// ${TEMPLATE} stays free of both so that a clone deploys onto any account.`,
		`${JSON.stringify(config, null, "\t")}\n`,
	].join("\n"),
);
mkdirSync(dirname(REDIRECT), { recursive: true });
writeFileSync(REDIRECT, `${JSON.stringify({ configPath: `../../${LOCAL}` }, null, "\t")}\n`);
console.log(`\n  Wrote ${LOCAL}; deploy and dev read it from now on.\n`);

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
	console.log(
		domain
			? `\n  Connect a client to https://${domain}/mcp`
			: "\n  Connect a client to the workers.dev URL above, with /mcp on the end",
	);
	console.log("  Leave the client's OAuth client id and secret fields empty.\n");
}

process.exit(0);
