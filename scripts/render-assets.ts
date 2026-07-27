#!/usr/bin/env bun
// Emits light and dark variants of the diagrams. GitHub renders README images
// in an isolated <img> context where `currentColor` falls back to black, so a
// single theme-aware file cannot follow the reader's theme — two files behind a
// <picture> element can.

import { readFileSync, writeFileSync } from "node:fs";

const INK = { light: "#16181d", dark: "#e8eaee" };
const SOURCES = ["docs/logo.svg", "docs/architecture.svg", "docs/demo.svg", "docs/demo.ja.svg", "docs/demo.zh.svg"];

for (const source of SOURCES) {
	const svg = readFileSync(source, "utf8");
	for (const [theme, ink] of Object.entries(INK)) {
		const out = source.replace(/\.svg$/, `-${theme}.svg`);
		writeFileSync(out, svg.replaceAll("currentColor", ink));
		console.log(`  ${out}`);
	}
}
