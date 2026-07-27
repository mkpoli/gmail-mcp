import { describe, expect, test } from "bun:test";
import { isEmailAllowed } from "../src/utils";

describe("isEmailAllowed", () => {
	test("admits no one when unset or empty", () => {
		expect(isEmailAllowed("a@example.com", undefined)).toBe(false);
		expect(isEmailAllowed("a@example.com", "")).toBe(false);
		expect(isEmailAllowed("a@example.com", "  , ,  ")).toBe(false);
	});

	test("matches exact addresses case-insensitively", () => {
		expect(isEmailAllowed("A@Example.com", "a@example.com")).toBe(true);
		expect(isEmailAllowed("a@example.com", "b@example.com, a@example.com")).toBe(true);
		expect(isEmailAllowed("c@example.com", "a@example.com,b@example.com")).toBe(false);
	});

	test("matches a domain pattern only within that domain", () => {
		expect(isEmailAllowed("anyone@example.com", "*@example.com")).toBe(true);
		expect(isEmailAllowed("anyone@other.com", "*@example.com")).toBe(false);
		// A lookalike domain must not pass.
		expect(isEmailAllowed("attacker@notexample.com", "*@example.com")).toBe(false);
		expect(isEmailAllowed("attacker@example.com.evil.net", "*@example.com")).toBe(false);
	});

	test("wildcard admits any address", () => {
		expect(isEmailAllowed("anyone@anywhere.org", "*")).toBe(true);
		expect(isEmailAllowed("someone@gmail.com", "a@example.com, *")).toBe(true);
	});

	test("a bare domain without the star does not match its addresses", () => {
		expect(isEmailAllowed("a@example.com", "example.com")).toBe(false);
	});
});
