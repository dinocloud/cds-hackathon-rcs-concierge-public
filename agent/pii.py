"""Redaccion de PII antes de escribir en Memory, en logs o de mandarle texto al modelo (owner: Agustin).

Heuristica deliberadamente conservadora para la POC: se prefiere redactar de mas.
Cuidado con los falsos positivos que rompen el flujo: fechas ISO (2026-10-27) e IDs de
slot no se redactan, porque el agente los necesita para reservar.
"""
from __future__ import annotations

import copy
import re
from typing import Any

_DATE_LIKE = re.compile(r"^\d{4}-\d{2}-\d{2}$|^\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?$")


def _phone(match: re.Match[str]) -> str:
    raw = match.group(0)
    digits = sum(c.isdigit() for c in raw)
    if digits < 7 or _DATE_LIKE.match(raw.strip()):
        return raw
    return "[PHONE]"


_MONTHS = r"(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|ene|abr|ago|dic)[a-z]*\.?"

# Orden importante: lo mas especifico primero.
_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("EMAIL", re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")),
    ("SSN", re.compile(r"\b\d{3}-\d{2}-\d{4}\b")),
    ("CARD", re.compile(r"\b(?:\d[ -]?){13,19}\b")),
    (
        "DOB",
        re.compile(
            r"(?i:\b(?:born|birthday|dob|date of birth|nac[ií]|fecha de nacimiento)\b[^\d\n]{0,12})"
            r"(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}-\d{2}-\d{2}|(?i:" + _MONTHS + r")\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+(?i:de\s+)?(?i:" + _MONTHS + r")\s+(?i:de\s+)?\d{4})"
        ),
    ),
    ("DOB", re.compile(r"\b(?:0?[1-9]|1[0-2])[/-](?:0?[1-9]|[12]\d|3[01])[/-](?:19|20)\d{2}\b")),
    ("NAME", re.compile(r"(?i:\b(?:my name is|my name's|me llamo|mi nombre es)\b)\s+[A-ZÁÉÍÓÚÑ][\w'-]+(?:\s+[A-ZÁÉÍÓÚÑ][\w'-]+)?")),
    (
        "ADDRESS",
        re.compile(
            r"\b\d{1,6}\s+(?:[A-Z][\w.]*\s){1,4}(?i:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|ct|court)\b\.?"
        ),
    ),
]
_PHONE = re.compile(r"(?<![\w#:%])\+?\d[\d\s().-]{5,}\d(?![\w:])")


def redact(text: str) -> str:
    """Reemplaza PII por marcadores [EMAIL], [PHONE], [CARD], [SSN], [DOB], [NAME], [ADDRESS]."""
    if not text:
        return text
    out = text
    for label, pattern in _PATTERNS:
        out = pattern.sub(_name_sub if label == "NAME" else f"[{label}]", out)
    return _PHONE.sub(_phone, out)


def _name_sub(match: re.Match[str]) -> str:
    """Conserva la frase ("my name is") y redacta solo el nombre."""
    text = match.group(0)
    lead = re.match(r"(?i)(my name is|my name's|me llamo|mi nombre es)", text)
    return f"{lead.group(0) if lead else ''} [NAME]".strip()


def redact_message(message: dict[str, Any]) -> dict[str, Any]:
    """Copia de un mensaje Converse/Strands con los bloques de texto redactados.

    Solo toca `text`: toolUse/toolResult llevan IDs y fechas que el agente necesita,
    y nunca contienen texto libre del paciente (el input ya llega redactado).
    """
    out = copy.deepcopy(message)
    for part in out.get("content", []) or []:
        if isinstance(part, dict) and isinstance(part.get("text"), str):
            part["text"] = redact(part["text"])
    return out
