"""Guardrails deterministas del concierge (owner: Agustin).

Tres capas, de la mas barata a la mas cara:
1. Entrada: si el paciente pregunta algo clinico, se responde con la derivacion sin llamar al modelo.
2. Prompt: reglas duras en prompt.md para lo que la regex no ve.
3. Salida: si el texto del modelo parece consejo clinico (dosis, tiempos de recuperacion), se reemplaza.

Idioma: ingles para pacientes de EE.UU., espanol solo si el paciente escribe en espanol.
"""
from __future__ import annotations

import re

Lang = str  # "en" | "es"

_CLINICAL = re.compile(
    r"\b("
    # ingles
    r"pain|pains|painful|painkillers?|hurts?|hurting|bleed\w*|blood|infect\w*|swell\w*|swollen|bruis\w*|fever|allerg\w*|"
    r"dose|dosage|units? of|side[- ]effects?|is it safe|safe for me|risks?|risky|complications?|"
    r"recover(y|ing|ed)?|heal(s|ing|ed)?|downtime|scars?|scarring|scarred|numb|numbness|numbing|pregnan\w*|breastfeed\w*|medication|meds|"
    r"antibiotic\w*|ibuprofen|aspirin|blood thinners?|diabet\w*|am i a (good )?candidate|"
    r"should i (be worried|worry|see a doctor|take|stop)|results? (look|last)|how long does it last|symptom\w*|rash|"
    # espanol
    r"dolor|doloros[ao]s?|duele|duelen|sangr\w*|infecci\w*|hinch\w*|moret\w*|fiebre|alergi\w*|al[eé]rgic\w*|dosis|"
    r"efectos? secundarios?|es seguro|riesgos?|complicaci\w*|recuperaci\w*|cicatri\w*|embaraz\w*|"
    r"medicamentos?|antibi[oó]tic\w*|s[ií]ntomas?|soy candidat[ao]"
    r")\b",
    re.IGNORECASE,
)

_URGENT = re.compile(
    r"\b(can'?t breathe|cannot breathe|trouble breathing|chest pain|severe|emergency|fainted|"
    r"passed out|heavy bleeding|bleeding a lot|no puedo respirar|dolor de pecho|emergencia|"
    r"me desmay\w*|sangra mucho|grave)\b",
    re.IGNORECASE,
)

# Salida del modelo que suena a indicacion clinica.
_CLINICAL_OUTPUT = re.compile(
    r"\b(\d+\s?(mg|ml|cc|units?|unidades)\b|you should (take|avoid|stop)|"
    r"recovery (takes|is about|usually)|downtime (is|of)|side effects (are|include)|"
    r"deber[ií]as tomar|la recuperaci[oó]n (dura|toma))",
    re.IGNORECASE,
)

_SPANISH_HINTS = re.compile(
    r"[¿¡ñ]|\b(hola|quiero|quisiera|necesito|busco|turno|cita|consulta|gracias|por favor|"
    r"d[oó]nde|cu[aá]ndo|ma[nñ]ana|rinoplastia|rellenos?|abdominoplastia|blefaroplastia|"
    r"lifting|l[aá]ser|en (miami|austin|san diego)|s[ií]|cerca de|me gustar[ií]a|hacerme)\b",
    re.IGNORECASE,
)

_ENGLISH_HINTS = re.compile(
    r"\b(hi|hello|hey|i want|i'd like|i would like|looking for|please|thanks|thank you|book|appointment|"
    r"available|near me|what|which|when|where|can you|yes|no thanks)\b",
    re.IGNORECASE,
)

_MESSAGES: dict[str, dict[Lang, str]] = {
    "handoff": {
        "en": "That's a great one for your provider, they'll cover it in your consult. I can't give medical advice, but I can help you book.",
        "es": "Esa es ideal para tu especialista, la van a ver en la consulta. No puedo dar consejo médico, pero te ayudo a reservar.",
    },
    "urgent": {
        "en": "That sounds like it needs attention now. Please contact your clinic right away or call 911 if it's an emergency.",
        "es": "Eso necesita atención ya. Contacta a tu clínica de inmediato o llama al 911 si es una emergencia.",
    },
}


def detect_language(text: str, locale: str = "en-US", previous: Lang | None = None) -> Lang:
    """Espanol si el paciente escribe en espanol (o el router mando es-US); si no, ingles."""
    if text and _SPANISH_HINTS.search(text):
        return "es"
    if text and _ENGLISH_HINTS.search(text):
        return "en"
    if previous:
        return previous
    return "es" if locale.lower().startswith("es") else "en"


def is_clinical(text: str) -> bool:
    return bool(text) and bool(_CLINICAL.search(text))


def is_urgent(text: str) -> bool:
    return bool(text) and bool(_URGENT.search(text))


def handoff_message(text: str, lang: Lang) -> str:
    return _MESSAGES["urgent" if is_urgent(text) else "handoff"][lang]


def output_looks_clinical(text: str) -> bool:
    return bool(text) and bool(_CLINICAL_OUTPUT.search(text))
