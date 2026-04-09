import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { atifTrajectoryToQwen35Record } from "../atif-to-qwen.js";
import {
	AtifTrajectorySchema,
	type AtifMetrics,
	type AtifTrajectory,
} from "../schemas/atif.js";
import { Qwen35RecordSchema, type Qwen35Record } from "../schemas/qwen35.js";
import {
	ClaudeProjectEntrySchema,
	type ClaudeProjectEntry,
} from "../schemas/source.js";
import { readJsonl } from "../utils/jsonl.js";

type Qwen35Message = Qwen35Record["messages"][number];
type Qwen35Content = Qwen35Message["content"];
type AssistantMessage = Extract<Qwen35Message, { role: "assistant" }>;
type ToolMessage = Extract<Qwen35Message, { role: "tool" }>;
type ClaudeEnvelope = Record<string, unknown>;
type ClaudeToolDefinition = Qwen35Record["tools"][number];

interface ToolResultEntry {
	content: unknown;
	isError: boolean;
}

interface SidecarPoolEntry {
	key: string;
	content: Qwen35Content;
	claimed: boolean;
}

interface SidecarStore {
	directByPrefix: Map<string, Qwen35Content>;
	unclaimed: SidecarPoolEntry[];
}

interface ClaudeMetadata {
	sessionId: string;
	cwd?: string;
	version?: string;
	requestedModel?: string;
	actualModel?: string;
	status: number;
	timestamps: string[];
	inlineSubagentIds: Set<string>;
	toolDefinitions: ClaudeToolDefinition[];
	hasSubagents: boolean;
	subagentFiles: string[];
	sidecarToolResultsDir?: string;
	gitBranches: string[];
}

interface ContentExtraction {
	content?: Qwen35Content;
	hasOnlyToolResults: boolean;
}

interface ToolUseExtraction {
	toolCallId: string;
	functionName: string;
	arguments: Record<string, unknown>;
	rawArguments: unknown;
	resultContent?: Qwen35Content;
	resultText?: string;
	resultIsError: boolean;
	status?: string;
	summaryMessage: string;
	qwenAssistantContent: Qwen35Content;
	subagentTrajectoryRef?: string;
}

interface AssistantTrajectoryExtraction {
	qwenContent: Qwen35Content;
	text: string;
	reasoning?: string;
	toolUses: ToolUseExtraction[];
}

interface SubagentCandidate {
	agentId: string;
	trajectory: AtifTrajectory;
	firstUserText?: string;
	summaryContent?: Qwen35Content;
	parentToolUseIds: Set<string>;
	claimed: boolean;
}

interface ClaudeProjectionMetadata {
	kind: "main" | "subagent";
	endpoint: string;
	source: string;
	source_file: string;
	source_session_id: string;
	parent_session_id?: string;
	agent_id?: string;
	source_kind: "main_session" | "inline_subagent" | "sidefile_subagent";
	status: number;
	requested_model?: string;
	actual_model?: string;
	cwd?: string;
	version?: string;
	timestamps: string[];
	lossy_reasons: string[];
	tool_definitions: ClaudeToolDefinition[];
}

interface ClaudeSessionArtifacts {
	trajectories: AtifTrajectory[];
	hasMainTrajectory: boolean;
}

interface BuildTrajectoryOptions {
	envelopes: ClaudeEnvelope[];
	file: string;
	metadata: ClaudeMetadata;
	toolDefinitions: Map<string, ClaudeToolDefinition>;
	sidecarStore: SidecarStore;
	subagentCandidates: SubagentCandidate[];
	lossyReasons: Set<string>;
	kind: "main" | "subagent";
	sourceKind: "main_session" | "inline_subagent" | "sidefile_subagent";
	sourceSessionId: string;
	sessionId: string;
	parentSessionId?: string;
	agentId?: string;
}

export async function collectClaudeTrajectories(
	root: string,
): Promise<AtifTrajectory[]> {
	const files = await listClaudeMainFiles(root);
	const trajectories: AtifTrajectory[] = [];

	for (const file of files) {
		const entries = (await readJsonl(file)).map((row) =>
			ClaudeProjectEntrySchema.parse(row),
		);
		const artifacts = buildClaudeSessionArtifacts(entries, file);
		trajectories.push(
			...artifacts.trajectories.map((trajectory) =>
				AtifTrajectorySchema.parse(trajectory),
			),
		);
	}

	return trajectories;
}

export async function collectClaudePromptOnlyRecords(
	root: string,
): Promise<Qwen35Record[]> {
	const files = await listClaudeMainFiles(root);
	const records: Qwen35Record[] = [];

	for (const file of files) {
		const entries = (await readJsonl(file)).map((row) =>
			ClaudeProjectEntrySchema.parse(row),
		);
		const artifacts = buildClaudeSessionArtifacts(entries, file);
		if (artifacts.trajectories.length > 0) {
			for (const trajectory of artifacts.trajectories) {
				records.push(
					Qwen35RecordSchema.parse(
						projectClaudeTrajectoryToQwen35Record(trajectory),
					),
				);
			}
		}
		if (!artifacts.hasMainTrajectory) {
			for (const fallback of buildPromptOnlyFallbackRecords(entries, file)) {
				records.push(Qwen35RecordSchema.parse(fallback));
			}
		}
	}

	return records;
}

async function listClaudeMainFiles(root: string): Promise<string[]> {
	return (
		await fg("**/*.jsonl", { cwd: root, absolute: true, onlyFiles: true })
	)
		.filter((file) => !file.includes(`${path.sep}subagents${path.sep}`))
		.sort();
}

function buildClaudeSessionArtifacts(
	entries: ClaudeProjectEntry[],
	file: string,
): ClaudeSessionArtifacts {
	const envelopes = unwrapClaudeEntries(entries);
	const metadata = extractMetadata(envelopes, file);
	const mainLossyReasons = new Set<string>();
	const sidecarStore = buildSidecarStore(metadata.sidecarToolResultsDir);
	if (
		metadata.sidecarToolResultsDir &&
		(sidecarStore.directByPrefix.size > 0 || sidecarStore.unclaimed.length > 0)
	) {
		mainLossyReasons.add("tool_result_sidecar_partially_loaded");
	}

	const tools = new Map<string, ClaudeToolDefinition>();
	for (const definition of metadata.toolDefinitions) {
		tools.set(definition.name, definition);
	}

	const subagentCandidates = buildSubagentCandidates(
		envelopes,
		file,
		metadata,
		tools,
		mainLossyReasons,
	);
	if (metadata.hasSubagents && subagentCandidates.length === 0) {
		mainLossyReasons.add("subagents_not_exported");
	}

	const mainTrajectory = buildClaudeTrajectory({
		envelopes: envelopes.filter((envelope) => !asString(envelope.__agentId)),
		file,
		metadata,
		toolDefinitions: tools,
		sidecarStore,
		subagentCandidates,
		lossyReasons: mainLossyReasons,
		kind: "main",
		sourceKind: "main_session",
		sourceSessionId: metadata.sessionId,
		sessionId: metadata.sessionId,
	});

	const trajectories = [
		mainTrajectory,
		...subagentCandidates.map((candidate) => candidate.trajectory),
	].filter((trajectory): trajectory is AtifTrajectory => Boolean(trajectory));

	return {
		trajectories,
		hasMainTrajectory: Boolean(mainTrajectory),
	};
}

