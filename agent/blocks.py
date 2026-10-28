"""Resultados de tools -> bloques tipados de la respuesta al router (owner: Agustin).

Los bloques siguen exactamente `ReplyBlock` de lambdas/shared/contracts.ts (espejo en
agent/contracts.py). Los limites salen de lambdas/shared/rcs-templates (LIMITS):
el router igual trunca, pero el agente no manda nada que no entre.
"""
from __future__ import annotations

from typing import Any

from contracts import AgentReply, ReplyBlock, text_block

MAX_PROVIDERS = 5
MAX_SLOTS = 4  # entran como respuestas sugeridas
MAX_SUGGESTIONS = 4
MAX_SUGGESTION_CHARS = 25  # LIMITS.suggestionText
MAX_TEXT_CHARS = 320  # cabe en un SMS de fallback (LIMITS.smsBody)
RICH_TYPES = ("provider_carousel", "slot_options", "booking_confirmation")

_PROVIDER_KEYS = ("providerId", "name", "specialty", "procedures", "city", "rating", "reviewCount", "verified", "imageUrl", "profileUrl")
_SLOT_KEYS = ("slotId", "providerId", "startsAt", "durationMinutes", "available")


def tool_base_name(tool: str) -> str:
    """El Gateway nombra las tools `<target>___<tool>`."""
    return tool.split("___")[-1]


def blocks_from_tool_result(tool: str, result: dict[str, Any]) -> list[ReplyBlock]:
    if not isinstance(result, dict) or not result.get("ok"):
        return []
    name = tool_base_name(tool)
    if name == "search_providers" and result.get("providers"):
        providers = [_pick(p, _PROVIDER_KEYS) for p in result["providers"][:MAX_PROVIDERS]]
        return [{"type": "provider_carousel", "providers": providers}]
    if name == "get_availability" and result.get("slots"):
        slots = [_pick(s, _SLOT_KEYS) for s in result["slots"] if s.get("available", True)][:MAX_SLOTS]
        if not slots:
            return []
        provider_name = result.get("providerName") or result["providerId"]
        return [{"type": "slot_options", "providerId": result["providerId"], "providerName": provider_name, "slots": slots}]
    if name in ("book_appointment", "reschedule_appointment") and result.get("appointment") and result.get("provider"):
        return [{"type": "booking_confirmation", "appointment": result["appointment"], "provider": _pick(result["provider"], _PROVIDER_KEYS)}]
    return []


def blocks_from_records(records: list[tuple[str, dict[str, Any]]]) -> list[ReplyBlock]:
    """Un bloque rico por tipo (el ultimo gana), en el orden en que aparecieron, maximo dos."""
    latest: dict[str, tuple[int, ReplyBlock]] = {}
    for i, (tool, result) in enumerate(records):
        for block in blocks_from_tool_result(tool, result):
            latest[block["type"]] = (i, block)
    ordered = [b for _, b in sorted(latest.values(), key=lambda x: x[0])]
    # Si hubo reserva, la confirmacion manda: no tiene sentido volver a ofrecer slots.
    if any(b["type"] == "booking_confirmation" for b in ordered):
        ordered = [b for b in ordered if b["type"] == "booking_confirmation"]
    return ordered[-2:]


def clean_suggestions(suggestions: Any) -> list[str]:
    if not isinstance(suggestions, list):
        return []
    out = []
    for s in suggestions:
        if isinstance(s, str) and s.strip():
            out.append(s.strip()[:MAX_SUGGESTION_CHARS])
    return out[:MAX_SUGGESTIONS]


def clean_text(text: Any) -> str:
    text = " ".join(str(text or "").split())
    if len(text) <= MAX_TEXT_CHARS:
        return text
    cut = text[: MAX_TEXT_CHARS - 1]
    return (cut.rsplit(" ", 1)[0] if " " in cut else cut) + "…"


def make_reply(session_id: str, blocks: list[ReplyBlock], clinical_handoff: bool = False) -> AgentReply:
    reply: AgentReply = {"version": "1", "sessionId": session_id, "blocks": blocks}
    if clinical_handoff:
        reply["clinicalHandoff"] = True
    return reply


def text_reply(session_id: str, text: str, suggestions: list[str] | None = None, clinical_handoff: bool = False) -> AgentReply:
    return make_reply(session_id, [text_block(clean_text(text), clean_suggestions(suggestions))], clinical_handoff)


def validate_reply(reply: dict[str, Any]) -> list[str]:
    """Errores de contrato (lista vacia = ok). Lo usan los tests y el entrypoint antes de responder."""
    errors: list[str] = []
    if reply.get("version") != "1":
        errors.append("version")
    if not isinstance(reply.get("sessionId"), str) or len(reply["sessionId"]) < 33:
        errors.append("sessionId")
    blocks = reply.get("blocks")
    if not isinstance(blocks, list) or not blocks:
        return errors + ["blocks"]
    for i, b in enumerate(blocks):
        t = b.get("type")
        if t == "text":
            if not isinstance(b.get("text"), str) or not b["text"]:
                errors.append(f"blocks[{i}].text")
            if "suggestions" in b and not all(isinstance(s, str) and len(s) <= MAX_SUGGESTION_CHARS for s in b["suggestions"]):
                errors.append(f"blocks[{i}].suggestions")
        elif t == "provider_carousel":
            ps = b.get("providers")
            if not isinstance(ps, list) or not 1 <= len(ps) <= MAX_PROVIDERS or not all(set(_PROVIDER_KEYS) <= set(p) for p in ps):
                errors.append(f"blocks[{i}].providers")
        elif t == "slot_options":
            ss = b.get("slots")
            if not b.get("providerId") or not b.get("providerName"):
                errors.append(f"blocks[{i}].provider")
            if not isinstance(ss, list) or not 1 <= len(ss) <= MAX_SLOTS or not all(set(_SLOT_KEYS) <= set(s) for s in ss):
                errors.append(f"blocks[{i}].slots")
        elif t == "booking_confirmation":
            if not isinstance(b.get("appointment"), dict) or not isinstance(b.get("provider"), dict):
                errors.append(f"blocks[{i}].booking")
        else:
            errors.append(f"blocks[{i}].type")
    if "clinicalHandoff" in reply and not isinstance(reply["clinicalHandoff"], bool):
        errors.append("clinicalHandoff")
    return errors


def _pick(obj: dict[str, Any], keys: tuple[str, ...]) -> dict[str, Any]:
    return {k: obj[k] for k in keys if k in obj}
