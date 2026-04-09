import fs from "node:fs";
import fg from "fast-glob";
import { atifTrajectoryToQwen35Record } from "../atif-to-qwen.js";
import {
	AtifTrajectorySchema,
	type AtifObservationResult,
	type AtifStep,
	type AtifToolCall,
	type AtifTrajectory,
} from "../schemas/atif.js";
import { Qwen35RecordSchema, type Qwen35Record } from "../schemas/qwen35.js";
import {
	PiSessionEntrySchema,
	PiSessionHeaderSchema,
	type PiSessionEntry,
} from "../schemas/source.js";
import { isFile } from "../utils/common.js";
import { readJsonl } from "../utils/jsonl.js";

type Qwen35Content = Qwen35Record["messages"][number]["content"];
type PiToolDefinition = Qwen35Record["tools"][number];

interface PiProjectionMetadata {
	endpoint: "pi/session_branch";
	ts: string;
	key?: string;
	source: string;
	source_file: string;
	source_session_id: string;
	leaf_id?: string;
	requested_model?: string;
	actual_model?: string;
	thinking_level?: string;
	lossy_reasons: string[];
}

interface ParsedPiAssistant {
	content: Qwen35Content;
	text: string;
	reasoning?: string;
	toolCalls: AtifToolCall[];
}

export async function collectPiTrajectories(
	root: string,
): Promise<AtifTrajectory[]> {
	const files = await fg("**/*.jsonl", {
		cwd: root,
		absolute: true,
		onlyFiles: true,
	});
	const trajectories: AtifTrajectory[] = [];

	for (const file of files.sort()) {
		const rawRows = await readJsonl(file);
		const rows = rawRows.map((row, index) =>
			index === 0
				? PiSessionHeaderSchema.parse(row)
				: PiSessionEntrySchema.parse(row),
		);
		if (!rows.length) continue;

		const header = rows[0] as Record<string, unknown>;
		const body = rows.slice(1);
		const byId = new Map<string, PiSessionEntry>();
		const children = new Map<string | null, string[]>();
		for (const entry of body) {
			if (!entry.id) continue;
			byId.set(entry.id, entry);
			const key = typeof entry.parentId === "string" ? entry.parentId : null;
			const bucket = children.get(key) ?? [];
			bucket.push(entry.id);
			children.set(key, bucket);
		}

		const leaves = [...byId.keys()]
			.filter((id) => !children.get(id)?.length)
			.sort();
		for (const leaf of leaves) {
			const pathEntries = branchEntries(leaf, byId);
			const trajectory = buildPiTrajectory(
				pathEntries,
				header,
				file,
				leaves.length > 1,
			);
			if (!trajectory) {
				console.warn(
					`[pi] skipped branch without user message ${file}#leaf=${leaf}`,
				);
				continue;
			}
			trajectories.push(AtifTrajectorySchema.parse(trajectory));
		}
	}

	return trajectories;
}

export async function collectPiRecords(root: string): Promise<Qwen35Record[]> {
	const trajectories = await collectPiTrajectories(root);
	return trajectories.map((trajectory) =>
		Qwen35RecordSchema.parse(projectPiTrajectoryToQwen35Record(trajectory)),
	);
}

function branchEntries(
	leaf: string,
	byId: Map<string, PiSessionEntry>,
): PiSessionEntry[] {
	const ordered: PiSessionEntry[] = [];
	let current: string | null = leaf;
	while (current) {
		const entry = byId.get(current);
		if (!entry) break;
		ordered.push(entry);
		current = typeof entry.parentId === "string" ? entry.parentId : null;
	}
	return ordered.reverse();
}