function buildSubagentCandidates(
	envelopes: ClaudeEnvelope[],
	file: string,
	metadata: ClaudeMetadata,
	sharedTools: Map<string, ClaudeToolDefinition>,
	parentLossyReasons: Set<string>,
): SubagentCandidate[] {
	const candidates = new Map<string, SubagentCandidate>();
	const inlineGroups = new Map<string, ClaudeEnvelope[]>();

	for (const envelope of envelopes) {
		const agentId = asString(envelope.__agentId);
		if (!agentId) continue;
		const group = inlineGroups.get(agentId) ?? [];
		group.push(envelope);
		inlineGroups.set(agentId, group);
	}

	for (const [agentId, group] of [...inlineGroups.entries()].sort(([a], [b]) =>
		a.localeCompare(b),
	)) {
		const childLossyReasons = new Set<string>();
		const childMetadata = buildInlineSubagentMetadata(group, metadata, agentId);
		const childTrajectory = buildClaudeTrajectory({
			envelopes: group,
			file,
			metadata: childMetadata,
			toolDefinitions: new Map(sharedTools),
			sidecarStore: { directByPrefix: new Map(), unclaimed: [] },
			subagentCandidates: [],
			lossyReasons: childLossyReasons,
			kind: "subagent",
			sourceKind: "inline_subagent",
			sourceSessionId: childMetadata.sessionId,
			sessionId: makeSubagentSessionId(metadata.sessionId, agentId),
			parentSessionId: metadata.sessionId,
			agentId,
		});
		if (!childTrajectory) continue;
		syncToolDefinitionsFromTrajectory(sharedTools, childTrajectory);
		candidates.set(agentId, {
			agentId,
			trajectory: childTrajectory,
			firstUserText: firstTrajectoryUserText(childTrajectory),
			summaryContent: extractSubagentSummaryContent(childTrajectory),
			parentToolUseIds: collectParentToolUseIds(group),
			claimed: false,
		});
	}

	for (const subagentFile of metadata.subagentFiles) {
		const agentId = path
			.basename(subagentFile, ".jsonl")
			.replace(/^agent-/, "");
		if (candidates.has(agentId)) continue;
		try {
			const rows = fs
				.readFileSync(subagentFile, "utf8")
				.split(/\r?\n/)
				.filter(Boolean)
				.map((line) => ClaudeProjectEntrySchema.parse(JSON.parse(line)));
			const subagentEnvelopes = unwrapClaudeEntries(rows);
			const subagentMetadata = extractMetadata(subagentEnvelopes, subagentFile);
			const sidecarStore = buildSidecarStore(
				subagentMetadata.sidecarToolResultsDir,
			);
			const childLossyReasons = new Set<string>();
			if (
				subagentMetadata.sidecarToolResultsDir &&
				(sidecarStore.directByPrefix.size > 0 ||
					sidecarStore.unclaimed.length > 0)
			) {
				childLossyReasons.add("tool_result_sidecar_partially_loaded");
			}
			const mergedTools = new Map(sharedTools);
			for (const definition of subagentMetadata.toolDefinitions) {
				mergedTools.set(definition.name, definition);
			}
			const childTrajectory = buildClaudeTrajectory({
				envelopes: subagentEnvelopes.filter(
					(envelope) => !asString(envelope.__agentId),
				),
				file: subagentFile,
				metadata: {
					...subagentMetadata,
					cwd: subagentMetadata.cwd ?? metadata.cwd,
					version: subagentMetadata.version ?? metadata.version,
					requestedModel:
						subagentMetadata.requestedModel ?? metadata.requestedModel,
					actualModel: subagentMetadata.actualModel ?? metadata.actualModel,
					hasSubagents: false,
					subagentFiles: [],
				},
				toolDefinitions: mergedTools,
				sidecarStore,
				subagentCandidates: [],
				lossyReasons: childLossyReasons,
				kind: "subagent",
				sourceKind: "sidefile_subagent",
				sourceSessionId: subagentMetadata.sessionId,
				sessionId: makeSubagentSessionId(metadata.sessionId, agentId),
				parentSessionId: metadata.sessionId,
				agentId,
			});
			if (!childTrajectory) continue;
			syncToolDefinitionsFromTrajectory(sharedTools, childTrajectory);
			candidates.set(agentId, {
				agentId,
				trajectory: childTrajectory,
				firstUserText: firstTrajectoryUserText(childTrajectory),
				summaryContent: extractSubagentSummaryContent(childTrajectory),
				parentToolUseIds: collectParentToolUseIds(
					inlineGroups.get(agentId) ?? [],
				),
				claimed: false,
			});
		} catch {
			parentLossyReasons.add("subagent_parse_failed");
		}
	}

	return [...candidates.values()];
}

