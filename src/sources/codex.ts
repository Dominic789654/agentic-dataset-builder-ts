import fg from "fast-glob";
import { atifTrajectoryToQwen35Record } from "../atif-to-qwen.js";
import {
	AtifTrajectorySchema,
	type AtifObservationResult,
	type AtifStep,
	type AtifTrajectory,
} from "../schemas/atif.js";
import { Qwen35RecordSchema, type Qwen35Record } from "../schemas/qwen35.js";
import { CodexEntrySchema, type CodexEntry } from "../schemas/source.js";
import { readJsonl } from "../utils/jsonl.js";

type Qwen35Content = Qwen35Record["messages"][number]["content"];
type CodexToolDefinition = Qwen35Record["tools"][number];

interface CodexProjectionMetadata {
	endpoint: "codex/turn";
	ts: string;
	key?: string;
	source: string;
	source_file: string;
	source_session_id?: string;
	turn_id: string;
	requested_model?: string;
	actual_model?: string;
	thinking_level?: string;
	lossy_reasons: string[];
}

class TurnTrajectoryBuilder {
	sessionMeta: Record<string, unknown>;
	sourceFile: string;
	turnId: string;
	startTs: string;
	lastTs: string;
	lastAgentMessage?: string;
	tools = new Map<string, CodexToolDefinition>();
	lossyReasons = new Set<string>();
	steps: AtifTrajectory["steps"] = [];
	draftAgentStep: AtifStep | null = null;
	openObservationStep: AtifStep | null = null;

	constructor(
		sessionMeta: Record<string, unknown>,
		sourceFile: string,
		turnId: string,
		startTs: string,
	) {
		this.sessionMeta = sessionMeta;
		this.sourceFile = sourceFile;
		this.turnId = turnId;
		this.startTs = startTs;
		this.lastTs = startTs;
	}

	ingest(entry: CodexEntry) {
		this.lastTs = entry.timestamp ?? this.lastTs;
		const payload = (entry.payload ?? {}) as Record<string, unknown>;
		if (entry.type === "response_item")
			this.ingestResponseItem(payload, entry.timestamp);
		if (entry.type === "event_msg") this.ingestEvent(payload, entry.timestamp);
	}

	ingestResponseItem(payload: Record<string, unknown>, timestamp?: string) {
		const type = asString(payload.type);
		if (type === "message") this.ingestMessage(payload, timestamp);
		if (type === "reasoning") this.ingestReasoning(payload, timestamp);
		if (type === "function_call") this.ingestFunctionCall(payload, timestamp);
		if (type === "function_call_output")
			this.ingestFunctionCallOutput(payload, timestamp);
		if (type === "custom_tool_call")
			this.ingestCustomToolCall(payload, timestamp);
		if (type === "custom_tool_call_output")
			this.ingestCustomToolCallOutput(payload, timestamp);
	}

	ingestEvent(payload: Record<string, unknown>, timestamp?: string) {
		const type = asString(payload.type);
		if (type === "exec_command_end")
			this.ingestExecCommandEnd(payload, timestamp);
		if (type === "task_complete") {
			const message = asString(payload.last_agent_message);
			if (message) this.lastAgentMessage = message;
		}
		if (type === "error" && asString(payload.message))
			this.lossyReasons.add("turn_error");
	}

	ingestMessage(payload: Record<string, unknown>, timestamp?: string) {
		const role = asString(payload.role);
		const content = Array.isArray(payload.content) ? payload.content : [];
		const text = extractCodexText(content as Record<string, unknown>[]);

		if (role === "assistant") {
			this.flushOpenObservationStep();
			const step = this.ensureDraftAgentStep(timestamp);
			const nextContent = appendTextContent(
				readCodexStepQwenContent(step),
				text,
			);
			step.message = renderCodexContentAsText(nextContent);
			step.extra = buildCodexExtra({
				...(isRecord(step.extra?.codex_export) ? step.extra.codex_export : {}),
				qwen_content: nextContent,
				step_kind: "assistant_message",
			});
			return;
		}

		this.flushOpenObservationStep();
		this.flushDraftAgentStep();

		if (role === "user") {
			this.steps.push({
				step_id: this.steps.length + 1,
				timestamp,
				source: "user",
				message: text,
				extra: buildCodexExtra({
					qwen_content: text,
					step_kind: "user_message",
				}),
			});
			return;
		}

		if (role === "developer" && text) {
			const seenNonSystem = this.steps.some((step) => step.source !== "system");
			if (seenNonSystem) {
				this.lossyReasons.add("late_developer_message_demoted");
				this.steps.push({
					step_id: this.steps.length + 1,
					timestamp,
					source: "agent",
					message: `[developer]\n${text}`,
					model_name: asString(this.sessionMeta.model),
					extra: buildCodexExtra({
						qwen_content: `[developer]\n${text}`,
						step_kind: "late_developer_message_demoted",
					}),
				});
			} else {
				this.steps.push({
					step_id: this.steps.length + 1,
					timestamp,
					source: "system",
					message: text,
					extra: buildCodexExtra({
						qwen_content: text,
						step_kind: "developer_message",
					}),
				});
			}
		}
	}