function buildPiTrajectory(
	entries: PiSessionEntry[],
	header: Record<string, unknown>,
	sourceFile: string,
	branched: boolean,
): AtifTrajectory | null {
	const steps: AtifTrajectory["steps"] = [];
	const tools = new Map<string, PiToolDefinition>();
	const lossyReasons = new Set<string>();
	const models: string[] = [];
	const thinkingLevels: string[] = [];
	let currentModel: string | undefined;
	let currentThinkingLevel: string | undefined;
	let pendingAgentStep: AtifStep | null = null;

	const flushPendingAgentStep = () => {
		if (!pendingAgentStep) return;
		pendingAgentStep.step_id = steps.length + 1;
		steps.push(pendingAgentStep);
		pendingAgentStep = null;
	};

	for (const entry of entries) {
		if (entry.type === "model_change") {
			const provider = asString((entry as Record<string, unknown>).provider);
			const modelId = asString((entry as Record<string, unknown>).modelId);
			if (modelId) {
				currentModel = provider ? `${provider}/${modelId}` : modelId;
				models.push(currentModel);
			}
			continue;
		}

		if (entry.type === "thinking_level_change") {
			const level = asString((entry as Record<string, unknown>).thinkingLevel);
			if (level) {
				currentThinkingLevel = level;
				thinkingLevels.push(level);
			}
			continue;
		}

		if (entry.type === "message") {
			const msg = (entry as Record<string, unknown>).message as
				| Record<string, unknown>
				| undefined;
			if (!msg) continue;
			const role = asString(msg.role);
			if (role === "user") {
				flushPendingAgentStep();
				const content = normalizePiContent(msg.content, lossyReasons, "user");
				steps.push({
					step_id: steps.length + 1,
					timestamp: entry.timestamp,
					source: "user",
					message: renderPiContentAsText(content),
					extra: buildPiExtra({
						qwen_content: content,
						step_kind: "user_message",
					}),
				});
				continue;
			}

			if (role === "assistant") {
				flushPendingAgentStep();
				const parsed = parsePiAssistantMessage(msg, tools, lossyReasons);
				pendingAgentStep = {
					step_id: 0,
					timestamp: entry.timestamp,
					source: "agent",
					message: parsed.text,
					reasoning_content: parsed.reasoning,
					model_name: currentModel,
					tool_calls:
						parsed.toolCalls.length > 0 ? parsed.toolCalls : undefined,
					extra: buildPiExtra({
						qwen_content: parsed.content,
						step_kind: "assistant_message",
						thinking_level: currentThinkingLevel,
					}),
				};
				continue;
			}

			if (role === "toolResult") {
				attachPiToolResult(
					tools,
					lossyReasons,
					currentModel,
					entry.timestamp,
					msg,
					() => pendingAgentStep,
					(nextStep) => {
						pendingAgentStep = nextStep;
					},
				);
				continue;
			}

			if (role === "bashExecution") {
				attachPiBashExecution(
					tools,
					lossyReasons,
					currentModel,
					entry.timestamp,
					msg,
					() => pendingAgentStep,
					(nextStep) => {
						pendingAgentStep = nextStep;
					},
				);
			}
			continue;
		}

		if (entry.type === "branch_summary") {
			flushPendingAgentStep();
			const summary = asString((entry as Record<string, unknown>).summary);
			if (summary) {
				lossyReasons.add("synthetic_branch_summary");
				steps.push({
					step_id: steps.length + 1,
					timestamp: entry.timestamp,
					source: "agent",
					message: `[branch_summary]\n${summary}`,
					model_name: currentModel,
					extra: buildPiExtra({
						qwen_content: `[branch_summary]\n${summary}`,
						step_kind: "branch_summary",
						thinking_level: currentThinkingLevel,
					}),
				});
			}
			continue;
		}

		if (entry.type === "compaction") {
			flushPendingAgentStep();
			const summary = asString((entry as Record<string, unknown>).summary);
			if (summary) {
				lossyReasons.add("synthetic_compaction_summary");
				steps.push({
					step_id: steps.length + 1,
					timestamp: entry.timestamp,
					source: "agent",
					message: `[compaction_summary]\n${summary}`,
					model_name: currentModel,
					extra: buildPiExtra({
						qwen_content: `[compaction_summary]\n${summary}`,
						step_kind: "compaction_summary",
						thinking_level: currentThinkingLevel,
					}),
				});
			}
		}
	}

	flushPendingAgentStep();

	if (branched) lossyReasons.add("session_tree_branch_selected");
	if (new Set(models).size > 1) lossyReasons.add("multiple_models_on_branch");
	if (new Set(thinkingLevels).size > 1)
		lossyReasons.add("multiple_thinking_levels_on_branch");
	if (!steps.some((step) => step.source === "user") || steps.length === 0)
		return null;

	const leafId = entries.at(-1)?.id;
	const sessionId = `${asString(header.id) ?? "pi"}:${leafId ?? "leaf"}`;
	const projectionMetadata: PiProjectionMetadata = {
		endpoint: "pi/session_branch",
		ts: asString(entries.at(-1)?.timestamp) ?? asString(header.timestamp) ?? "",
		key: asString(header.id),
		source: `${sourceFile}#leaf=${leafId ?? ""}`,
		source_file: sourceFile,
		source_session_id: asString(header.id) ?? sessionId,
		leaf_id: leafId,
		requested_model: models[0] ?? undefined,
		actual_model: models.at(-1) ?? undefined,
		thinking_level: thinkingLevels.at(-1) ?? undefined,
		lossy_reasons: [...lossyReasons],
	};

	return {
		schema_version: "ATIF-v1.4",
		session_id: sessionId,
		agent: {
			name: "pi",
			model_name: currentModel,
			extra: compactJsonObject({
				source_file: sourceFile,
				source_session_id: asString(header.id),
				leaf_id: leafId,
				cwd: asString(header.cwd),
				thinking_level: currentThinkingLevel,
			}),
		},
		steps,
		final_metrics: {
			total_steps: steps.length,
		},
		extra: buildPiExtra(projectionMetadata),
	};
}