function buildClaudeTrajectory(
	options: BuildTrajectoryOptions,
): AtifTrajectory | null {
	const {
		envelopes,
		file,
		metadata,
		toolDefinitions,
		sidecarStore,
		subagentCandidates,
		lossyReasons,
		kind,
		sourceKind,
		sourceSessionId,
		sessionId,
		parentSessionId,
		agentId,
	} = options;

	const toolResultMap = buildToolResultMap(envelopes, sidecarStore);
	const lastUsageByMessageId = buildLastUsageByMessageId(envelopes);
	const consumedUsageIds = new Set<string>();
	const steps: AtifTrajectory["steps"] = [];
	let assistantCount = 0;
	let userCount = 0;
	let assistantGroupCounter = 0;

	for (const envelope of envelopes) {
		if (envelope.isMeta === true) continue;
		const message = isRecord(envelope.message) ? envelope.message : undefined;
		if (!message) continue;
		const role = asString(message.role);
		if (!role) continue;

		if (role === "system") {
			const extracted = extractMessageContent(
				message.content,
				lossyReasons,
				"system",
			);
			if (!extracted.content || extracted.hasOnlyToolResults) continue;
			steps.push({
				step_id: steps.length + 1,
				timestamp: asString(envelope.timestamp),
				source: "system",
				message: renderQwenContentAsText(extracted.content),
				extra: buildClaudeExtra({
					qwen_content: extracted.content,
					step_kind: "system_message",
				}),
			});
			continue;
		}

		if (role === "user") {
			const extracted = extractMessageContent(
				message.content,
				lossyReasons,
				"user",
			);
			if (!extracted.content || extracted.hasOnlyToolResults) continue;
			userCount += 1;
			steps.push({
				step_id: steps.length + 1,
				timestamp: asString(envelope.timestamp),
				source: "user",
				message: renderQwenContentAsText(extracted.content),
				extra: buildClaudeExtra({
					qwen_content: extracted.content,
					step_kind: "user_message",
				}),
			});
			continue;
		}

		if (role !== "assistant") continue;

		assistantCount += 1;
		assistantGroupCounter += 1;
		const groupId = buildAssistantGroupId(message, assistantGroupCounter);
		const extraction = extractAssistantForTrajectory(
			message.content,
			toolResultMap,
			toolDefinitions,
			lossyReasons,
			subagentCandidates,
			sidecarStore,
			groupId,
		);
		const metrics = buildClaudeMetrics(
			message,
			lastUsageByMessageId,
			consumedUsageIds,
		);
		const modelName =
			asString(message.model) ??
			metadata.actualModel ??
			metadata.requestedModel ??
			undefined;

		let messageStepMetrics = metrics;
		const shouldEmitMessageStep =
			extraction.text.length > 0 ||
			Boolean(extraction.reasoning) ||
			extraction.toolUses.length === 0;
		if (shouldEmitMessageStep) {
			steps.push({
				step_id: steps.length + 1,
				timestamp: asString(envelope.timestamp),
				source: "agent",
				message: extraction.text,
				reasoning_content: extraction.reasoning,
				model_name: modelName,
				metrics: messageStepMetrics,
				extra: buildClaudeExtra({
					group_id: groupId,
					qwen_content: extraction.qwenContent,
					step_kind: "assistant_message",
				}),
			});
			messageStepMetrics = undefined;
		}

		extraction.toolUses.forEach((toolUse, index) => {
			const observationResults = [];
			if (
				toolUse.resultContent !== undefined ||
				toolUse.subagentTrajectoryRef
			) {
				const extra: Record<string, unknown> = {
					claude_export: {
						qwen_content: toolUse.resultContent,
					},
				};
				if (toolUse.resultIsError) {
					extra.tool_result_is_error = true;
				}
				observationResults.push({
					source_call_id: toolUse.toolCallId,
					content:
						toolUse.resultContent !== undefined
							? (toolUse.resultText ?? "")
							: null,
					subagent_trajectory_ref: toolUse.subagentTrajectoryRef ?? undefined,
					extra: compactJsonObject(extra),
				});
			} else if (!toolUse.subagentTrajectoryRef) {
				lossyReasons.add("missing_tool_results");
			}

			const stepExtra: Record<string, unknown> = {
				claude_export: {
					group_id: groupId,
					qwen_content: toolUse.qwenAssistantContent,
					step_kind: "assistant_tool_call",
				},
			};
			if (toolUse.status) {
				stepExtra.status = toolUse.status;
			}
			if (toolUse.rawArguments !== undefined) {
				stepExtra.raw_arguments = toolUse.rawArguments;
			}

			steps.push({
				step_id: steps.length + 1,
				timestamp: asString(envelope.timestamp),
				source: "agent",
				message: toolUse.summaryMessage,
				reasoning_content:
					!shouldEmitMessageStep && index === 0
						? extraction.reasoning
						: undefined,
				model_name: modelName,
				tool_calls: [
					{
						tool_call_id: toolUse.toolCallId,
						function_name: toolUse.functionName,
						arguments: compactJsonObject(toolUse.arguments) ?? {},
					},
				],
				observation:
					observationResults.length > 0
						? { results: observationResults }
						: undefined,
				metrics:
					!shouldEmitMessageStep && index === 0
						? messageStepMetrics
						: undefined,
				extra: compactJsonObject(stepExtra),
			});
			messageStepMetrics = undefined;
		});
	}

	if (
		kind === "main" &&
		subagentCandidates.some((candidate) => !candidate.claimed)
	) {
		lossyReasons.add("unmatched_subagent_trajectories");
	}

	if (assistantCount === 0 || userCount === 0 || steps.length === 0) {
		return null;
	}

	const projectionMetadata: ClaudeProjectionMetadata = {
		kind,
		endpoint:
			kind === "main" ? "claude/session_trace" : "claude/subagent_trace",
		source: buildClaudeSource(
			sourceSessionId,
			file,
			metadata.cwd,
			parentSessionId,
			agentId,
		),
		source_file: file,
		source_session_id: sourceSessionId,
		parent_session_id: parentSessionId,
		agent_id: agentId,
		source_kind: sourceKind,
		status: metadata.status,
		requested_model: metadata.requestedModel,
		actual_model: metadata.actualModel,
		cwd: metadata.cwd,
		version: metadata.version,
		timestamps: metadata.timestamps,
		lossy_reasons: [...lossyReasons],
		tool_definitions: [...toolDefinitions.values()],
	};

	return AtifTrajectorySchema.parse({
		schema_version: "ATIF-v1.4",
		session_id: sessionId,
		agent: {
			name: "claude-code",
			version: metadata.version,
			model_name: metadata.actualModel ?? metadata.requestedModel ?? undefined,
			extra: buildAgentExtra(
				metadata,
				file,
				sourceKind,
				parentSessionId,
				agentId,
			),
		},
		steps,
		final_metrics: buildFinalMetrics(steps),
		extra: buildClaudeExtra(projectionMetadata),
	});
}

function projectClaudeTrajectoryToQwen35Record(
	trajectory: AtifTrajectory,
): Qwen35Record {
	const baseRecord = atifTrajectoryToQwen35Record(trajectory);
	const projection = readClaudeProjectionMetadata(trajectory.extra);
	if (!projection) {
		return Qwen35RecordSchema.parse(baseRecord);
	}

	const messages = buildProjectedQwenMessages(trajectory);
	const tools = normalizeToolDefinitions(
		projection.tool_definitions,
		trajectory,
	);
	const counts = summarizeProjectedMessages(messages);
	const requestedModel =
		projection.requested_model ?? trajectory.agent.model_name ?? undefined;
	const actualModel =
		projection.actual_model ?? trajectory.agent.model_name ?? undefined;

	return Qwen35RecordSchema.parse({
		...baseRecord,
		id: trajectory.session_id,
		request_id: trajectory.session_id,
		messages,
		tools,
		meta: {
			...baseRecord.meta,
			endpoint: projection.endpoint,
			status: projection.status,
			ts:
				projection.timestamps.at(-1) ??
				trajectory.steps.at(-1)?.timestamp ??
				trajectory.steps[0]?.timestamp ??
				"",
			key: trajectory.session_id,
			source: projection.source,
			requested_model: requestedModel,
			actual_model: actualModel,
			stream: false,
			thinking_level: undefined,
			reasoning_summary_mode:
				projection.kind === "main"
					? "claude_session_trace"
					: "claude_subagent_trace",
			thinking_type:
				projection.kind === "main"
					? "claude_session_trace"
					: "claude_subagent_trace",
			thinking_budget_tokens: undefined,
			max_output_tokens: undefined,
			tool_spec_count: tools.length,
			tool_choice: { mode: "trajectory_projection" },
			request_contains_non_text_content: counts.requestContainsNonTextContent,
			request_image_block_count: counts.requestImageBlockCount,
			request_video_block_count: counts.requestVideoBlockCount,
			request_tool_call_block_count: 0,
			request_tool_result_block_count: 0,
			request_thinking_block_count: 0,
			response_contains_non_text_content: counts.responseContainsNonTextContent,
			response_image_block_count: counts.responseImageBlockCount,
			response_video_block_count: counts.responseVideoBlockCount,
			response_tool_call_block_count: counts.responseToolCallBlockCount,
			response_tool_result_block_count: counts.responseToolResultBlockCount,
			response_thinking_block_count: counts.responseThinkingBlockCount,
			request_truncated: false,
			response_truncated: false,
			lossy_source: projection.lossy_reasons.length > 0,
			lossy_reasons: projection.lossy_reasons,
		},
	});
}

function buildProjectedQwenMessages(
	trajectory: AtifTrajectory,
): Qwen35Record["messages"] {
	const messages: Qwen35Record["messages"] = [];

	for (let index = 0; index < trajectory.steps.length; index += 1) {
		const step = trajectory.steps[index];
		if (step.source === "system") {
			messages.push({
				role: "system",
				content: readStepQwenContent(step),
			});
			continue;
		}

		if (step.source === "user") {
			messages.push({
				role: "user",
				content: readStepQwenContent(step),
			});
			continue;
		}

		const groupId = readClaudeGroupId(step);
		if (!groupId) {
			messages.push(...projectAssistantGroup([step]));
			continue;
		}

		const groupSteps = [step];
		let cursor = index + 1;
		while (cursor < trajectory.steps.length) {
			const next = trajectory.steps[cursor];
			if (next?.source !== "agent" || readClaudeGroupId(next) !== groupId)
				break;
			groupSteps.push(next);
			cursor += 1;
		}
		messages.push(...projectAssistantGroup(groupSteps));
		index = cursor - 1;
	}

	return messages;
}