	ingestReasoning(payload: Record<string, unknown>, timestamp?: string) {
		this.flushOpenObservationStep();
		const step = this.ensureDraftAgentStep(timestamp);
		const summary = Array.isArray(payload.summary) ? payload.summary : [];
		const visible = summary
			.map((item) =>
				item && typeof item === "object"
					? (asString((item as Record<string, unknown>).text) ??
						asString((item as Record<string, unknown>).summary_text))
					: undefined,
			)
			.filter((value): value is string => Boolean(value));
		const content = asString(payload.content);
		if (content) visible.push(content);
		if (visible.length > 0) {
			step.reasoning_content = appendParagraphText(
				step.reasoning_content,
				visible.join("\n\n"),
			);
			return;
		}
		if (payload.encrypted_content)
			this.lossyReasons.add("encrypted_reasoning_without_summary");
	}

	ingestFunctionCall(payload: Record<string, unknown>, timestamp?: string) {
		this.flushOpenObservationStep();
		const step = this.ensureDraftAgentStep(timestamp);
		const name = asString(payload.name) ?? "tool";
		const callId =
			asString(payload.call_id) ??
			`codex_tool_call_${this.turnId}_${(step.tool_calls?.length ?? 0) + 1}`;
		const args = parseJsonObject(payload.arguments);
		this.tools.set(name, { name });
		const toolCalls = step.tool_calls ?? [];
		toolCalls.push({
			tool_call_id: callId,
			function_name: name,
			arguments: args,
			extra: buildCodexExtra({
				raw_arguments: payload.arguments,
				step_kind: "function_call",
			}),
		});
		step.tool_calls = toolCalls;
	}

	ingestCustomToolCall(payload: Record<string, unknown>, timestamp?: string) {
		this.flushOpenObservationStep();
		const step = this.ensureDraftAgentStep(timestamp);
		const name = asString(payload.name) ?? "custom_tool";
		const callId =
			asString(payload.call_id) ??
			`codex_tool_call_${this.turnId}_${(step.tool_calls?.length ?? 0) + 1}`;
		this.tools.set(name, { name });
		const toolCalls = step.tool_calls ?? [];
		toolCalls.push({
			tool_call_id: callId,
			function_name: name,
			arguments:
				compactJsonObject({ input: payload.input, status: payload.status }) ??
				{},
			extra: buildCodexExtra({
				raw_input: payload.input,
				status: asString(payload.status),
				step_kind: "custom_tool_call",
			}),
		});
		step.tool_calls = toolCalls;
	}

	ingestFunctionCallOutput(
		payload: Record<string, unknown>,
		timestamp?: string,
	) {
		const openStep = this.prepareObservationHostStep(timestamp);
		const output =
			typeof payload.output === "string"
				? payload.output
				: JSON.stringify(payload.output);
		this.attachObservationResult(
			openStep,
			asString(payload.call_id),
			asString(payload.call_id) ? undefined : "tool",
			output,
			output,
			undefined,
		);
	}

	ingestCustomToolCallOutput(
		payload: Record<string, unknown>,
		timestamp?: string,
	) {
		this.ingestFunctionCallOutput(payload, timestamp);
	}

	ingestExecCommandEnd(payload: Record<string, unknown>, timestamp?: string) {
		const openStep = this.prepareObservationHostStep(timestamp);
		const output = JSON.stringify({
			command: payload.command,
			cwd: payload.cwd,
			aggregated_output: payload.aggregated_output,
			exit_code: payload.exit_code,
			status: payload.status,
			duration: payload.duration,
		});
		this.attachObservationResult(
			openStep,
			asString(payload.call_id),
			"exec_command",
			output,
			output,
			"exec_command_end",
		);
	}