function attachPiToolResult(
	tools: Map<string, PiToolDefinition>,
	lossyReasons: Set<string>,
	currentModel: string | undefined,
	timestamp: string | undefined,
	msg: Record<string, unknown>,
	getPendingAgentStep: () => AtifStep | null,
	setPendingAgentStep: (step: AtifStep) => void,
): void {
	const toolName = asString(msg.toolName) ?? "tool";
	tools.set(toolName, { name: toolName });
	const content = normalizePiContent(msg.content, lossyReasons, "tool_result");
	const hostStep = ensurePiObservationHostStep(
		toolName,
		asString(msg.toolCallId),
		currentModel,
		timestamp,
		getPendingAgentStep,
		setPendingAgentStep,
	);
	const observation = hostStep.observation ?? { results: [] };
	observation.results.push({
		source_call_id: ensurePiToolCallId(
			hostStep,
			toolName,
			asString(msg.toolCallId),
		),
		content: renderPiContentAsText(content),
		extra: buildPiExtra({ qwen_content: content }),
	});
	hostStep.observation = observation;
}

function attachPiBashExecution(
	tools: Map<string, PiToolDefinition>,
	lossyReasons: Set<string>,
	currentModel: string | undefined,
	timestamp: string | undefined,
	msg: Record<string, unknown>,
	getPendingAgentStep: () => AtifStep | null,
	setPendingAgentStep: (step: AtifStep) => void,
): void {
	tools.set("bash", { name: "bash" });
	const output = formatBash(msg, lossyReasons);
	const hostStep = ensurePiObservationHostStep(
		"bash",
		undefined,
		currentModel,
		timestamp,
		getPendingAgentStep,
		setPendingAgentStep,
	);
	const observation = hostStep.observation ?? { results: [] };
	observation.results.push({
		source_call_id: ensurePiToolCallId(hostStep, "bash", undefined),
		content: output,
		extra: buildPiExtra({ qwen_content: output, step_kind: "bash_execution" }),
	});
	hostStep.observation = observation;
}

function ensurePiObservationHostStep(
	toolName: string,
	toolCallId: string | undefined,
	currentModel: string | undefined,
	timestamp: string | undefined,
	getPendingAgentStep: () => AtifStep | null,
	setPendingAgentStep: (step: AtifStep) => void,
): AtifStep {
	const pendingAgentStep = getPendingAgentStep();
	if (pendingAgentStep) {
		ensurePiToolCallId(pendingAgentStep, toolName, toolCallId);
		return pendingAgentStep;
	}

	const step: AtifStep = {
		step_id: 0,
		timestamp,
		source: "agent",
		message: "",
		model_name: currentModel,
		tool_calls: [],
		extra: buildPiExtra({ step_kind: "synthetic_tool_host", qwen_content: "" }),
	};
	ensurePiToolCallId(step, toolName, toolCallId);
	setPendingAgentStep(step);
	return step;
}