function projectAssistantGroup(
	steps: AtifTrajectory["steps"],
): Qwen35Record["messages"] {
	const messageStep =
		steps.find((step) => readClaudeStepKind(step) === "assistant_message") ??
		steps[0];
	const assistant: AssistantMessage = {
		role: "assistant",
		content: readStepQwenContent(messageStep),
	};
	const reasoning =
		messageStep?.reasoning_content ??
		steps.find((step) => typeof step.reasoning_content === "string")
			?.reasoning_content;
	if (reasoning) {
		assistant.reasoning_content = reasoning;
	}

	const toolCalls = steps.flatMap((step) =>
		(step.tool_calls ?? []).map((toolCall) => ({
			type: "function" as const,
			id: toolCall.tool_call_id,
			function: {
				name: toolCall.function_name,
				arguments: toolCall.arguments,
			},
		})),
	);
	if (toolCalls.length > 0) {
		assistant.tool_calls = toolCalls;
	}

	const messages: Qwen35Record["messages"] = [assistant];
	for (const step of steps) {
		const toolName = step.tool_calls?.[0]?.function_name;
		for (const result of step.observation?.results ?? []) {
			messages.push({
				role: "tool",
				tool_call_id: result.source_call_id,
				name: toolName,
				content: readObservationQwenContent(result),
			});
		}
	}

	return messages;
}

function buildPromptOnlyFallbackRecords(
	entries: ClaudeProjectEntry[],
	file: string,
): Qwen35Record[] {
	const records: Qwen35Record[] = [];
	for (const entry of entries) {
		if (entry.type !== "user") continue;
		const message = isRecord(entry.message) ? entry.message : {};
		const content = asString(message.content);
		if (!content) continue;
		records.push({
			id: `${asString(entry.sessionId) ?? file}:${asString(entry.promptId) ?? asString(entry.uuid) ?? "prompt"}`,
			request_id: asString(entry.promptId) ?? asString(entry.uuid) ?? undefined,
			messages: [{ role: "user", content }],
			tools: [],
			meta: {
				endpoint: "claude/prompt_history",
				status: 200,
				ts: asString(entry.timestamp) ?? "",
				key: asString(entry.sessionId) ?? undefined,
				source: `claude:session=${asString(entry.sessionId) ?? ""}:cwd=${asString(entry.cwd) ?? ""}:entrypoint=${asString(entry.entrypoint) ?? ""}`,
				requested_model: undefined,
				actual_model: undefined,
				stream: false,
				thinking_level: undefined,
				reasoning_summary_mode: "claude_prompt_only",
				thinking_type: "prompt_history_only",
				tool_spec_count: 0,
				tool_choice: { mode: "prompt_only" },
				request_contains_non_text_content: false,
				request_image_block_count: 0,
				request_video_block_count: 0,
				request_tool_call_block_count: 0,
				request_tool_result_block_count: 0,
				request_thinking_block_count: 0,
				response_contains_non_text_content: false,
				response_image_block_count: 0,
				response_video_block_count: 0,
				response_tool_call_block_count: 0,
				response_tool_result_block_count: 0,
				response_thinking_block_count: 0,
				request_truncated: false,
				response_truncated: false,
				lossy_source: true,
				lossy_reasons: ["prompt_history_only", "assistant_trace_unavailable"],
			},
		});
	}
	return records;
}

function unwrapClaudeEntries(entries: ClaudeProjectEntry[]): ClaudeEnvelope[] {
	const envelopes: ClaudeEnvelope[] = [];
	for (const entry of entries) {
		if (isTranscriptEnvelope(entry)) {
			envelopes.push(entry);
		}
		const nested = extractProgressEnvelope(entry);
		if (nested) envelopes.push(nested);
	}
	return envelopes;
}

function buildToolResultMap(
	envelopes: ClaudeEnvelope[],
	sidecarStore: SidecarStore,
): Map<string, ToolResultEntry> {
	const map = new Map<string, ToolResultEntry>();
	for (const envelope of envelopes) {
		const message = isRecord(envelope.message) ? envelope.message : undefined;
		if (!message || asString(message.role) !== "user") continue;
		const content = message.content;
		if (!Array.isArray(content)) continue;
		for (const rawBlock of content) {
			if (!isRecord(rawBlock) || asString(rawBlock.type) !== "tool_result")
				continue;
			const toolUseId = asString(rawBlock.tool_use_id);
			if (!toolUseId || map.has(toolUseId)) continue;
			map.set(toolUseId, {
				content: rawBlock.content,
				isError: Boolean(rawBlock.is_error),
			});
		}
	}
	for (const [toolUseId, entry] of map) {
		if (
			entry.content !== undefined &&
			entry.content !== null &&
			entry.content !== ""
		)
			continue;
		const sidecarContent = claimSidecarByToolUseId(sidecarStore, toolUseId);
		if (sidecarContent !== undefined) {
			map.set(toolUseId, { content: sidecarContent, isError: entry.isError });
		}
	}
	return map;
}

function buildLastUsageByMessageId(
	envelopes: ClaudeEnvelope[],
): Map<string, unknown> {
	const map = new Map<string, unknown>();
	for (const envelope of envelopes) {
		const message = isRecord(envelope.message) ? envelope.message : undefined;
		if (!message || asString(message.role) !== "assistant") continue;
		const id = asString(message.id);
		if (!id || message.usage === undefined) continue;
		map.set(id, message.usage);
	}
	return map;
}

function extractMetadata(
	envelopes: ClaudeEnvelope[],
	file: string,
): ClaudeMetadata {
	const sessionId =
		envelopes.map((envelope) => asString(envelope.sessionId)).find(Boolean) ??
		path.basename(file, ".jsonl");
	const timestamps = envelopes
		.map((envelope) => asString(envelope.timestamp))
		.filter((value): value is string => Boolean(value));
	const toolDefinitions = new Map<string, ClaudeToolDefinition>();
	const gitBranches = new Set<string>();
	let cwd: string | undefined;
	let version: string | undefined;
	let requestedModel: string | undefined;
	let actualModel: string | undefined;
	let status = 200;
	const inlineSubagentIds = new Set<string>();

	for (const envelope of envelopes) {
		cwd ??= asString(envelope.cwd);
		version ??=
			asString(envelope.version) ?? asString(envelope.claude_code_version);
		const inlineSubagentId = asString(envelope.__agentId);
		if (inlineSubagentId) inlineSubagentIds.add(inlineSubagentId);
		const gitBranch = asString(envelope.gitBranch);
		if (gitBranch) gitBranches.add(gitBranch);

		if (
			asString(envelope.type) === "system" &&
			asString(envelope.subtype) === "init"
		) {
			requestedModel ??= asString(envelope.model);
			actualModel ??= asString(envelope.model);
			const tools = Array.isArray(envelope.tools) ? envelope.tools : [];
			for (const rawTool of tools) {
				if (!isRecord(rawTool)) continue;
				const name = asString(rawTool.name);
				if (!name) continue;
				toolDefinitions.set(name, {
					name,
					description: asString(rawTool.description),
					parameters: isRecord(rawTool.parameters)
						? rawTool.parameters
						: undefined,
				});
			}
		}

		if (asString(envelope.type) === "result") {
			const subtype = asString(envelope.subtype) ?? "";
			if (subtype.startsWith("error")) status = 500;
		}

		const message = isRecord(envelope.message) ? envelope.message : undefined;
		if (message) {
			actualModel ??= asString(message.model);
			requestedModel ??= asString(message.model);
		}
	}

	const sessionDir = path.join(
		path.dirname(file),
		path.basename(file, ".jsonl"),
	);
	const subagentsDir = path.join(sessionDir, "subagents");
	const toolResultsDir = path.join(sessionDir, "tool-results");
	const subagentFiles = fs.existsSync(subagentsDir)
		? fs
				.readdirSync(subagentsDir)
				.filter((name) => name.endsWith(".jsonl"))
				.sort()
				.map((name) => path.join(subagentsDir, name))
		: [];

	return {
		sessionId,
		cwd,
		version,
		requestedModel,
		actualModel,
		status,
		timestamps,
		inlineSubagentIds,
		toolDefinitions: [...toolDefinitions.values()],
		hasSubagents: inlineSubagentIds.size > 0 || subagentFiles.length > 0,
		subagentFiles,
		sidecarToolResultsDir: fs.existsSync(toolResultsDir)
			? toolResultsDir
			: undefined,
		gitBranches: [...gitBranches].sort(),
	};
}