	finalize(): AtifTrajectory | null {
		this.flushOpenObservationStep();
		if (this.lastAgentMessage && !this.draftAgentStep) {
			this.lossyReasons.add("synthetic_last_agent_message");
			const step = this.ensureDraftAgentStep(this.lastTs);
			const content = appendTextContent(
				readCodexStepQwenContent(step),
				this.lastAgentMessage,
			);
			step.message = renderCodexContentAsText(content);
			step.extra = buildCodexExtra({
				...(isRecord(step.extra?.codex_export) ? step.extra.codex_export : {}),
				qwen_content: content,
				step_kind: "synthetic_last_agent_message",
			});
		}
		this.flushDraftAgentStep();

		if (!this.steps.some((step) => step.source === "user")) return null;

		const sessionId = `${asString(this.sessionMeta.id) ?? "codex"}:${this.turnId}`;
		const projectionMetadata: CodexProjectionMetadata = {
			endpoint: "codex/turn",
			ts: this.lastTs,
			key: asString(this.sessionMeta.id),
			source: `codex:session=${asString(this.sessionMeta.id)}:turn=${this.turnId}:cwd=${asString(this.sessionMeta.cwd)}`,
			source_file: this.sourceFile,
			source_session_id: asString(this.sessionMeta.id),
			turn_id: this.turnId,
			requested_model: asString(this.sessionMeta.model),
			actual_model: asString(this.sessionMeta.model),
			thinking_level: asString(this.sessionMeta.reasoning_effort),
			lossy_reasons: [...this.lossyReasons],
		};

		return AtifTrajectorySchema.parse({
			schema_version: "ATIF-v1.4",
			session_id: sessionId,
			agent: {
				name: "codex",
				model_name: asString(this.sessionMeta.model),
				extra: compactJsonObject({
					source_file: this.sourceFile,
					source_session_id: asString(this.sessionMeta.id),
					turn_id: this.turnId,
					cwd: asString(this.sessionMeta.cwd),
					thinking_level: asString(this.sessionMeta.reasoning_effort),
				}),
			},
			steps: this.steps,
			final_metrics: {
				total_steps: this.steps.length,
			},
			extra: buildCodexExtra(projectionMetadata),
		});
	}

	private ensureDraftAgentStep(timestamp?: string): AtifStep {
		if (this.draftAgentStep) return this.draftAgentStep;
		this.draftAgentStep = {
			step_id: 0,
			timestamp,
			source: "agent",
			message: "",
			model_name: asString(this.sessionMeta.model),
			extra: buildCodexExtra({
				qwen_content: "",
				step_kind: "assistant_message",
			}),
		};
		return this.draftAgentStep;
	}

	private flushDraftAgentStep() {
		if (!this.draftAgentStep) return;
		this.draftAgentStep.step_id = this.steps.length + 1;
		this.steps.push(this.draftAgentStep);
		this.draftAgentStep = null;
	}

	private flushOpenObservationStep() {
		if (!this.openObservationStep) return;
		this.openObservationStep.step_id = this.steps.length + 1;
		this.steps.push(this.openObservationStep);
		this.openObservationStep = null;
	}

	private prepareObservationHostStep(timestamp?: string): AtifStep {
		if (this.draftAgentStep) {
			this.openObservationStep = this.draftAgentStep;
			this.draftAgentStep = null;
		}
		if (this.openObservationStep) return this.openObservationStep;
		this.openObservationStep = {
			step_id: 0,
			timestamp,
			source: "agent",
			message: "",
			model_name: asString(this.sessionMeta.model),
			tool_calls: [],
			extra: buildCodexExtra({
				qwen_content: "",
				step_kind: "synthetic_tool_host",
			}),
		};
		return this.openObservationStep;
	}

	private attachObservationResult(
		step: AtifStep,
		callId: string | undefined,
		fallbackToolName: string | undefined,
		renderedContent: string,
		qwenContent: Qwen35Content,
		stepKind: string | undefined,
	) {
		const sourceCallId = ensureCodexToolCall(step, callId, fallbackToolName);
		const observation = step.observation ?? { results: [] };
		observation.results.push({
			source_call_id: sourceCallId,
			content: renderedContent,
			extra: buildCodexExtra({
				qwen_content: qwenContent,
				step_kind: stepKind,
			}),
		});
		step.observation = observation;
	}
}