function ensurePiToolCallId(
	step: AtifStep,
	toolName: string,
	toolCallId: string | undefined,
): string {
	const toolCalls = step.tool_calls ?? [];
	if (toolCallId) {
		const existingById = toolCalls.find(
			(toolCall) => toolCall.tool_call_id === toolCallId,
		);
		if (existingById) {
			step.tool_calls = toolCalls;
			return existingById.tool_call_id;
		}
	}

	const existingByName = toolCalls.find(
		(toolCall) => toolCall.function_name === toolName,
	);
	if (existingByName) {
		step.tool_calls = toolCalls;
		return existingByName.tool_call_id;
	}

	const nextId =
		toolCallId ?? `pi_tool_call_${toolName}_${toolCalls.length + 1}`;
	toolCalls.push({
		tool_call_id: nextId,
		function_name: toolName,
		arguments: {},
		extra: { synthesized_from_source_message: true },
	});
	step.tool_calls = toolCalls;
	return nextId;
}

function parsePiAssistantMessage(
	msg: Record<string, unknown>,
	tools: Map<string, PiToolDefinition>,
	lossyReasons: Set<string>,
): ParsedPiAssistant {
	const content = msg.content;
	const textBlocks: Array<{ type: "text"; text: string }> = [];
	const reasoning: string[] = [];
	const toolCalls: AtifToolCall[] = [];

	if (Array.isArray(content)) {
		for (const raw of content) {
			if (!raw || typeof raw !== "object") continue;
			const block = raw as Record<string, unknown>;
			const type = asString(block.type);
			if (type === "text") {
				textBlocks.push({ type: "text", text: asString(block.text) ?? "" });
				continue;
			}
			if (type === "thinking") {
				const rawThinking = asString(block.thinking);
				const thinking = sanitizePiThinking(rawThinking);
				if (thinking) reasoning.push(thinking);
				if (!thinking && asString(block.thinkingSignature)) {
					lossyReasons.add("encrypted_reasoning_without_visible_text");
				}
				continue;
			}
			if (type === "toolCall") {
				const name = asString(block.name) ?? "tool";
				tools.set(name, { name });
				toolCalls.push({
					tool_call_id:
						asString(block.id) ??
						`pi_tool_call_${name}_${toolCalls.length + 1}`,
					function_name: name,
					arguments: isRecord(block.arguments) ? block.arguments : {},
				});
			}
		}
	}

	const normalizedContent: Qwen35Content =
		textBlocks.length === 1 ? textBlocks[0].text : textBlocks;

	return {
		content: normalizedContent,
		text: renderPiContentAsText(normalizedContent),
		reasoning: reasoning.length > 0 ? reasoning.join("\n\n") : undefined,
		toolCalls,
	};
}

function projectPiTrajectoryToQwen35Record(
	trajectory: AtifTrajectory,
): Qwen35Record {
	const baseRecord = atifTrajectoryToQwen35Record(trajectory);
	const projection = readPiProjectionMetadata(trajectory.extra);
	if (!projection) {
		return Qwen35RecordSchema.parse(baseRecord);
	}

	const messages = buildProjectedPiMessages(trajectory);
	const tools = collectTrajectoryTools(trajectory);
	return Qwen35RecordSchema.parse({
		...baseRecord,
		id: trajectory.session_id,
		request_id: projection.source_session_id,
		messages,
		tools,
		meta: buildMeta(messages, {
			endpoint: projection.endpoint,
			ts: projection.ts,
			key: projection.key,
			source: projection.source,
			requested_model: projection.requested_model,
			actual_model: projection.actual_model,
			thinking_level: projection.thinking_level,
			tool_spec_count: tools.length,
			tool_choice: { mode: "session_trace" },
			reasoning_summary_mode: "pi_session_branch",
			thinking_type: "pi_session",
			lossy_reasons: projection.lossy_reasons,
		}),
	});
}

function buildProjectedPiMessages(
	trajectory: AtifTrajectory,
): Qwen35Record["messages"] {
	const messages: Qwen35Record["messages"] = [];

	for (const step of trajectory.steps) {
		if (step.source === "system") {
			messages.push({ role: "system", content: readPiStepQwenContent(step) });
			continue;
		}

		if (step.source === "user") {
			messages.push({ role: "user", content: readPiStepQwenContent(step) });
			continue;
		}

		const stepContent = readPiStepQwenContent(step);
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
				content: readPiObservationQwenContent(result),
			});
		}
	}

	return messages;
}