function buildInlineSubagentMetadata(
	envelopes: ClaudeEnvelope[],
	parentMetadata: ClaudeMetadata,
	agentId: string,
): ClaudeMetadata {
	const timestamps = envelopes
		.map((envelope) => asString(envelope.timestamp))
		.filter((value): value is string => Boolean(value));
	let cwd = parentMetadata.cwd;
	let requestedModel = parentMetadata.requestedModel;
	let actualModel = parentMetadata.actualModel;
	for (const envelope of envelopes) {
		cwd ??= asString(envelope.cwd);
		const message = isRecord(envelope.message) ? envelope.message : undefined;
		if (message) {
			actualModel ??= asString(message.model);
			requestedModel ??= asString(message.model);
		}
	}
	return {
		sessionId: makeSubagentSessionId(parentMetadata.sessionId, agentId),
		cwd,
		version: parentMetadata.version,
		requestedModel,
		actualModel,
		status: parentMetadata.status,
		timestamps,
		inlineSubagentIds: new Set(),
		toolDefinitions: parentMetadata.toolDefinitions,
		hasSubagents: false,
		subagentFiles: [],
		sidecarToolResultsDir: undefined,
		gitBranches: parentMetadata.gitBranches,
	};
}

function extractMessageContent(
	content: unknown,
	lossyReasons: Set<string>,
	prefix: string,
): ContentExtraction {
	if (typeof content === "string") {
		const trimmed = content.trim();
		return {
			content: trimmed || undefined,
			hasOnlyToolResults: false,
		};
	}

	if (!Array.isArray(content)) {
		if (content !== undefined && content !== null) {
			lossyReasons.add(`${prefix}_nonstandard_content`);
			return {
				content: JSON.stringify(content),
				hasOnlyToolResults: false,
			};
		}
		return { hasOnlyToolResults: false };
	}

	const blocks: Array<Record<string, unknown>> = [];
	let hasToolResults = false;
	let hasVisibleContent = false;

	for (const rawBlock of content) {
		if (!isRecord(rawBlock)) continue;
		const type = asString(rawBlock.type);
		if (type === "text") {
			const text = asString(rawBlock.text)?.trim();
			if (!text) continue;
			blocks.push({ type: "text", text });
			hasVisibleContent = true;
			continue;
		}
		if (type === "tool_result") {
			hasToolResults = true;
			continue;
		}
		if (type === "image") {
			blocks.push({
				type: "image",
				placeholder: true,
				source_kind: "claude_image",
				metadata: { source_type: type },
			});
			hasVisibleContent = true;
			continue;
		}
		if (type === "video") {
			blocks.push({
				type: "video",
				placeholder: true,
				source_kind: "claude_video",
				metadata: { source_type: type },
			});
			hasVisibleContent = true;
			continue;
		}
		if (type)
			lossyReasons.add(
				`${prefix}_unsupported_block_${sanitizeLossyReason(type)}`,
			);
		else lossyReasons.add(`${prefix}_unsupported_block_unknown`);
	}

	return {
		content: collapseBlocks(blocks),
		hasOnlyToolResults: hasToolResults && !hasVisibleContent,
	};
}

function extractAssistantForTrajectory(
	content: unknown,
	toolResultMap: Map<string, ToolResultEntry>,
	tools: Map<string, ClaudeToolDefinition>,
	lossyReasons: Set<string>,
	subagentCandidates: SubagentCandidate[],
	sidecarStore: SidecarStore,
	groupId: string,
): AssistantTrajectoryExtraction {
	const textBlocks: Array<Record<string, unknown>> = [];
	const reasoning: string[] = [];
	const toolUses: ToolUseExtraction[] = [];

	if (typeof content === "string") {
		const trimmed = content.trim();
		if (trimmed) textBlocks.push({ type: "text", text: trimmed });
	} else if (Array.isArray(content)) {
		for (let index = 0; index < content.length; index += 1) {
			const rawBlock = content[index];
			if (!isRecord(rawBlock)) continue;
			const type = asString(rawBlock.type);
			if (type === "text") {
				const text = asString(rawBlock.text)?.trim();
				if (text) textBlocks.push({ type: "text", text });
				continue;
			}
			if (type === "thinking") {
				const text = sanitizeThinking(asString(rawBlock.thinking));
				if (text) reasoning.push(text);
				else if (asString(rawBlock.signature))
					lossyReasons.add("encrypted_reasoning_without_visible_text");
				continue;
			}
			if (type === "tool_use") {
				const explicitId =
					asString(rawBlock.id) ?? asString(rawBlock.tool_use_id);
				const toolCallId = explicitId ?? `${groupId}:tool:${index + 1}`;
				if (!explicitId) lossyReasons.add("tool_use_missing_id");
				const functionName = asString(rawBlock.name) ?? "tool";
				const rawArguments = rawBlock.input;
				const argumentsObject = isRecord(rawArguments)
					? rawArguments
					: rawArguments === undefined
						? {}
						: { input: rawArguments };
				if (!tools.has(functionName))
					tools.set(functionName, { name: functionName });

				const sidecarContent = claimSidecarByToolUseId(
					sidecarStore,
					toolCallId,
				);
				const resultEntry =
					toolResultMap.get(toolCallId) ??
					(sidecarContent !== undefined
						? { content: sidecarContent, isError: false }
						: undefined);
				const matchedSubagentCandidate =
					functionName === "Task" || functionName === "Agent"
						? claimMatchingSubagentCandidate(
								toolCallId,
								argumentsObject,
								subagentCandidates,
							)
						: undefined;
				let resultContent = resultEntry
					? formatToolResultContent(
							resultEntry.content,
							resultEntry.isError,
							lossyReasons,
						)
					: undefined;
				if (
					resultContent === undefined &&
					matchedSubagentCandidate?.summaryContent !== undefined
				) {
					resultContent = matchedSubagentCandidate.summaryContent;
					lossyReasons.add("subagent_summary_synthesized");
				}
				const subagentTrajectoryRef =
					matchedSubagentCandidate?.trajectory.session_id;

				toolUses.push({
					toolCallId,
					functionName,
					arguments: argumentsObject,
					rawArguments,
					resultContent,
					resultText:
						resultContent !== undefined
							? renderQwenContentAsText(resultContent)
							: undefined,
					resultIsError: resultEntry?.isError ?? false,
					status: asString(rawBlock.status),
					summaryMessage: buildToolSummary(functionName, toolCallId),
					qwenAssistantContent: "",
					subagentTrajectoryRef,
				});
				continue;
			}
			if (type === "image") {
				textBlocks.push({
					type: "image",
					placeholder: true,
					source_kind: "claude_image",
					metadata: { source_type: type },
				});
				continue;
			}
			if (type === "video") {
				textBlocks.push({
					type: "video",
					placeholder: true,
					source_kind: "claude_video",
					metadata: { source_type: type },
				});
				continue;
			}
			if (type)
				lossyReasons.add(
					`assistant_unsupported_block_${sanitizeLossyReason(type)}`,
				);
			else lossyReasons.add("assistant_unsupported_block_unknown");
		}
	} else if (content !== undefined && content !== null) {
		lossyReasons.add("assistant_nonstandard_content");
		textBlocks.push({ type: "text", text: JSON.stringify(content) });
	}

	const qwenContent = collapseBlocks(textBlocks) ?? "";
	return {
		qwenContent,
		text: renderQwenContentAsText(qwenContent),
		reasoning: reasoning.length > 0 ? reasoning.join("\n\n") : undefined,
		toolUses,
	};
}

