from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


JsonScalar = str | int | float | bool | None
JsonValue = JsonScalar | list['JsonValue'] | dict[str, 'JsonValue']


class QwenBaseModel(BaseModel):
    model_config = ConfigDict(extra='forbid')


class TextBlock(QwenBaseModel):
    type: Literal['text']
    text: str


class ImageBlock(QwenBaseModel):
    type: Literal['image']
    image_url: str | None = None
    placeholder: bool | None = None
    placeholder_token: str | None = None
    source_kind: str | None = None
    metadata: dict[str, JsonValue] | None = None


class VideoBlock(QwenBaseModel):
    type: Literal['video']
    video_url: str | None = None
    placeholder: bool | None = None
    placeholder_token: str | None = None
    source_kind: str | None = None
    metadata: dict[str, JsonValue] | None = None


ContentBlock = TextBlock | ImageBlock | VideoBlock
Content = str | list[ContentBlock]


class ToolFunction(QwenBaseModel):
    name: str
    arguments: dict[str, JsonValue] = Field(default_factory=dict)


class ToolCall(QwenBaseModel):
    type: Literal['function'] = 'function'
    id: str | None = None
    function: ToolFunction


class ToolSpec(QwenBaseModel):
    name: str
    description: str | None = None
    parameters: dict[str, JsonValue] | None = None


class Roundtrip(QwenBaseModel):
    version: Literal['agentic-dataset-builder/roundtrip-v1']
    canonical_source: Literal['atif', 'qwen35-record', 'derived']
    atif_trajectory_json: str | None = None


class SystemMessage(QwenBaseModel):
    role: Literal['system']
    content: Content


class UserMessage(QwenBaseModel):
    role: Literal['user']
    content: Content


class AssistantMessage(QwenBaseModel):
    role: Literal['assistant']
    content: Content
    reasoning_content: str | None = None
    tool_calls: list[ToolCall] | None = None


class ToolMessage(QwenBaseModel):
    role: Literal['tool']
    content: Content
    tool_call_id: str | None = None
    name: str | None = None


Message = SystemMessage | UserMessage | AssistantMessage | ToolMessage


class Meta(QwenBaseModel):
    endpoint: str
    status: int = Field(ge=100, le=599)
    ts: str
    key: str | None = None
    source: str | None = None
    requested_model: str | None = None
    actual_model: str | None = None
    stream: bool | None = None
    thinking_level: str | None = None
    reasoning_summary_mode: str | list[JsonValue] | dict[str, JsonValue] | None = None
    thinking_type: str | None = None
    thinking_budget_tokens: int | None = Field(default=None, ge=0)
    max_output_tokens: int | None = Field(default=None, ge=0)
    tool_spec_count: int | None = Field(default=None, ge=0)
    tool_choice: str | list[JsonValue] | dict[str, JsonValue] | None = None
    request_contains_non_text_content: bool = False
    request_image_block_count: int = Field(default=0, ge=0)
    request_video_block_count: int = Field(default=0, ge=0)
    request_tool_call_block_count: int = Field(default=0, ge=0)
    request_tool_result_block_count: int = Field(default=0, ge=0)
    request_thinking_block_count: int = Field(default=0, ge=0)
    response_contains_non_text_content: bool = False
    response_image_block_count: int = Field(default=0, ge=0)
    response_video_block_count: int = Field(default=0, ge=0)
    response_tool_call_block_count: int = Field(default=0, ge=0)
    response_tool_result_block_count: int = Field(default=0, ge=0)
    response_thinking_block_count: int = Field(default=0, ge=0)
    request_truncated: bool = False
    response_truncated: bool = False
    lossy_source: bool = False
    lossy_reasons: list[str] = Field(default_factory=list)
    dataset_label: str | None = None
    dataset_source_system: str | None = None
    dataset_source_bucket: str | None = None
    dataset_source_file: str | None = None
    dataset_has_reasoning: bool | None = None
    dataset_reasoning_chars: int | None = Field(default=None, ge=0)
    roundtrip: Roundtrip | None = None

    @model_validator(mode='after')
    def validate_lossy_reason_requirement(self) -> 'Meta':
        if self.lossy_source and not self.lossy_reasons:
            raise ValueError('lossy_source requires lossy_reasons')
        return self


class AgenticLabel(QwenBaseModel):
    label: str
    tool_call_count: int | None = Field(default=None, ge=0)
    tool_message_count: int | None = Field(default=None, ge=0)
    dialogue_rounds_est: int | None = Field(default=None, ge=0)
    reasoning_chars: int | None = Field(default=None, ge=0)
    has_reasoning: bool | None = None
    lossy_source: bool | None = None
    lossy_reasons: list[str] | None = None


class Qwen35Record(QwenBaseModel):
    id: str
    request_id: str | None = None
    messages: list[Message] = Field(min_length=1)
    tools: list[ToolSpec] = Field(default_factory=list)
    meta: Meta
    label: str | None = None
    source_system: str | None = None
    source_bucket: str | None = None
    source_file: str | None = None
    agentic_label: AgenticLabel | None = None

    @model_validator(mode='after')
    def validate_record(self) -> 'Qwen35Record':
        if not any(message.role == 'user' for message in self.messages):
            raise ValueError('at least one user message is required')

        seen_non_system = False
        for message in self.messages:
            if message.role != 'system':
                seen_non_system = True
            elif seen_non_system:
                raise ValueError('system messages must appear only at the beginning')

            if isinstance(message, AssistantMessage) and message.reasoning_content is not None:
                if '<think>' in message.reasoning_content or '</think>' in message.reasoning_content:
                    raise ValueError('reasoning_content must not include <think> wrappers')

        return self