export async function collectCodexTrajectories(
	root: string,
): Promise<AtifTrajectory[]> {
	const files = await fg("**/*.jsonl", {
		cwd: root,
		absolute: true,
		onlyFiles: true,
	});
	const trajectories: AtifTrajectory[] = [];

	for (const file of files.sort()) {
		let invalidJsonlLineSkipped = false;
		const entries = (
			await readJsonl(file, {
				skipInvalid: true,
				onInvalidLine: ({ filePath, lineNumber, error }) => {
					console.warn(
						`[codex] skipped invalid JSONL line ${filePath}:${lineNumber}: ${error.message}`,
					);
					invalidJsonlLineSkipped = true;
				},
			})
		).map((entry) => CodexEntrySchema.parse(entry));
		const sessionMeta = (entries.find((entry) => entry.type === "session_meta")
			?.payload ?? {}) as Record<string, unknown>;
		let builder: TurnTrajectoryBuilder | null = null;

		for (const entry of entries) {
			const payload = (entry.payload ?? {}) as Record<string, unknown>;
			if (entry.type === "turn_context") {
				sessionMeta.model = payload.model;
				sessionMeta.reasoning_effort = payload.effort;
			}
			if (entry.type === "event_msg" && payload.type === "task_started") {
				builder = new TurnTrajectoryBuilder(
					sessionMeta,
					file,
					asString(payload.turn_id) ?? entry.timestamp ?? "turn",
					entry.timestamp ?? "",
				);
				if (invalidJsonlLineSkipped)
					builder.lossyReasons.add("invalid_jsonl_line_skipped");
				continue;
			}
			if (!builder) continue;
			builder.ingest(entry);
			if (entry.type === "event_msg" && payload.type === "task_complete") {
				const trajectory = builder.finalize();
				if (trajectory) trajectories.push(trajectory);
				builder = null;
			}
		}
	}

	return trajectories;
}

export async function collectCodexRecords(
	root: string,
): Promise<Qwen35Record[]> {
	const trajectories = await collectCodexTrajectories(root);
	return trajectories.map((trajectory) =>
		Qwen35RecordSchema.parse(projectCodexTrajectoryToQwen35Record(trajectory)),
	);
}

function projectCodexTrajectoryToQwen35Record(
	trajectory: AtifTrajectory,
): Qwen35Record {
	const baseRecord = atifTrajectoryToQwen35Record(trajectory);
	const projection = readCodexProjectionMetadata(trajectory.extra);
	if (!projection) return Qwen35RecordSchema.parse(baseRecord);

	const messages = buildProjectedCodexMessages(trajectory);
	const tools = collectTrajectoryTools(trajectory);
	return Qwen35RecordSchema.parse({
		...baseRecord,
		id: trajectory.session_id,
		request_id: projection.turn_id,
		messages,
		tools,
		meta: buildCodexMeta(messages, {
			endpoint: projection.endpoint,
			ts: projection.ts,
			key: projection.key,
			source: projection.source,
			requested_model: projection.requested_model,
			actual_model: projection.actual_model,
			thinking_level: projection.thinking_level,
			tool_spec_count: tools.length,
			tool_choice: { mode: "session_trace" },
			reasoning_summary_mode: "codex_reasoning_summary",
			thinking_type: "codex_turn",
			lossy_reasons: projection.lossy_reasons,
			status: projection.lossy_reasons.includes("turn_error") ? 500 : 200,
		}),
	});
}

function buildProjectedCodexMessages(
	trajectory: AtifTrajectory,
): Qwen35Record["messages"] {
	const messages: Qwen35Record["messages"] = [];

	for (const step of trajectory.steps) {
		if (step.source === "system") {
			messages.push({
				role: "system",
				content: readCodexStepQwenContent(step),
			});
			continue;
		}

		if (step.source === "user") {
			messages.push({ role: "user", content: readCodexStepQwenContent(step) });
			continue;
		}

		const stepContent = readCodexStepQwenContent(step);
		if (!shouldSkipSyntheticToolHost(step, stepContent)) {
			const assistant: Extract<
				Qwen35Record["messages"][number],
				{ role: "assistant" }
			> = {
				role: "assistant",
				content: stepContent,
			};
			if (step.reasoning_content)
				assistant.reasoning_content = step.reasoning_content;
			if (step.tool_calls?.length) {
				assistant.tool_calls = step.tool_calls.map((toolCall) => ({
					type: "function",
					id: toolCall.tool_call_id,
					function: {
						name: toolCall.function_name,
						arguments: toolCall.arguments,
					},
				}));
			}
			messages.push(assistant);
		}

		const toolNameById = new Map(
			(step.tool_calls ?? []).map((toolCall) => [
				toolCall.tool_call_id,
				toolCall.function_name,
			]),
		);
		for (const result of step.observation?.results ?? []) {
			messages.push({
				role: "tool",
				name: toolNameById.get(result.source_call_id),
				tool_call_id: result.source_call_id,
				content: readCodexObservationQwenContent(result),
			});
		}
	}

	return messages;
}