function buildClaudeMetrics(
	message: Record<string, unknown>,
	lastUsageByMessageId: Map<string, unknown>,
	seenMessageIds: Set<string>,
): AtifMetrics | undefined {
	const messageId = asString(message.id);
	if (messageId) {
		if (seenMessageIds.has(messageId)) return undefined;
		seenMessageIds.add(messageId);
	}
	return buildMetricsFromUsage(
		messageId
			? (lastUsageByMessageId.get(messageId) ?? message.usage)
			: message.usage,
	);
}

function buildMetricsFromUsage(usage: unknown): AtifMetrics | undefined {
	if (!isRecord(usage)) return undefined;

	const inputTokens = asNumber(usage.input_tokens) ?? 0;
	const cachedTokens = asNumber(usage.cache_read_input_tokens) ?? 0;
	const cacheCreationTokens = asNumber(usage.cache_creation_input_tokens) ?? 0;
	const completionTokens = asNumber(usage.output_tokens) ?? 0;

	const extra: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(usage)) {
		if (key === "input_tokens" || key === "output_tokens") continue;
		extra[key] = value;
	}

	const promptTokens = inputTokens + cachedTokens + cacheCreationTokens;
	if (
		promptTokens === 0 &&
		completionTokens === 0 &&
		Object.keys(extra).length === 0
	) {
		return undefined;
	}

	return {
		prompt_tokens: promptTokens,
		completion_tokens: completionTokens,
		cached_tokens: cachedTokens,
		extra: compactJsonObject(extra),
	};
}

function buildFinalMetrics(
	steps: AtifTrajectory["steps"],
): AtifTrajectory["final_metrics"] {
	const totalPromptTokens = sumOptionalNumbers(
		steps.map((step) => step.metrics?.prompt_tokens),
	);
	const totalCompletionTokens = sumOptionalNumbers(
		steps.map((step) => step.metrics?.completion_tokens),
	);
	const totalCachedTokens = sumOptionalNumbers(
		steps.map((step) => step.metrics?.cached_tokens),
	);

	const serviceTiers = new Set<string>();
	let totalCacheCreationInputTokens = 0;
	let sawCacheCreationInputTokens = false;
	let totalCacheReadInputTokens = 0;
	let sawCacheReadInputTokens = false;

	for (const step of steps) {
		const extra = isRecord(step.metrics?.extra)
			? step.metrics?.extra
			: undefined;
		if (!extra) continue;
		const serviceTier = asString(extra.service_tier);
		if (serviceTier) serviceTiers.add(serviceTier);
		const cacheCreation = asNumber(extra.cache_creation_input_tokens);
		if (cacheCreation !== undefined) {
			totalCacheCreationInputTokens += cacheCreation;
			sawCacheCreationInputTokens = true;
		}
		const cacheRead = asNumber(extra.cache_read_input_tokens);
		if (cacheRead !== undefined) {
			totalCacheReadInputTokens += cacheRead;
			sawCacheReadInputTokens = true;
		}
	}

	const extra: Record<string, unknown> = {};
	if (serviceTiers.size > 0) extra.service_tiers = [...serviceTiers].sort();
	if (sawCacheCreationInputTokens)
		extra.total_cache_creation_input_tokens = totalCacheCreationInputTokens;
	if (sawCacheReadInputTokens)
		extra.total_cache_read_input_tokens = totalCacheReadInputTokens;

	return {
		total_prompt_tokens: totalPromptTokens,
		total_completion_tokens: totalCompletionTokens,
		total_cached_tokens: totalCachedTokens,
		total_steps: steps.length,
		extra: compactJsonObject(extra),
	};
}

function buildAgentExtra(
	metadata: ClaudeMetadata,
	file: string,
	sourceKind: BuildTrajectoryOptions["sourceKind"],
	parentSessionId?: string,
	agentId?: string,
): Record<string, unknown> | undefined {
	const extra: Record<string, unknown> = {
		source_kind: sourceKind,
		source_file: file,
	};
	if (metadata.cwd) extra.cwd = metadata.cwd;
	if (metadata.gitBranches.length > 0)
		extra.git_branches = metadata.gitBranches;
	if (metadata.inlineSubagentIds.size > 0)
		extra.inline_subagent_ids = [...metadata.inlineSubagentIds].sort();
	if (parentSessionId) extra.parent_session_id = parentSessionId;
	if (agentId) extra.agent_id = agentId;
	return compactJsonObject(extra);
}

function readClaudeProjectionMetadata(
	value: unknown,
): ClaudeProjectionMetadata | undefined {
	if (!isRecord(value)) return undefined;
	const raw = value.claude_export;
	if (!isRecord(raw)) return undefined;
	const toolDefinitions = Array.isArray(raw.tool_definitions)
		? raw.tool_definitions.filter(isRecord).map((tool) => ({
				name: asString(tool.name) ?? "tool",
				description: asString(tool.description),
				parameters: isRecord(tool.parameters) ? tool.parameters : undefined,
			}))
		: [];

	const kind = asString(raw.kind);
	const sourceKind = asString(raw.source_kind);
	const endpoint = asString(raw.endpoint);
	const source = asString(raw.source);
	const sourceFile = asString(raw.source_file);
	const sourceSessionId = asString(raw.source_session_id);
	if (
		!kind ||
		!sourceKind ||
		!endpoint ||
		!source ||
		!sourceFile ||
		!sourceSessionId
	) {
		return undefined;
	}

	return {
		kind: kind === "subagent" ? "subagent" : "main",
		endpoint,
		source,
		source_file: sourceFile,
		source_session_id: sourceSessionId,
		parent_session_id: asString(raw.parent_session_id),
		agent_id: asString(raw.agent_id),
		source_kind:
			sourceKind === "inline_subagent" || sourceKind === "sidefile_subagent"
				? sourceKind
				: "main_session",
		status: asNumber(raw.status) ?? 200,
		requested_model: asString(raw.requested_model),
		actual_model: asString(raw.actual_model),
		cwd: asString(raw.cwd),
		version: asString(raw.version),
		timestamps: Array.isArray(raw.timestamps)
			? raw.timestamps
					.map(asString)
					.filter((item): item is string => Boolean(item))
			: [],
		lossy_reasons: Array.isArray(raw.lossy_reasons)
			? raw.lossy_reasons
					.map(asString)
					.filter((item): item is string => Boolean(item))
			: [],
		tool_definitions: toolDefinitions,
	};
}

function readStepQwenContent(
	step: AtifTrajectory["steps"][number],
): Qwen35Content {
	const extra = isRecord(step.extra) ? step.extra : undefined;
	const projection =
		extra && isRecord(extra.claude_export) ? extra.claude_export : undefined;
	const content = projection?.qwen_content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content as Qwen35Content;
	return step.message ?? "";
}

