import { z } from 'zod';

export const AtifJsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(AtifJsonValueSchema),
    z.record(z.string(), AtifJsonValueSchema),
  ]),
);

export const AtifJsonObjectSchema = z.record(z.string(), AtifJsonValueSchema);

export const AtifToolCallSchema = z.object({
  tool_call_id: z.string(),
  function_name: z.string(),
  arguments: AtifJsonObjectSchema.default({}),
  extra: AtifJsonObjectSchema.optional(),
});

export const AtifObservationResultSchema = z.object({
  source_call_id: z.string(),
  content: z.string().nullable().optional(),
  subagent_trajectory_ref: z.string().nullable().optional(),
  extra: AtifJsonObjectSchema.optional(),
});

export const AtifObservationSchema = z.object({
  results: z.array(AtifObservationResultSchema).default([]),
  extra: AtifJsonObjectSchema.optional(),
});

export const AtifMetricsSchema = z.object({
  prompt_tokens: z.number().int().nonnegative().optional(),
  completion_tokens: z.number().int().nonnegative().optional(),
  cached_tokens: z.number().int().nonnegative().optional(),
  cost_usd: z.number().nonnegative().optional(),
  logprobs: z.array(z.number()).optional(),
  prompt_token_ids: z.array(z.number().int()).optional(),
  completion_token_ids: z.array(z.number().int()).optional(),
  extra: AtifJsonObjectSchema.optional(),
});

export const AtifStepSchema = z.object({
  step_id: z.number().int().positive(),
  timestamp: z.string().optional(),
  source: z.union([z.literal('system'), z.literal('user'), z.literal('agent')]),
  message: z.string().optional(),
  reasoning_content: z.string().optional(),
  model_name: z.string().optional(),
  tool_calls: z.array(AtifToolCallSchema).optional(),
  observation: AtifObservationSchema.optional(),
  metrics: AtifMetricsSchema.optional(),
  extra: AtifJsonObjectSchema.optional(),
}).superRefine((step, ctx) => {
  if (step.source !== 'agent') {
    if (step.reasoning_content !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'reasoning_content is only valid on agent steps' });
    }
    if (step.model_name !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'model_name is only valid on agent steps' });
    }
    if (step.tool_calls !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'tool_calls are only valid on agent steps' });
    }
    if (step.observation !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'observation is only valid on agent steps' });
    }
  }
});

export const AtifAgentSchema = z.object({
  name: z.string(),
  version: z.string().optional(),
  model_name: z.string().optional(),
  extra: AtifJsonObjectSchema.optional(),
});

export const AtifFinalMetricsSchema = z.object({
  total_prompt_tokens: z.number().int().nonnegative().optional(),
  total_completion_tokens: z.number().int().nonnegative().optional(),
  total_cached_tokens: z.number().int().nonnegative().optional(),
  total_cost_usd: z.number().nonnegative().optional(),
  total_steps: z.number().int().positive(),
  extra: AtifJsonObjectSchema.optional(),
});

export const AtifTrajectorySchema = z.object({
  schema_version: z.string().default('ATIF-v1.4'),
  session_id: z.string(),
  agent: AtifAgentSchema,
  steps: z.array(AtifStepSchema).min(1),
  final_metrics: AtifFinalMetricsSchema.optional(),
  extra: AtifJsonObjectSchema.optional(),
}).superRefine((trajectory, ctx) => {
  trajectory.steps.forEach((step, index) => {
    const expected = index + 1;
    if (step.step_id !== expected) {
      ctx.addIssue({ code: 'custom', message: `step_id must be sequential starting at 1; expected ${expected}, got ${step.step_id}` });
    }
  });

  const toolCallIds = new Set<string>();
  trajectory.steps.forEach((step) => {
    step.tool_calls?.forEach((toolCall) => toolCallIds.add(toolCall.tool_call_id));
  });

  trajectory.steps.forEach((step) => {
    step.observation?.results.forEach((result) => {
      if (!toolCallIds.has(result.source_call_id)) {
        ctx.addIssue({ code: 'custom', message: `observation result references unknown tool_call_id: ${result.source_call_id}` });
      }
    });
  });

  if (trajectory.final_metrics && trajectory.final_metrics.total_steps !== trajectory.steps.length) {
    ctx.addIssue({ code: 'custom', message: `final_metrics.total_steps must equal steps.length (${trajectory.steps.length})` });
  }
});

export type AtifTrajectory = z.infer<typeof AtifTrajectorySchema>;
export type AtifStep = z.infer<typeof AtifStepSchema>;
export type AtifToolCall = z.infer<typeof AtifToolCallSchema>;
export type AtifObservation = z.infer<typeof AtifObservationSchema>;
export type AtifObservationResult = z.infer<typeof AtifObservationResultSchema>;
export type AtifMetrics = z.infer<typeof AtifMetricsSchema>;
export type AtifFinalMetrics = z.infer<typeof AtifFinalMetricsSchema>;
export type AtifAgent = z.infer<typeof AtifAgentSchema>;
