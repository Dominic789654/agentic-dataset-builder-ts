import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectPiRecords, collectPiTrajectories } from "./pi.js";

describe("collectPiTrajectories", () => {
	it("strips think wrappers from Pi reasoning blocks", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-history-"));
		const file = path.join(dir, "sample.jsonl");
		fs.writeFileSync(
			file,
			[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "s1",
					timestamp: "2026-01-01T00:00:00Z",
					cwd: "/tmp/project",
				}),
				JSON.stringify({
					type: "model_change",
					id: "m1",
					parentId: null,
					timestamp: "2026-01-01T00:00:01Z",
					provider: "test",
					modelId: "model",
				}),
				JSON.stringify({
					type: "thinking_level_change",
					id: "t1",
					parentId: "m1",
					timestamp: "2026-01-01T00:00:02Z",
					thinkingLevel: "high",
				}),
				JSON.stringify({
					type: "message",
					id: "u1",
					parentId: "t1",
					timestamp: "2026-01-01T00:00:03Z",
					message: {
						role: "user",
						content: [{ type: "text", text: "hello" }],
					},
				}),
				JSON.stringify({
					type: "message",
					id: "a1",
					parentId: "u1",
					timestamp: "2026-01-01T00:00:04Z",
					message: {
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "<think>\nreasoning\n</think>" },
							{ type: "text", text: "answer" },
						],
					},
				}),
			].join("\n") + "\n",
			"utf8",
		);

		const trajectories = await collectPiTrajectories(dir);
		expect(trajectories).toHaveLength(1);
		expect(trajectories[0].steps[1]?.source).toBe("agent");
		expect(trajectories[0].steps[1]?.reasoning_content).toBe("reasoning");
		expect(trajectories[0].steps[1]?.reasoning_content).not.toContain(
			"<think>",
		);
		expect(trajectories[0].steps[1]?.reasoning_content).not.toContain(
			"</think>",
		);
	});

	it("attaches tool results and bash executions to the current assistant step observation", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-history-"));
		const file = path.join(dir, "sample.jsonl");
		fs.writeFileSync(
			file,
			[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "s2",
					timestamp: "2026-01-01T00:00:00Z",
					cwd: "/tmp/project",
				}),
				JSON.stringify({
					type: "model_change",
					id: "m1",
					parentId: null,
					timestamp: "2026-01-01T00:00:01Z",
					provider: "test",
					modelId: "model",
				}),
				JSON.stringify({
					type: "message",
					id: "u1",
					parentId: "m1",
					timestamp: "2026-01-01T00:00:02Z",
					message: { role: "user", content: [{ type: "text", text: "hello" }] },
				}),
				JSON.stringify({
					type: "message",
					id: "a1",
					parentId: "u1",
					timestamp: "2026-01-01T00:00:03Z",
					message: {
						role: "assistant",
						content: [
							{ type: "text", text: "answer" },
							{
								type: "toolCall",
								id: "call_read",
								name: "Read",
								arguments: { file_path: "README.md" },
							},
						],
					},
				}),
				JSON.stringify({
					type: "message",
					id: "tr1",
					parentId: "a1",
					timestamp: "2026-01-01T00:00:04Z",
					message: {
						role: "toolResult",
						toolName: "Read",
						toolCallId: "call_read",
						content: "file contents",
					},
				}),
				JSON.stringify({
					type: "message",
					id: "b1",
					parentId: "tr1",
					timestamp: "2026-01-01T00:00:05Z",
					message: {
						role: "bashExecution",
						command: "ls",
						exitCode: 0,
						truncated: false,
						cancelled: false,
						excludeFromContext: false,
						output: "README.md",
					},
				}),
			].join("\n") + "\n",
			"utf8",
		);

		const trajectories = await collectPiTrajectories(dir);
		expect(trajectories).toHaveLength(1);

		const agentStep = trajectories[0].steps[1];
		expect(agentStep?.source).toBe("agent");
		expect(
			agentStep?.tool_calls?.map((toolCall) => toolCall.function_name),
		).toEqual(["Read", "bash"]);
		expect(agentStep?.observation?.results).toHaveLength(2);
		expect(agentStep?.observation?.results[0]?.content).toBe("file contents");
		expect(agentStep?.observation?.results[1]?.content).toContain(
			'"command":"ls"',
		);

		const records = await collectPiRecords(dir);
		expect(records).toHaveLength(1);
		expect(records[0].messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"tool",
			"tool",
		]);
		expect(records[0].messages[2]?.content).toBe("file contents");
		expect(typeof records[0].messages[3]?.content).toBe("string");
	});
});