function readObservationQwenContent(
	result: NonNullable<
		NonNullable<AtifTrajectory["steps"][number]["observation"]>["results"]
	>[number],
): Qwen35Content {
	const extra = isRecord(result.extra) ? result.extra : undefined;
	const projection =
		extra && isRecord(extra.claude_export) ? extra.claude_export : undefined;
	const content = projection?.qwen_content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content as Qwen35Content;
	if (result.content !== undefined && result.content !== null)
		return result.content;
	if (result.subagent_trajectory_ref)
		return `[subagent_trajectory_ref]\n${result.subagent_trajectory_ref}`;
	return "";
}

function readClaudeGroupId(
	step: AtifTrajectory["steps"][number],
): string | undefined {
	const extra = isRecord(step.extra) ? step.extra : undefined;
	const projection =
		extra && isRecord(extra.claude_export) ? extra.claude_export : undefined;
	return asString(projection?.group_id);
}

function readClaudeStepKind(
	step: AtifTrajectory["steps"][number],
): string | undefined {
	const extra = isRecord(step.extra) ? step.extra : undefined;
	const projection =
		extra && isRecord(extra.claude_export) ? extra.claude_export : undefined;
	return asString(projection?.step_kind);
}

function normalizeToolDefinitions(
	rawDefinitions: ClaudeToolDefinition[],
	trajectory: AtifTrajectory,
): ClaudeToolDefinition[] {
	const definitions = new Map<string, ClaudeToolDefinition>();
	for (const definition of rawDefinitions) {
		definitions.set(definition.name, definition);
	}
	for (const step of trajectory.steps) {
		for (const toolCall of step.tool_calls ?? []) {
			if (!definitions.has(toolCall.function_name)) {
				definitions.set(toolCall.function_name, {
					name: toolCall.function_name,
					parameters: toolCall.arguments,
				});
			}
		}
	}
	return [...definitions.values()];
}

function summarizeProjectedMessages(messages: Qwen35Record["messages"]) {
	let requestImageBlockCount = 0;
	let requestVideoBlockCount = 0;
	let responseImageBlockCount = 0;
	let responseVideoBlockCount = 0;
	let requestContainsNonTextContent = false;
	let responseContainsNonTextContent = false;
	let responseToolCallBlockCount = 0;
	let responseThinkingBlockCount = 0;

	for (const message of messages) {
		const stats = inspectQwenContent(message.content);
		if (message.role === "user") {
			requestImageBlockCount += stats.imageCount;
			requestVideoBlockCount += stats.videoCount;
			requestContainsNonTextContent ||= stats.hasNonTextContent;
			continue;
		}
		if (message.role === "assistant") {
			responseImageBlockCount += stats.imageCount;
			responseVideoBlockCount += stats.videoCount;
			responseContainsNonTextContent ||= stats.hasNonTextContent;
			responseToolCallBlockCount += message.tool_calls?.length ?? 0;
			if (
				typeof message.reasoning_content === "string" &&
				message.reasoning_content.length > 0
			) {
				responseThinkingBlockCount += 1;
			}
			continue;
		}
		if (message.role === "tool") {
			responseImageBlockCount += stats.imageCount;
			responseVideoBlockCount += stats.videoCount;
			responseContainsNonTextContent ||= stats.hasNonTextContent;
		}
	}

	return {
		requestContainsNonTextContent,
		requestImageBlockCount,
		requestVideoBlockCount,
		responseContainsNonTextContent,
		responseImageBlockCount,
		responseVideoBlockCount,
		responseToolCallBlockCount,
		responseToolResultBlockCount: messages.filter(
			(message) => message.role === "tool",
		).length,
		responseThinkingBlockCount,
	};
}

function inspectQwenContent(content: Qwen35Content): {
	hasNonTextContent: boolean;
	imageCount: number;
	videoCount: number;
} {
	if (typeof content === "string") {
		return { hasNonTextContent: false, imageCount: 0, videoCount: 0 };
	}
	let imageCount = 0;
	let videoCount = 0;
	for (const block of content) {
		if (block.type === "image") imageCount += 1;
		if (block.type === "video") videoCount += 1;
	}
	return {
		hasNonTextContent: imageCount > 0 || videoCount > 0,
		imageCount,
		videoCount,
	};
}

function buildAssistantGroupId(
	message: Record<string, unknown>,
	ordinal: number,
): string {
	return asString(message.id) ?? `assistant_group_${ordinal}`;
}

function buildToolSummary(functionName: string, toolCallId: string): string {
	return `Executed ${functionName} ${toolCallId}`;
}

function firstTrajectoryUserText(
	trajectory: AtifTrajectory,
): string | undefined {
	return (
		trajectory.steps.find((step) => step.source === "user")?.message?.trim() ||
		undefined
	);
}

function extractSubagentSummaryContent(
	trajectory: AtifTrajectory,
): Qwen35Content | undefined {
	for (let index = trajectory.steps.length - 1; index >= 0; index -= 1) {
		const step = trajectory.steps[index];
		if (step?.source !== "agent") continue;
		const content = readStepQwenContent(step);
		if (renderQwenContentAsText(content).trim().length > 0) {
			return content;
		}
	}
	return undefined;
}

function syncToolDefinitionsFromTrajectory(
	target: Map<string, ClaudeToolDefinition>,
	trajectory: AtifTrajectory,
): void {
	for (const step of trajectory.steps) {
		for (const toolCall of step.tool_calls ?? []) {
			if (!target.has(toolCall.function_name)) {
				target.set(toolCall.function_name, {
					name: toolCall.function_name,
					parameters: toolCall.arguments,
				});
			}
		}
	}
}

function claimMatchingSubagentCandidate(
	toolCallId: string,
	input: Record<string, unknown>,
	candidates: SubagentCandidate[],
): SubagentCandidate | undefined {
	const exactParentMatch = candidates.find(
		(candidate) =>
			!candidate.claimed && candidate.parentToolUseIds.has(toolCallId),
	);
	if (exactParentMatch) {
		exactParentMatch.claimed = true;
		return exactParentMatch;
	}

	const explicitIds = [
		asString(input.agent_id),
		asString(input.agentId),
		asString(input.subagent_id),
		asString(input.subagentId),
	].filter((value): value is string => Boolean(value));
	for (const explicitId of explicitIds) {
		const exact = candidates.find(
			(candidate) => !candidate.claimed && candidate.agentId === explicitId,
		);
		if (exact) {
			exact.claimed = true;
			return exact;
		}
	}

	const prompt = asString(input.prompt)?.trim();
	if (prompt) {
		const exact = candidates.find(
			(candidate) =>
				!candidate.claimed && candidate.firstUserText?.trim() === prompt,
		);
		if (exact) {
			exact.claimed = true;
			return exact;
		}
	}

	const description = asString(input.description)?.trim();
	if (description) {
		const fuzzy = candidates.find(
			(candidate) =>
				!candidate.claimed && candidate.firstUserText?.includes(description),
		);
		if (fuzzy) {
			fuzzy.claimed = true;
			return fuzzy;
		}
	}

	return undefined;
}

function collectParentToolUseIds(envelopes: ClaudeEnvelope[]): Set<string> {
	const ids = new Set<string>();
	for (const envelope of envelopes) {
		const parentToolUseId = asString(envelope.__parentToolUseId);
		if (parentToolUseId) ids.add(parentToolUseId);
	}
	return ids;
}

