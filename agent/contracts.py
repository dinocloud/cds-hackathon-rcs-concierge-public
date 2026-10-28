"""Espejo en Python de lambdas/shared/contracts.ts. Mantener sincronizado."""
from __future__ import annotations

from typing import Any, Literal, NotRequired, TypedDict


class PatientInput(TypedDict):
    type: Literal["text", "postback"]
    text: NotRequired[str]
    postbackData: NotRequired[str]


class AgentInvokeRequest(TypedDict):
    version: Literal["1"]
    sessionId: str
    patientRef: str
    channel: Literal["RCS", "SMS"]
    input: PatientInput
    receivedAt: str
    locale: str


ReplyBlock = dict[str, Any]
"""Uno de: text, provider_carousel, slot_options, booking_confirmation (ver el .ts)."""


class AgentReply(TypedDict):
    version: Literal["1"]
    sessionId: str
    blocks: list[ReplyBlock]
    clinicalHandoff: NotRequired[bool]


def text_block(text: str, suggestions: list[str] | None = None) -> ReplyBlock:
    block: ReplyBlock = {"type": "text", "text": text}
    if suggestions:
        block["suggestions"] = suggestions
    return block
