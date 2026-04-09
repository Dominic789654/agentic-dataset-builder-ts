import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	collectClaudePromptOnlyRecords,
	collectClaudeTrajectories,
} from "./claude.js";

describe("collectClaudePromptOnlyRecords", () => {
	it("reconstructs assistant reasoning, tool calls, and tool results from Claude session jsonl", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-history-"));
		const file = path.join(dir, "sample.jsonl");
		fs.writeFileSync(
			file,
			[
				JSON.stringify({
					type: "system",
					subtype: "init",
					sessionId: "s1",
					timestamp: "2026-01-01T00:00:00Z",
					cwd: "/tmp/project",
					claude_code_version: "2.1.42",
					model: "claude-test",
					tools: [{ name: "Read", description: "read files" }],
				}),
				JSON.stringify({
					type: "user",
					sessionId: "s1",
					timestamp: "2026-01-01T00:00:01Z",
					message: { role: "user", content: "hello" },
				}),
				JSON.stringify({
					type: "progress",
					data: {
						message: {
							type: "assistant",
							timestamp: "2026-01-01T00:00:02Z",
							message: {
								role: "assistant",
								model: "claude-test",
								content: [
									{ type: "thinking", thinking: "<think>reasoning</think>" },
									{ type: "text", text: "answer" },
									{
										type: "tool_use",
										id: "toolu_1",
										name: "Read",
										input: { file_path: "README.md" },
									},
								],
							},
						},
					},
				}),
				JSON.stringify({
					type: "progress",
					data: {
						message: {
							type: "user",
							timestamp: "2026-01-01T00:00:03Z",
							message: {
								role: "user",
								content: [
									{
										type: "tool_result",
										tool_use_id: "toolu_1",
										content: "file contents",
										is_error: false,
									},
								],
							},
						},
					},
				}),
			].join("\n") + "\n",
			"utf8",
		);

		const records = await collectClaudePromptOnlyRecords(dir);
		expect(records).toHaveLength(1);
		expect(records[0].meta.endpoint).toBe("claude/session_trace");
		expect(records[0].messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"tool",
		]);
		if (records[0].messages[1]?.role !== "assistant")
			throw new Error("expected assistant message");
		expect(records[0].messages[1].reasoning_content).toBe("reasoning");
		expect(records[0].messages[1].tool_calls?.[0]?.function.name).toBe("Read");
		expect(records[0].messages[2]?.role).toBe("tool");
		expect(records[0].messages[2]?.content).toBe("file contents");
	});

	it("falls back to prompt-only records when a full session cannot be reconstructed", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-history-"));
		const file = path.join(dir, "sample.jsonl");
		fs.writeFileSync(
			file,
			[
				JSON.stringify({
					type: "user",
					sessionId: "s1",
					promptId: "p1",
					timestamp: "2026-01-01T00:00:00Z",
					message: { role: "user", content: "hello" },
				}),
				JSON.stringify({
					type: "attachment",
					attachment: { type: "skill_listing" },
				}),
			].join("\n") + "\n",
			"utf8",
		);

		const records = await collectClaudePromptOnlyRecords(dir);
		expect(records).toHaveLength(1);
		expect(records[0].messages[0]?.role).toBe("user");
		expect(records[0].meta.lossy_reasons).toContain("prompt_history_only");
	});

	it("hydrates missing tool results from sidecar files", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-history-"));
		const file = path.join(dir, "sample.jsonl");
		const sessionDir = path.join(dir, "sample");
		const toolResultsDir = path.join(sessionDir, "tool-results");
		fs.mkdirSync(toolResultsDir, { recursive: true });
		fs.writeFileSync(
			path.join(toolResultsDir, "toolu_sidecar.txt"),
			"sidecar payload",
			"utf8",
		);
		fs.writeFileSync(
			file,
			[
				JSON.stringify({
					type: "system",
					subtype: "init",
					sessionId: "s2",
					timestamp: "2026-01-01T00:00:00Z",
					model: "claude-test",
				}),
				JSON.stringify({
					type: "user",
					sessionId: "s2",
					timestamp: "2026-01-01T00:00:01Z",
					message: { role: "user", content: "hello" },
				}),
				JSON.stringify({
					type: "assistant",
					sessionId: "s2",
					timestamp: "2026-01-01T00:00:02Z",
					message: {
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "toolu_sidecar",
								name: "Read",
								input: { file_path: "README.md" },
							},
						],
					},
				}),
			].join("\n") + "\n",
			"utf8",
		);

		const records = await collectClaudePromptOnlyRecords(dir);
		expect(records).toHaveLength(1);
		expect(records[0].messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"tool",
		]);
		expect(records[0].messages[2]?.content).toBe("sidecar payload");
	});

	it("hydrates image sidecars as image placeholder blocks", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-history-"));
		const file = path.join(dir, "sample.jsonl");
		const sessionDir = path.join(dir, "sample");
		const toolResultsDir = path.join(
			sessionDir,
			"tool-results",
			"toolu_gallery",
		);
		fs.mkdirSync(toolResultsDir, { recursive: true });
		fs.writeFileSync(path.join(toolResultsDir, "page-1.jpg"), "fake", "utf8");
		fs.writeFileSync(
			file,
			[
				JSON.stringify({
					type: "system",
					subtype: "init",
					sessionId: "s2b",
					timestamp: "2026-01-01T00:00:00Z",
					model: "claude-test",
				}),
				JSON.stringify({
					type: "user",
					sessionId: "s2b",
					timestamp: "2026-01-01T00:00:01Z",
					message: { role: "user", content: "hello" },
				}),
				JSON.stringify({
					type: "assistant",
					sessionId: "s2b",
					timestamp: "2026-01-01T00:00:02Z",
					message: {
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "toolu_gallery",
								name: "Read",
								input: { file_path: "slides.pdf" },
							},
						],
					},
				}),
			].join("\n") + "\n",
			"utf8",
		);

		const records = await collectClaudePromptOnlyRecords(dir);
		expect(records).toHaveLength(1);
		expect(records[0].messages[2]?.role).toBe("tool");
		expect(Array.isArray(records[0].messages[2]?.content)).toBe(true);
	});

	it("exports matched Task subagents as separate records and links them from the main record", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-history-"));
		const file = path.join(dir, "sample.jsonl");
		const sessionDir = path.join(dir, "sample");
		const subagentsDir = path.join(sessionDir, "subagents");
		fs.mkdirSync(subagentsDir, { recursive: true });
		fs.writeFileSync(
			path.join(subagentsDir, "agent-a1.jsonl"),
			[
				JSON.stringify({
					type: "user",
					sessionId: "sub1",
					timestamp: "2026-01-01T00:00:03Z",
					message: { role: "user", content: "sub task" },
				}),
				JSON.stringify({
					type: "assistant",
					sessionId: "sub1",
					timestamp: "2026-01-01T00:00:04Z",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "sub answer" }],
					},
				}),
			].join("\n") + "\n",
			"utf8",
		);
		fs.writeFileSync(
			file,
			[
				JSON.stringify({
					type: "system",
					subtype: "init",
					sessionId: "s3",
					timestamp: "2026-01-01T00:00:00Z",
					model: "claude-test",
				}),
				JSON.stringify({
					type: "user",
					sessionId: "s3",
					timestamp: "2026-01-01T00:00:01Z",
					message: { role: "user", content: "hello" },
				}),
				JSON.stringify({
					type: "assistant",
					sessionId: "s3",
					timestamp: "2026-01-01T00:00:02Z",
					message: {
						role: "assistant",
						content: [
							{ type: "text", text: "delegating" },
							{
								type: "tool_use",
								id: "toolu_task",
								name: "Task",
								input: { description: "do subtask", agent_id: "a1" },
							},
						],
					},
				}),
			].join("\n") + "\n",
			"utf8",
		);

		const records = await collectClaudePromptOnlyRecords(dir);
		expect(records).toHaveLength(2);

		const mainRecord = records.find((record) => record.id === "s3");
		const subagentRecord = records.find(
			(record) => record.id === "s3:subagent:a1",
		);
		if (!mainRecord || !subagentRecord)
			throw new Error("expected main and subagent records");

		expect(mainRecord.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"tool",
		]);
		expect(
			mainRecord.messages.some(
				(message) =>
					typeof message.content === "string" &&
					message.content.includes("[subagent:a1]"),
			),
		).toBe(false);
		expect(mainRecord.messages[2]?.content).toBe("sub answer");
		expect(mainRecord.meta.lossy_reasons).not.toContain(
			"unmatched_subagent_trajectories",
		);

		expect(subagentRecord.meta.endpoint).toBe("claude/subagent_trace");
		expect(subagentRecord.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
		]);
		expect(subagentRecord.messages[0]?.content).toBe("sub task");
		expect(subagentRecord.messages[1]?.content).toBe("sub answer");
	});

	it("does not silently claim unrelated sidecar payloads", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-history-"));
		const file = path.join(dir, "sample.jsonl");
		const sessionDir = path.join(dir, "sample");
		const toolResultsDir = path.join(sessionDir, "tool-results");
		fs.mkdirSync(toolResultsDir, { recursive: true });
		fs.writeFileSync(
			path.join(toolResultsDir, "unrelated.txt"),
			"orphan sidecar",
			"utf8",
		);
		fs.writeFileSync(
			file,
			[
				JSON.stringify({
					type: "system",
					subtype: "init",
					sessionId: "s5",
					timestamp: "2026-01-01T00:00:00Z",
					model: "claude-test",
				}),
				JSON.stringify({
					type: "user",
					sessionId: "s5",
					timestamp: "2026-01-01T00:00:01Z",
					message: { role: "user", content: "hello" },
				}),
				JSON.stringify({
					type: "assistant",
					sessionId: "s5",
					timestamp: "2026-01-01T00:00:02Z",
					message: {
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "toolu_missing",
								name: "Read",
								input: { file_path: "README.md" },
							},
						],
					},
				}),
			].join("\n") + "\n",
			"utf8",
		);

		const records = await collectClaudePromptOnlyRecords(dir);
		expect(records).toHaveLength(1);
		expect(records[0].messages.some((message) => message.role === "tool")).toBe(
			false,
		);
		expect(records[0].meta.lossy_reasons).toContain("missing_tool_results");
	});

	it("falls back to side-file subagents only when inline agent ids have no usable transcript messages", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-history-"));
		const file = path.join(dir, "sample.jsonl");
		const sessionDir = path.join(dir, "sample");
		const subagentsDir = path.join(sessionDir, "subagents");
		fs.mkdirSync(subagentsDir, { recursive: true });
		fs.writeFileSync(
			path.join(subagentsDir, "agent-a1.jsonl"),
			[
				JSON.stringify({
					type: "user",
					sessionId: "sub1",
					timestamp: "2026-01-01T00:00:03Z",
					message: { role: "user", content: "sub task" },
				}),
				JSON.stringify({
					type: "assistant",
					sessionId: "sub1",
					timestamp: "2026-01-01T00:00:04Z",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "sub answer" }],
					},
				}),
			].join("\n") + "\n",
			"utf8",
		);
		fs.writeFileSync(
			file,
			[
				JSON.stringify({
					type: "system",
					subtype: "init",
					sessionId: "s6",
					timestamp: "2026-01-01T00:00:00Z",
					model: "claude-test",
				}),
				JSON.stringify({
					type: "user",
					sessionId: "s6",
					timestamp: "2026-01-01T00:00:01Z",
					message: { role: "user", content: "hello" },
				}),
				JSON.stringify({
					type: "assistant",
					sessionId: "s6",
					timestamp: "2026-01-01T00:00:02Z",
					message: {
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "toolu_task",
								name: "Task",
								input: {
									description: "do subtask",
									prompt: "sub task",
									subagent_type: "Explore",
								},
							},
						],
					},
				}),
				JSON.stringify({
					type: "progress",
					parentToolUseID: "toolu_task",
					data: {
						agentId: "a1",
						message: {
							type: "file-history-snapshot",
							snapshot: { timestamp: "2026-01-01T00:00:03Z" },
						},
					},
				}),
			].join("\n") + "\n",
			"utf8",
		);

		const records = await collectClaudePromptOnlyRecords(dir);
		expect(records).toHaveLength(2);

		const mainRecord = records.find((record) => record.id === "s6");
		const subagentRecord = records.find(
			(record) => record.id === "s6:subagent:a1",
		);
		if (!mainRecord || !subagentRecord)
			throw new Error("expected main and side-file subagent records");

		expect(mainRecord.messages[1]?.role).toBe("assistant");
		expect(mainRecord.messages[2]?.content).toBe("sub answer");
		expect(mainRecord.meta.lossy_reasons).not.toContain(
			"unmatched_subagent_trajectories",
		);

		expect(subagentRecord.meta.endpoint).toBe("claude/subagent_trace");
		expect(subagentRecord.meta.source).toContain("subagents/agent-a1.jsonl");
		expect(subagentRecord.messages[0]?.content).toBe("sub task");
		expect(subagentRecord.messages[1]?.content).toBe("sub answer");
	});
});

