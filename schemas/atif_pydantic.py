from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator


JsonScalar = str | int | float | bool | None
JsonValue = JsonScalar | list["JsonValue"] | dict[str, "JsonValue"]


class AtifBaseModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ToolCall(AtifBaseModel):
    tool_call_id: str
    function_name: str
    arguments: dict[str, JsonValue] = Field(default_factory=dict)
    extra: dict[str, JsonValue] | None = None


class ObservationResult(AtifBaseModel):
    source_call_id: str
    content: str | None = None
    subagent_trajectory_ref: str | None = None
    extra: dict[str, JsonValue] | None = None


class Observation(AtifBaseModel):
    results: list[ObservationResult] = Field(default_factory=list)
    extra: dict[str, JsonValue] | None = None


class Metrics(AtifBaseModel):
    prompt_tokens: int | None = Field(default=None, ge=0)
    completion_tokens: int | None = Field(default=None, ge=0)
    cached_tokens: int | None = Field(default=None, ge=0)
    cost_usd: float | None = Field(default=None, ge=0)
    logprobs: list[float] | None = None
    prompt_token_ids: list[int] | None = None
    completion_token_ids: list[int] | None = None
    extra: dict[str, JsonValue] | None = None


class Step(AtifBaseModel):
    step_id: int = Field(ge=1)
    timestamp: str | None = None
    source: str
    message: str | None = None
    reasoning_content: str | None = None
    model_name: str | None = None
    tool_calls: list[ToolCall] | None = None
    observation: Observation | None = None
    metrics: Metrics | None = None
    extra: dict[str, JsonValue] | None = None

    @model_validator(mode="after")
    def validate_agent_only_fields(self) -> "Step":
        if self.source != "agent":
            if self.reasoning_content is not None:
                raise ValueError("reasoning_content is only valid on agent steps")
            if self.model_name is not None:
                raise ValueError("model_name is only valid on agent steps")
            if self.tool_calls is not None:
                raise ValueError("tool_calls are only valid on agent steps")
            if self.observation is not None:
                raise ValueError("observation is only valid on agent steps")
        return self


class Agent(AtifBaseModel):
    name: str
    version: str | None = None
    model_name: str | None = None
    extra: dict[str, JsonValue] | None = None


class FinalMetrics(AtifBaseModel):
    total_prompt_tokens: int | None = Field(default=None, ge=0)
    total_completion_tokens: int | None = Field(default=None, ge=0)
    total_cached_tokens: int | None = Field(default=None, ge=0)
    total_cost_usd: float | None = Field(default=None, ge=0)
    total_steps: int = Field(ge=1)
    extra: dict[str, JsonValue] | None = None


class Trajectory(AtifBaseModel):
    schema_version: str = "ATIF-v1.4"
    session_id: str
    agent: Agent
    steps: list[Step] = Field(min_length=1)
    final_metrics: FinalMetrics | None = None
    extra: dict[str, JsonValue] | None = None

    @model_validator(mode="after")
    def validate_trajectory(self) -> "Trajectory":
        tool_call_ids = {
            tool_call.tool_call_id
            for step in self.steps
            for tool_call in (step.tool_calls or [])
        }

        for index, step in enumerate(self.steps, start=1):
            if step.step_id != index:
                raise ValueError(f"step_id must be sequential starting at 1; expected {index}, got {step.step_id}")
            if step.observation:
                for result in step.observation.results:
                    if result.source_call_id not in tool_call_ids:
                        raise ValueError(
                            f"observation result references unknown tool_call_id: {result.source_call_id}"
                        )

        if self.final_metrics and self.final_metrics.total_steps != len(self.steps):
            raise ValueError(
                f"final_metrics.total_steps must equal steps length ({len(self.steps)})"
            )

        return self