function collectTrajectoryTools(
	trajectory: AtifTrajectory,
): CodexToolDefinition[] {
	const tools = new Map<string, CodexToolDefinition>();
	for (const step of trajectory.steps) {
		for (const toolCall of step.tool_calls ?? []) {
			if (!tools.has(toolCall.function_name)) {
				tools.set(toolCall.function_name, {
					name: toolCall.function_name,
					parameters: toolCall.arguments,
				});
			}
		}
	}
	return [...tools.values()];
}

function ensureCodexToolCall(
	step: AtifStep,
	callId: string | undefined,
	fallbackToolName: string | undefined,
): string {
	const toolCalls = step.tool_calls ?? [];
	if (callId) {
		const existingById = toolCalls.find(
			(toolCall) => toolCall.tool_call_id === callId,
		);
		if (existingById) {
			step.tool_calls = toolCalls;
			return existingById.tool_call_id;
		}
	}

	const functionName = fallbackToolName ?? "tool";
	const existingByName = toolCalls.find(
		(toolCall) => toolCall.function_name === functionName,
	);
	if (existingByName) {
		step.tool_calls = toolCalls;
		return existingByName.tool_call_id;
	}

	const nextId = callId ?? `codex_tool_call_${toolCalls.length + 1}`;
	toolCalls.push({
		tool_call_id: nextId,
		function_name: functionName,
		arguments: {},
		extra: { synthesized_from_source_event: true },
	});
	step.tool_calls = toolCalls;
	return nextId;
}

function buildCodexMeta(
	messages: Qwen35Record["messages"],
	seed: Record<string, unknown>,
) {
	const assistantMessages = messages.filter(
		(message) => message.role === "assistant",
	);
	const toolMessages = messages.filter((message) => message.role === "tool");
	const lossyReasons = Array.isArray(seed.lossy_reasons)
		? seed.lossy_reasons.filter(
				(reason): reason is string => typeof reason === "string",
			)
		: [];

	return {
		endpoint: seed.endpoint,
		status: seed.status,
		ts: seed.ts,
		key: seed.key,
		source: seed.source,
		requested_model: seed.requested_model,
		actual_model: seed.actual_model,
		stream: false,
		thinking_level: seed.thinking_level,
		reasoning_summary_mode: seed.reasoning_summary_mode,
		thinking_type: seed.thinking_type,
		thinking_budget_tokens: undefined,
		max_output_tokens: undefined,
		tool_spec_count: seed.tool_spec_count,
		tool_choice: seed.tool_choice,
		request_contains_non_text_content: false,
		request_image_block_count: 0,
		request_video_block_count: 0,
		request_tool_call_block_count: 0,
		request_tool_result_block_count: 0,
		request_thinking_block_count: 0,
		response_contains_non_text_content: false,
		response_image_block_count: 0,
		response_video_block_count: 0,
		response_tool_call_block_count: assistantMessages.reduce(
			(sum, message) => sum + (message.tool_calls?.length ?? 0),
			0,
		),
		response_tool_result_block_count: toolMessages.length,
		response_thinking_block_count: assistantMessages.filter(
			(message) =>
				typeof message.reasoning_content === "string" &&
				message.reasoning_content.length > 0,
		).length,
		request_truncated: false,
		response_truncated: false,
		lossy_source: lossyReasons.length > 0,
		lossy_reasons: lossyReasons,
	};
}

function buildCodexExtra(value: unknown): Record<string, unknown> | undefined {
	const compacted = compactJsonObject(value);
	return compacted ? { codex_export: compacted } : undefined;
}