function collectTrajectoryTools(
	trajectory: AtifTrajectory,
): PiToolDefinition[] {
	const tools = new Map<string, PiToolDefinition>();
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

function normalizePiContent(
	content: unknown,
	lossyReasons: Set<string>,
	prefix: string,
): Qwen35Content {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) {
		lossyReasons.add(`${prefix}_nonstandard_content`);
		return JSON.stringify(content);
	}

	const blocks: Array<Record<string, unknown>> = [];
	for (const raw of content) {
		if (!raw || typeof raw !== "object") continue;
		const block = raw as Record<string, unknown>;
		const type = asString(block.type);
		if (type === "text")
			blocks.push({ type: "text", text: asString(block.text) ?? "" });
	}
	if (blocks.length === 1) return blocks[0].text as string;
	return blocks as Qwen35Content;
}

function sanitizePiThinking(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const cleaned = value
		.replace(/^\s*<think>\s*/i, "")
		.replace(/\s*<\/think>\s*$/i, "")
		.trim();
	return cleaned || undefined;
}

function formatBash(
	msg: Record<string, unknown>,
	lossyReasons: Set<string>,
): string {
	const truncated = Boolean(msg.truncated);
	let output = asString(msg.output) ?? "";
	const fullOutputPath =
		asString(msg.fullOutputPath) ??
		asString(
			(msg.details as Record<string, unknown> | undefined)?.fullOutputPath,
		);
	if (truncated && fullOutputPath) {
		if (isFile(fullOutputPath)) {
			output = fs.readFileSync(fullOutputPath, "utf8");
		} else {
			lossyReasons.add("missing_embedded_full_output");
		}
	}
	return JSON.stringify({
		command: asString(msg.command),
		exit_code: asNumber(msg.exitCode),
		cancelled: Boolean(msg.cancelled),
		truncated,
		exclude_from_context: Boolean(msg.excludeFromContext),
		output,
	});
}

function buildMeta(
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
		status: 200,
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
		response_truncated: lossyReasons.includes("missing_embedded_full_output"),
		lossy_source: lossyReasons.length > 0,
		lossy_reasons: lossyReasons,
	};
}

function buildPiExtra(value: unknown): Record<string, unknown> | undefined {
	const compacted = compactJsonObject(value);
	return compacted ? { pi_export: compacted } : undefined;
}

function readPiProjectionMetadata(
	value: unknown,
): PiProjectionMetadata | undefined {
	if (!isRecord(value) || !isRecord(value.pi_export)) return undefined;
	const raw = value.pi_export;
	const endpoint = asString(raw.endpoint);
	const ts = asString(raw.ts);
	const source = asString(raw.source);
	const sourceFile = asString(raw.source_file);
	const sourceSessionId = asString(raw.source_session_id);
	if (!endpoint || !ts || !source || !sourceFile || !sourceSessionId)
		return undefined;
	return {
		endpoint: endpoint === "pi/session_branch" ? endpoint : "pi/session_branch",
		ts,
		key: asString(raw.key),
		source,
		source_file: sourceFile,
		source_session_id: sourceSessionId,
		leaf_id: asString(raw.leaf_id),
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

function readPiStepQwenContent(step: AtifStep): Qwen35Content {
	const projection = isRecord(step.extra?.pi_export)
		? step.extra.pi_export
		: undefined;
	const content = projection?.qwen_content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content as Qwen35Content;
	return step.message ?? "";
}

function readPiObservationQwenContent(
	result: AtifObservationResult,
): Qwen35Content {
	const projection = isRecord(result.extra?.pi_export)
		? result.extra.pi_export
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
	const projection = isRecord(step.extra?.pi_export)
		? step.extra.pi_export
		: undefined;
	return (
		asString(projection?.step_kind) === "synthetic_tool_host" &&
		renderPiContentAsText(content).trim().length === 0 &&
		!step.reasoning_content
	);
}

function renderPiContentAsText(content: Qwen35Content): string {
	if (typeof content === "string") return content;
	return content
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("");
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

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
