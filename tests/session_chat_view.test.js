import { describe, expect, test } from "bun:test";
import { orderMessagesForDisplay } from "../public/app/session/chat_view.js";

describe("chat view message ordering", () => {
	test("renders sdk compaction summaries at their chronological position", () => {
		const before = { role: "user", content: "before", timestamp: 1000 };
		const assistant = { role: "assistant", content: "ok", timestamp: 2000 };
		const compact = { role: "compactionSummary", summary: "summary", tokensBefore: 1234, timestamp: 3000 };
		const after = { role: "user", content: "after", timestamp: 4000 };

		expect(orderMessagesForDisplay([compact, before, assistant, after])).toEqual([before, assistant, compact, after]);
	});

	test("puts untimestamped compaction summaries after visible history", () => {
		const before = { role: "user", content: "before" };
		const compact = { role: "compactionSummary", summary: "summary", tokensBefore: 1234 };

		expect(orderMessagesForDisplay([compact, before])).toEqual([before, compact]);
	});
});
