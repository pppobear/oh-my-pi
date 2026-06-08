import { describe, expect, it } from "bun:test";
import { scanMagicKeywords } from "@oh-my-pi/pi-coding-agent/modes/magic-keyword-notices";

describe("scanMagicKeywords", () => {
	it("returns no notices and no budget for plain prose", () => {
		const result = scanMagicKeywords("just a regular message");
		expect(result.notices).toEqual([]);
		expect(result.turnBudget).toBeNull();
	});

	it("emits each keyword notice exactly once with attribution=user and display=false", () => {
		const result = scanMagicKeywords("please ultrathink and orchestrate the workflowz");

		const customTypes = result.notices.map(notice => notice.customType);
		expect(customTypes).toEqual(["ultrathink-notice", "orchestrate-notice", "workflow-notice"]);

		for (const notice of result.notices) {
			expect(notice.role).toBe("custom");
			expect(notice.display).toBe(false);
			expect(notice.attribution).toBe("user");
			expect(typeof notice.content).toBe("string");
			expect((notice.content as string).length).toBeGreaterThan(0);
		}
	});

	it("never flags keywords inside code spans, fenced blocks, or XML sections", () => {
		const result = scanMagicKeywords("`ultrathink`\n```\norchestrate\n```\n<n>workflowz</n>");
		expect(result.notices).toEqual([]);
	});

	it("parses the +Nk turn budget directive and surfaces hard mode", () => {
		expect(scanMagicKeywords("compare these +500k").turnBudget).toEqual({ total: 500_000, hard: false });
		expect(scanMagicKeywords("+2m! hard cap").turnBudget).toEqual({ total: 2_000_000, hard: true });
		// +N without a unit is allowed (advisory).
		expect(scanMagicKeywords("budget +250 tokens").turnBudget).toEqual({ total: 250, hard: false });
	});

	it("ignores numbers that aren't whitespace-bounded budget tokens", () => {
		// `+500` inside a longer token, or attached to surrounding non-whitespace, doesn't match.
		expect(scanMagicKeywords("price=+500usd").turnBudget).toBeNull();
		expect(scanMagicKeywords("nothing here").turnBudget).toBeNull();
	});

	it("scans skill-style multi-line args so a keyword on its own line still triggers (#2126)", () => {
		// Mirrors the bug-report shape: user types `/skill:foo bar\nworkflowz` and the
		// fragment passed in is the trimmed args.
		const result = scanMagicKeywords("bar\nworkflowz");
		expect(result.notices.map(n => n.customType)).toEqual(["workflow-notice"]);
	});
});