function readCodexProjectionMetadata(
	value: unknown,
): CodexProjectionMetadata | undefined {
	if (!isRecord(value) || !isRecord(value.codex_export)) return undefined;
	const raw = value.codex_export;
	const endpoint = asString(raw.endpoint);
	const ts = asString(raw.ts);
	const source = asString(raw.source);
	const sourceFile = asString(raw.source_file);
	const turnId = asString(raw.turn_id);
	if (!endpoint || !ts || !source || !sourceFile || !turnId) return undefined;
	return {
		endpoint: endpoint === "codex/turn" ? endpoint : "codex/turn",
		ts,
		key: asString(raw.key),
		source,
		source_file: sourceFile,
		source_session_id: asString(raw.source_session_id),
		turn_id: turnId,
		requested_model: asString(raw.requested_model),
		actual_model: asString(raw.actual_model),
		thinking_level: asString(raw.thinking_level),
		lossy_reasons: Array.isArray(raw.lossy_reasons)
			? raw.lossy_reasons.filter(
					(reason): reason is string => typeof reason === "string",
				)
			: [],
	};
}

function readCodexStepQwenContent(step: AtifStep): Qwen35Content {
	const projection = isRecord(step.extra?.codex_export)
		? step.extra.codex_export
		: undefined;
	const content = projection?.qwen_content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content as Qwen35Content;
	return step.message ?? "";
}

function readCodexObservationQwenContent(
	result: AtifObservationResult,
): Qwen35Content {
	const projection = isRecord(result.extra?.codex_export)
		? result.extra.codex_export
		: undefined;
	const content = projection?.qwen_content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content as Qwen35Content;
	return result.content ?? "";
}

function shouldSkipSyntheticToolHost(
	step: AtifStep,
	content: Qwen35Content,
): boolean {
	const projection = isRecord(step.extra?.codex_export)
		? step.extra.codex_export
		: undefined;
	return (
		asString(projection?.step_kind) === "synthetic_tool_host" &&
		renderCodexContentAsText(content).trim().length === 0 &&
		!step.reasoning_content
	);
}

function extractCodexText(content: Record<string, unknown>[]): string {
	return content
		.map((item) => {
			const type = asString(item.type);
			if (
				(type === "input_text" || type === "output_text") &&
				typeof item.text === "string"
			) {
				return item.text;
			}
			if (type === "input_image") return "[image]";
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function appendTextContent(
	content: Qwen35Content,
	text: string,
): Qwen35Content {
	if (!text) return content;
	if (typeof content === "string") {
		if (!content) return text;
		return `${content}\n\n${text}`;
	}

	const blocks = [...content];
	const lastBlock = blocks.at(-1);
	if (lastBlock?.type === "text") {
		lastBlock.text =
			lastBlock.text.length > 0 ? `${lastBlock.text}\n\n${text}` : text;
		return blocks;
	}
	blocks.push({ type: "text", text });
	return blocks;
}

function appendParagraphText(
	existing: string | undefined,
	text: string,
): string {
	if (!existing) return text;
	if (!text) return existing;
	return `${existing}\n\n${text}`;
}

function renderCodexContentAsText(content: Qwen35Content): string {
	if (typeof content === "string") return content;
	return content
		.map((block) => {
			if (block.type === "text") return block.text;
			if (block.type === "image") return block.placeholder_token ?? "[image]";
			return block.placeholder_token ?? "[video]";
		})
		.join("");
}

function parseJsonObject(value: unknown): Record<string, unknown> {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	if (typeof value !== "string") return {};
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? parsed
			: { value: parsed };
	} catch {
		return { raw: value };
	}
}

function compactJsonObject(
	value: unknown,
): Record<string, unknown> | undefined {
	if (!isRecord(value)) return undefined;
	const compacted = compactJsonValue(value);
	return isRecord(compacted) && Object.keys(compacted).length > 0
		? compacted
		: undefined;
}

function compactJsonValue(value: unknown): unknown {
	if (value === undefined || value === null) return value;
	if (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return value;
	}
	if (Array.isArray(value)) {
		return value
			.map((entry) => compactJsonValue(entry))
			.filter((entry) => entry !== undefined);
	}
	if (isRecord(value)) {
		return Object.fromEntries(
			Object.entries(value)
				.map(([key, entry]) => [key, compactJsonValue(entry)] as const)
				.filter(([, entry]) => entry !== undefined),
		);
	}
	return value;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