describe("collectClaudeTrajectories", () => {
	it("writes subagent trajectory refs onto matched Task observations", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-history-"));
		const file = path.join(dir, "sample.jsonl");
		const sessionDir = path.join(dir, "sample");
		const subagentsDir = path.join(sessionDir, "subagents");
		fs.mkdirSync(subagentsDir, { recursive: true });
		fs.writeFileSync(
			path.join(subagentsDir, "agent-a1.jsonl"),
			[
				JSON.stringify({
					type: "user",
					sessionId: "sub7",
					timestamp: "2026-01-01T00:00:03Z",
					message: { role: "user", content: "sub task" },
				}),
				JSON.stringify({
					type: "assistant",
					sessionId: "sub7",
					timestamp: "2026-01-01T00:00:04Z",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "sub answer" }],
					},
				}),
			].join("\n") + "\n",
			"utf8",
		);
		fs.writeFileSync(
			file,
			[
				JSON.stringify({
					type: "system",
					subtype: "init",
					sessionId: "s7",
					timestamp: "2026-01-01T00:00:00Z",
					model: "claude-test",
				}),
				JSON.stringify({
					type: "user",
					sessionId: "s7",
					timestamp: "2026-01-01T00:00:01Z",
					message: { role: "user", content: "hello" },
				}),
				JSON.stringify({
					type: "assistant",
					sessionId: "s7",
					timestamp: "2026-01-01T00:00:02Z",
					message: {
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "toolu_task",
								name: "Task",
								input: {
									description: "do subtask",
									prompt: "inline task",
									subagent_type: "Explore",
								},
							},
						],
					},
				}),
				JSON.stringify({
					type: "progress",
					parentToolUseID: "toolu_task",
					data: {
						type: "agent_progress",
						agentId: "a1",
						prompt: "inline task",
						message: {
							type: "user",
							timestamp: "2026-01-01T00:00:03Z",
							message: { role: "user", content: "inline task" },
						},
					},
				}),
				JSON.stringify({
					type: "progress",
					parentToolUseID: "toolu_task",
					data: {
						type: "agent_progress",
						agentId: "a1",
						prompt: "inline task",
						message: {
							type: "assistant",
							timestamp: "2026-01-01T00:00:04Z",
							message: {
								role: "assistant",
								content: [{ type: "text", text: "inline answer" }],
							},
						},
					},
				}),
			].join("\n") + "\n",
			"utf8",
		);

		const trajectories = await collectClaudeTrajectories(dir);
		expect(trajectories).toHaveLength(2);

		const mainTrajectory = trajectories.find(
			(trajectory) => trajectory.session_id === "s7",
		);
		const subagentTrajectory = trajectories.find(
			(trajectory) => trajectory.session_id === "s7:subagent:a1",
		);
		if (!mainTrajectory || !subagentTrajectory)
			throw new Error("expected main and subagent trajectories");

		const taskStep = mainTrajectory.steps.find(
			(step) => step.tool_calls?.[0]?.tool_call_id === "toolu_task",
		);
		expect(taskStep?.observation?.results[0]?.content).toBe("inline answer");
		expect(taskStep?.observation?.results[0]?.subagent_trajectory_ref).toBe(
			subagentTrajectory.session_id,
		);
		expect(
			mainTrajectory.steps.some((step) => step.message === "inline answer"),
		).toBe(false);
	});

	it("prefers inline progress subagent transcripts over side-file fallback when both exist", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-history-"));
		const file = path.join(dir, "sample.jsonl");
		const sessionDir = path.join(dir, "sample");
		const subagentsDir = path.join(sessionDir, "subagents");
		fs.mkdirSync(subagentsDir, { recursive: true });
		fs.writeFileSync(
			path.join(subagentsDir, "agent-a1.jsonl"),
			[
				JSON.stringify({
					type: "user",
					sessionId: "sub-inline",
					timestamp: "2026-01-01T00:00:04Z",
					message: { role: "user", content: "side fallback task" },
				}),
				JSON.stringify({
					type: "assistant",
					sessionId: "sub-inline",
					timestamp: "2026-01-01T00:00:05Z",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "side fallback answer" }],
					},
				}),
			].join("\n") + "\n",
			"utf8",
		);
		fs.writeFileSync(
			file,
			[
				JSON.stringify({
					type: "system",
					subtype: "init",
					sessionId: "s8",
					timestamp: "2026-01-01T00:00:00Z",
					model: "claude-test",
				}),
				JSON.stringify({
					type: "user",
					sessionId: "s8",
					timestamp: "2026-01-01T00:00:01Z",
					message: { role: "user", content: "hello" },
				}),
				JSON.stringify({
					type: "assistant",
					sessionId: "s8",
					timestamp: "2026-01-01T00:00:02Z",
					message: {
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "toolu_task",
								name: "Task",
								input: {
									description: "do subtask",
									prompt: "inline task",
									subagent_type: "Explore",
								},
							},
						],
					},
				}),
				JSON.stringify({
					type: "progress",
					parentToolUseID: "toolu_task",
					data: {
						type: "agent_progress",
						agentId: "a1",
						prompt: "inline task",
						message: {
							type: "user",
							timestamp: "2026-01-01T00:00:03Z",
							message: { role: "user", content: "inline task" },
						},
					},
				}),
				JSON.stringify({
					type: "progress",
					parentToolUseID: "toolu_task",
					data: {
						type: "agent_progress",
						agentId: "a1",
						prompt: "inline task",
						message: {
							type: "assistant",
							timestamp: "2026-01-01T00:00:04Z",
							message: {
								role: "assistant",
								content: [{ type: "text", text: "inline answer" }],
							},
						},
					},
				}),
			].join("\n") + "\n",
			"utf8",
		);

		const trajectories = await collectClaudeTrajectories(dir);
		expect(trajectories).toHaveLength(2);

		const subagentTrajectory = trajectories.find(
			(trajectory) => trajectory.session_id === "s8:subagent:a1",
		);
		if (!subagentTrajectory)
			throw new Error("expected inline subagent trajectory");

		expect(subagentTrajectory.agent.extra?.source_kind).toBe("inline_subagent");
		expect(subagentTrajectory.steps.map((step) => step.message)).toEqual([
			"inline task",
			"inline answer",
		]);
		expect(
			subagentTrajectory.steps.some(
				(step) => step.message === "side fallback answer",
			),
		).toBe(false);
	});
});
