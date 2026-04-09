from __future__ import annotations

import hashlib
import json
import re

from pydantic import BaseModel, ConfigDict, RootModel, model_validator

from qwen35_pydantic import Qwen35Record


QWEN_PLAIN_TEXT_CODEC_VERSION = 'agentic-dataset-builder/qwen-plain-text-v1'
QWEN_PLAIN_TEXT_METADATA_BEGIN = '<<<AGENTIC_DATASET_BUILDER_QWEN_PLAINTEXT_METADATA_BEGIN>>>'
QWEN_PLAIN_TEXT_METADATA_END = '<<<AGENTIC_DATASET_BUILDER_QWEN_PLAINTEXT_METADATA_END>>>'
SHA256_HEX_RE = re.compile(r'^[a-f0-9]{64}$')


class PlainTextBaseModel(BaseModel):
    model_config = ConfigDict(extra='forbid')


class QwenPlainTextMetadata(PlainTextBaseModel):
    codec_version: str
    body_sha256: str
    qwen_record_json: str

    @model_validator(mode='after')
    def validate_metadata(self) -> 'QwenPlainTextMetadata':
        if self.codec_version != QWEN_PLAIN_TEXT_CODEC_VERSION:
            raise ValueError(f'unsupported plain-text codec version: {self.codec_version}')
        if not SHA256_HEX_RE.match(self.body_sha256):
            raise ValueError('body_sha256 must be a lowercase hex sha256 digest')
        Qwen35Record.model_validate_json(self.qwen_record_json)
        return self


class QwenPlainTextArtifact(PlainTextBaseModel):
    body: str
    metadata: QwenPlainTextMetadata
    text: str

    @model_validator(mode='after')
    def validate_artifact(self) -> 'QwenPlainTextArtifact':
        if self.metadata.body_sha256 != hashlib.sha256(self.body.encode('utf-8')).hexdigest():
            raise ValueError('metadata.body_sha256 must match the plaintext body')

        expected = (
            f"{self.body}\n{QWEN_PLAIN_TEXT_METADATA_BEGIN}\n"
            f"{json.dumps(self.metadata.model_dump(), sort_keys=True, separators=(',', ':'))}\n"
            f"{QWEN_PLAIN_TEXT_METADATA_END}\n"
        )
        if self.text != expected:
            raise ValueError('text must equal the canonical body plus metadata trailer')
        return self


class QwenPlainText(RootModel[str]):
    @model_validator(mode='after')
    def validate_plain_text(self) -> 'QwenPlainText':
        text = self.root
        begin_index = text.find(QWEN_PLAIN_TEXT_METADATA_BEGIN)
        end_index = text.find(QWEN_PLAIN_TEXT_METADATA_END)
        if begin_index == -1 or end_index == -1 or end_index < begin_index:
            raise ValueError('missing plaintext metadata trailer')

        body = text[:begin_index].removesuffix('\n')
        metadata_start = begin_index + len(QWEN_PLAIN_TEXT_METADATA_BEGIN)
        metadata_json = text[metadata_start:end_index].strip()
        metadata = QwenPlainTextMetadata.model_validate(json.loads(metadata_json))
        QwenPlainTextArtifact.model_validate({
            'body': body,
            'metadata': metadata.model_dump(),
            'text': text,
        })
        return self