function buildSidecarStore(sidecarToolResultsDir?: string): SidecarStore {
	const store: SidecarStore = { directByPrefix: new Map(), unclaimed: [] };
	if (!sidecarToolResultsDir || !fs.existsSync(sidecarToolResultsDir))
		return store;
	for (const name of fs.readdirSync(sidecarToolResultsDir).sort()) {
		const fullPath = path.join(sidecarToolResultsDir, name);
		const content = readSidecarEntry(fullPath);
		if (content === undefined) continue;
		const key = name;
		if (name.startsWith("toolu_") || name.startsWith("tooluse_"))
			store.directByPrefix.set(name, content);
		else store.unclaimed.push({ key, content, claimed: false });
	}
	return store;
}

function claimSidecarByToolUseId(
	store: SidecarStore,
	toolUseId: string,
): Qwen35Content | undefined {
	const direct = [...store.directByPrefix.entries()].find(([prefix]) =>
		prefix.startsWith(toolUseId),
	);
	if (direct) {
		store.directByPrefix.delete(direct[0]);
		return direct[1];
	}
	return undefined;
}

function readSidecarEntry(fullPath: string): Qwen35Content | undefined {
	const stat = fs.statSync(fullPath);
	if (stat.isFile()) return fs.readFileSync(fullPath, "utf8");
	if (stat.isDirectory()) return loadSidecarDirectoryContent(fullPath);
	return undefined;
}

function loadSidecarDirectoryContent(
	dirPath: string,
): Qwen35Content | undefined {
	const files = fs.readdirSync(dirPath).sort();
	const blocks: Array<Record<string, unknown>> = [];
	for (const file of files) {
		const ext = path.extname(file).toLowerCase();
		if (
			ext === ".png" ||
			ext === ".jpg" ||
			ext === ".jpeg" ||
			ext === ".webp" ||
			ext === ".gif"
		) {
			blocks.push({
				type: "image",
				placeholder: true,
				source_kind: "claude_tool_result_sidecar_image",
				metadata: { path: path.join(dirPath, file) },
			});
		}
	}
	return blocks.length > 0 ? (blocks as Qwen35Content) : undefined;
}

function formatToolResultContent(
	content: unknown,
	isError: boolean,
	lossyReasons: Set<string>,
): ToolMessage["content"] {
	const base = normalizeToolResultContent(content, lossyReasons);
	if (!isError) return base;
	if (typeof base === "string") {
		return JSON.stringify({ content: base, error: true });
	}
	return JSON.stringify({ content: base, error: true });
}

function normalizeToolResultContent(
	content: unknown,
	lossyReasons: Set<string>,
): ToolMessage["content"] {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		if (
			content.every(
				(block) => isRecord(block) && isQwenBlockType(asString(block.type)),
			)
		) {
			return content as ToolMessage["content"];
		}
		const textParts: string[] = [];
		let hasNonText = false;
		for (const rawBlock of content) {
			if (!isRecord(rawBlock)) {
				hasNonText = true;
				continue;
			}
			const type = asString(rawBlock.type);
			if (type === "text") {
				const text = asString(rawBlock.text);
				if (text) textParts.push(text);
			} else {
				hasNonText = true;
			}
		}
		if (!hasNonText) return textParts.join("\n\n");
		lossyReasons.add("tool_result_non_text_content");
	}
	return JSON.stringify(content);
}

function isQwenBlockType(
	value: string | undefined,
): value is "text" | "image" | "video" {
	return value === "text" || value === "image" || value === "video";
}

function extractProgressEnvelope(
	entry: ClaudeProjectEntry,
): ClaudeEnvelope | null {
	if (entry.type !== "progress") return null;
	const data = isRecord(entry.data) ? entry.data : undefined;
	const wrapped = data && isRecord(data.message) ? data.message : undefined;
	if (!wrapped) return null;

	const envelope: ClaudeEnvelope = {
		...wrapped,
		sessionId: asString(wrapped.sessionId) ?? asString(entry.sessionId),
		cwd: asString(wrapped.cwd) ?? asString(entry.cwd),
		version: asString(wrapped.version) ?? asString(entry.version),
		gitBranch: asString(wrapped.gitBranch) ?? asString(entry.gitBranch),
		timestamp: asString(wrapped.timestamp) ?? asString(entry.timestamp),
	};

	const agentId =
		asString(entry.agentId) ??
		(data && asString(data.agentId)) ??
		asString(wrapped.agentId);
	if (agentId) envelope.__agentId = agentId;

	const parentToolUseId =
		asString(entry.parentToolUseID) ??
		(data && asString(data.parentToolUseID)) ??
		asString(wrapped.parentToolUseID);
	if (parentToolUseId) envelope.__parentToolUseId = parentToolUseId;

	const toolUseId =
		asString(entry.toolUseID) ??
		(data && asString(data.toolUseID)) ??
		asString(wrapped.toolUseID);
	if (toolUseId) envelope.__toolUseId = toolUseId;

	const progressPrompt =
		(data && asString(data.prompt)) ?? asString(wrapped.prompt);
	if (progressPrompt) envelope.__progressPrompt = progressPrompt;

	return envelope;
}

function isTranscriptEnvelope(
	entry: ClaudeProjectEntry,
): entry is ClaudeProjectEntry & ClaudeEnvelope {
	const type = asString(entry.type);
	return (
		type === "user" ||
		type === "assistant" ||
		type === "system" ||
		type === "result"
	);
}

function collapseBlocks(
	blocks: Array<Record<string, unknown>>,
): Qwen35Content | undefined {
	if (blocks.length === 0) return undefined;
	if (
		blocks.length === 1 &&
		blocks[0]?.type === "text" &&
		typeof blocks[0].text === "string"
	) {
		return blocks[0].text;
	}
	return blocks as Qwen35Content;
}

function renderQwenContentAsText(content: Qwen35Content | undefined): string {
	if (content === undefined) return "";
	if (typeof content === "string") return content;
	return content
		.map((block) => {
			if (block.type === "text") return block.text;
			if (block.type === "image") return block.placeholder_token ?? "<image>";
			return block.placeholder_token ?? "<video>";
		})
		.join("");
}

function sanitizeThinking(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const cleaned = value.replace(/<\/?think>/gi, "").trim();
	return cleaned || undefined;
}

function sanitizeLossyReason(value: string): string {
	return (
		value
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "_")
			.replace(/^_+|_+$/g, "") || "unknown"
	);
}

function makeSubagentSessionId(
	parentSessionId: string,
	agentId: string,
): string {
	return `${parentSessionId}:subagent:${agentId}`;
}

function buildClaudeSource(
	sessionId: string,
	file: string,
	cwd?: string,
	parentSessionId?: string,
	agentId?: string,
): string {
	if (!parentSessionId || !agentId) {
		return `claude:session=${sessionId}:cwd=${cwd ?? ""}:file=${file}`;
	}
	return `claude:session=${parentSessionId}:subagent=${agentId}:child_session=${sessionId}:cwd=${cwd ?? ""}:file=${file}`;
}

function sumOptionalNumbers(
	values: Array<number | undefined>,
): number | undefined {
	const defined = values.filter(
		(value): value is number => typeof value === "number",
	);
	if (defined.length === 0) return undefined;
	return defined.reduce((sum, value) => sum + value, 0);
}

function buildClaudeExtra(value: unknown): Record<string, unknown> | undefined {
	const compacted = compactJsonObject(value);
	return compacted ? { claude_export: compacted } : undefined;
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
	)
		return value;
	if (Array.isArray(value)) {
		return value
			.map((entry) => compactJsonValue(entry))
			.filter((entry) => entry !== undefined);
	}
	if (isRecord(value)) {
		const entries = Object.entries(value).flatMap(([key, entry]) => {
			const compactedEntry = compactJsonValue(entry);
			return compactedEntry === undefined
				? []
				: [[key, compactedEntry] as const];
		});
		return Object.fromEntries(entries);
	}
	return value;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
