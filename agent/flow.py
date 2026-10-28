"""Flujo determinista del concierge (owner: Agustin).

Sirve para dos cosas:
- Backend del modo --local y de los tests (sin modelo, sin AWS).
- Red de seguridad del modo aws: si Bedrock o Memory fallan, el turno se resuelve igual
  con las mismas tools del Gateway y la demo no se queda muda.

Estado por sesion en memoria del proceso (AgentCore Runtime mantiene una microVM por
sesion): idioma, ultima lista ofrecida (para respuestas "1", "2" por SMS), turnos reservados
y un reschedule pendiente. No guarda texto del paciente.
"""
from __future__ import annotations

import logging
import re
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import parse_qs

from blocks import blocks_from_records, blocks_from_tool_result, make_reply, text_reply, tool_base_name
from contracts import AgentReply, ReplyBlock, text_block
from tool_client import TOOL_READ_TIMEOUT_S, ToolClient

log = logging.getLogger("concierge.flow")

PROCEDURES: dict[str, tuple[str, ...]] = {
    "rhinoplasty": ("rhinoplasty", "nose job", "rinoplastia"),
    "botox": ("botox", "bótox"),
    "fillers": ("fillers", "filler", "rellenos", "relleno"),
    "facelift": ("facelift", "face lift", "lifting facial", "lifting"),
    "tummy tuck": ("tummy tuck", "abdominoplastia"),
    "laser": ("laser", "láser"),
    "blepharoplasty": ("blepharoplasty", "eyelid surgery", "blefaroplastia"),
}
CITIES = ("Miami", "Austin", "San Diego")
_PROCEDURE_ES = {
    "rhinoplasty": "rinoplastia",
    "fillers": "rellenos",
    "facelift": "lifting facial",
    "tummy tuck": "abdominoplastia",
    "laser": "láser",
    "blepharoplasty": "blefaroplastia",
}

_MSG: dict[str, dict[str, str]] = {
    "greet": {
        "en": "Hey! I can find you a verified provider and book a consult. What treatment are you curious about, and where?",
        "es": "Hola! Te ayudo a encontrar un especialista verificado y reservar una consulta. Qué tratamiento te interesa y en qué ciudad?",
    },
    "ask_city": {"en": "Love it. Which city works for you?", "es": "Genial. En qué ciudad te queda mejor?"},
    "ask_procedure": {
        "en": "Got it. Which treatment are you thinking about?",
        "es": "Perfecto. Qué tratamiento tienes en mente?",
    },
    "providers": {
        "en": "Here are top verified {procedure} providers in {city}:",
        "es": "Estos son especialistas verificados en {procedure} en {city}:",
    },
    "no_providers": {
        "en": "I couldn't find {procedure} providers in {city} yet. Want to try another city?",
        "es": "Todavía no encontré especialistas de {procedure} en {city}. Probamos otra ciudad?",
    },
    "slots": {"en": "Love that pick. Here are the next openings:", "es": "Buena elección. Estos son los próximos horarios:"},
    "no_slots": {
        "en": "They're fully booked this week. Want to see another provider?",
        "es": "No tiene horarios esta semana. Quieres ver otro especialista?",
    },
    "booked": {"en": "You're booked! I'll send reminders before your consult.", "es": "Listo, reservado! Te mando recordatorios antes de la consulta."},
    "rescheduled": {"en": "Done, your consult is moved.", "es": "Listo, tu consulta quedó reprogramada."},
    "slot_taken": {
        "en": "That time just got taken. Here are the next openings:",
        "es": "Ese horario se acaba de ocupar. Estos son los siguientes:",
    },
    "cancelled": {"en": "Done, your consult is cancelled.", "es": "Listo, tu consulta quedó cancelada."},
    "not_found": {"en": "I couldn't find that booking.", "es": "No encontré esa reserva."},
    "not_active": {"en": "That appointment is no longer active.", "es": "Ese turno ya no está activo."},
    "unconfirmed": {
        "en": "I couldn't confirm that right now, please check again in a moment.",
        "es": "No pude confirmarlo ahora, vuelve a revisar en un momento.",
    },
    "confirmed": {"en": "You're all set. See you there!", "es": "Perfecto, confirmado. Nos vemos!"},
    "reschedule_unknown": {
        "en": "I couldn't pull up that booking right now. Tap Reschedule on your latest reminder and I'll show new times.",
        "es": "No pude abrir esa reserva ahora. Toca Reschedule en tu último recordatorio y te muestro nuevos horarios.",
    },
    "reschedule_same_provider": {
        "en": "Rescheduling keeps the same provider. Here are their next openings:",
        "es": "Reprogramar mantiene el mismo especialista. Estos son sus próximos horarios:",
    },
    "reschedule_slots": {"en": "No problem. Here are new times:", "es": "Sin problema. Estos son los nuevos horarios:"},
    "profile": {
        "en": "Take a look, and tap See availability when you're ready.",
        "es": "Míralo con calma y toca See availability cuando quieras.",
    },
    "tool_error": {
        "en": "Sorry, I hit a snag on my side. Can you try again in a moment?",
        "es": "Perdón, tuve un problema de mi lado. Probamos de nuevo en un momento?",
    },
    "fallback": {"en": "Got it. What would you like to do next?", "es": "Entendido. Qué quieres hacer ahora?"},
}
_SUGGEST = {
    "greet": {"en": ["Rhinoplasty in Miami", "Botox in Austin"], "es": ["Rinoplastia en Miami", "Botox en Austin"]},
    "ask_city": {"en": list(CITIES), "es": list(CITIES)},
}


def msg(key: str, lang: str, **kw: str) -> str:
    if lang == "es" and "procedure" in kw:
        kw["procedure"] = _PROCEDURE_ES.get(kw["procedure"], kw["procedure"])
    return _MSG[key].get(lang, _MSG[key]["en"]).format(**kw)


@dataclass
class Turn:
    """Un mensaje del paciente ya normalizado y redactado."""

    session_id: str
    patient_ref: str
    channel: str
    lang: str
    text: str = ""  # texto redactado (input de texto o `t` de un postback reply)
    action: dict[str, str] | None = None  # postback decodificado, salvo a=reply


@dataclass
class SessionState:
    lang: str = "en"
    procedure: str | None = None
    city: str | None = None
    last_offer: str | None = None  # "providers" | "slots"
    last_providers: list[str] = field(default_factory=list)
    last_slots: list[tuple[str, str]] = field(default_factory=list)  # (providerId, slotId)
    appointments: dict[str, str] = field(default_factory=dict)  # appointmentId -> providerId
    pending_reschedule: str | None = None
    pending_reschedule_provider: str | None = None  # reprogramar es siempre con el mismo provider


class SessionStore:
    """LRU chico en memoria del proceso. Clave: sessionId (HMAC), nunca el telefono."""

    def __init__(self, capacity: int = 512) -> None:
        self.capacity = capacity
        self._data: OrderedDict[str, SessionState] = OrderedDict()

    def get(self, session_id: str) -> SessionState:
        state = self._data.pop(session_id, None) or SessionState()
        self._data[session_id] = state
        while len(self._data) > self.capacity:
            self._data.popitem(last=False)
        return state

    def peek(self, session_id: str) -> SessionState | None:
        return self._data.get(session_id)


def parse_postback(data: str) -> dict[str, str]:
    return {k: v[0] for k, v in parse_qs(data or "", keep_blank_values=False).items()}


def extract_procedure(text: str) -> str | None:
    low = text.lower()
    for canonical, aliases in PROCEDURES.items():
        if any(re.search(rf"\b{re.escape(a)}\b", low) for a in aliases):
            return canonical
    return None


def extract_city(text: str) -> str | None:
    low = text.lower()
    for city in CITIES:
        if re.search(rf"\b{city.lower()}\b", low):
            return city
    match = re.search(r"\b(?:in|near|en|cerca de)\s+([a-zA-Z][a-zA-Z .'-]{1,30})$", text.strip().rstrip("?.!"))
    return match.group(1).strip().title() if match else None


# Peor caso de una tool del Gateway (TOOL_READ_TIMEOUT_S en tool_client.py). El flujo no
# arranca una tool si no le queda al menos esto antes del deadline del turno.
TOOL_RESERVE_S = TOOL_READ_TIMEOUT_S


class DeadlineToolClient:
    """Envuelve el ToolClient de un turno: pasado el deadline (time.monotonic) no arranca tools.

    Devuelve TIMEOUT sin llamar (nada se escribio), igual que build_tools en strands_backend.py.
    Asi el fallback despues de un modelo lento no suma dos llamadas de 10 s por encima del
    timeout del router.
    """

    def __init__(self, inner: ToolClient, deadline: float, reserve_s: float = TOOL_RESERVE_S) -> None:
        self.inner = inner
        self.deadline = deadline
        self.reserve_s = reserve_s

    def call(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        if time.monotonic() + self.reserve_s > self.deadline:
            log.warning("flow_tool_skipped_budget tool=%s", name)
            return {"ok": False, "error": "turn_budget_exceeded", "code": "TIMEOUT"}
        return self.inner.call(name, args)


class DeterministicFlow:
    def __init__(self, tools: ToolClient, sessions: SessionStore | None = None) -> None:
        self.tools = tools
        self.sessions = sessions or SessionStore()

    # ---- entrada ----

    def respond(self, turn: Turn, deadline: float | None = None) -> AgentReply:
        """`deadline` (time.monotonic, opcional): tope del turno completo. Lo pasa el Concierge
        para que el fallback despues del modelo no se pase del timeout del router."""
        if deadline is not None:
            return DeterministicFlow(DeadlineToolClient(self.tools, deadline), self.sessions).respond(turn)
        state = self.sessions.get(turn.session_id)
        state.lang = turn.lang
        lang = turn.lang
        if turn.action:
            return self._postback(turn, state, lang)
        return self._text(turn, state, lang)

    # ---- texto libre ----

    def _text(self, turn: Turn, state: SessionState, lang: str) -> AgentReply:
        text = turn.text.strip()
        sid = turn.session_id

        if text.startswith("profile:"):
            return text_reply(sid, msg("profile", lang))

        # Respuestas numericas a una lista (camino SMS: "Reply with a number").
        if re.fullmatch(r"[1-9]", text) and state.last_offer:
            idx = int(text) - 1
            if state.last_offer == "slots" and idx < len(state.last_slots):
                provider_id, slot_id = state.last_slots[idx]
                return self._select_slot(turn, state, lang, provider_id, slot_id)
            if state.last_offer == "providers" and idx < len(state.last_providers):
                return self._select_provider(turn, state, lang, state.last_providers[idx])

        procedure = extract_procedure(text) or None
        city = extract_city(text)
        if procedure:
            state.procedure = procedure
        if city:
            state.city = city

        if procedure and (city or state.city) or (city and state.procedure):
            return self._search(turn, state, lang, state.procedure or procedure, city or state.city)
        if procedure:
            return text_reply(sid, msg("ask_city", lang), _SUGGEST["ask_city"][lang])
        if city:
            return text_reply(sid, msg("ask_procedure", lang))
        return text_reply(sid, msg("greet", lang), _SUGGEST["greet"][lang])

    # ---- postbacks ----

    def _postback(self, turn: Turn, state: SessionState, lang: str) -> AgentReply:
        action = turn.action or {}
        a = action.get("a")
        sid = turn.session_id
        if a == "select_provider" and action.get("p"):
            if state.pending_reschedule_provider and action["p"] != state.pending_reschedule_provider:
                _clear_reschedule(state)  # eligio otro provider: es una reserva nueva, no un cambio
            return self._select_provider(turn, state, lang, action["p"])
        if a == "select_slot" and action.get("p") and action.get("s"):
            return self._select_slot(turn, state, lang, action["p"], action["s"], action.get("ap"))
        if a == "confirm":
            return text_reply(sid, msg("confirmed", lang))
        if a == "cancel" and action.get("ap"):
            result = self.tools.call("cancel_appointment", {"appointmentId": action["ap"], "patientRef": turn.patient_ref})
            if result.get("ok"):
                state.appointments.pop(action["ap"], None)
                if state.pending_reschedule == action["ap"]:
                    _clear_reschedule(state)
                return text_reply(sid, msg("cancelled", lang))
            return text_reply(sid, msg(_write_error_key(result), lang))
        if a == "reschedule" and action.get("ap"):
            # El recordatorio llega 24 o 48 h despues, a una sesion nueva (SessionStore vacio):
            # el postback trae `p` (providerId) para ese caso. Reprogramar es siempre con el
            # mismo provider (la Lambda tools devuelve BAD_REQUEST si no).
            provider_id = state.appointments.get(action["ap"]) or action.get("p")
            if not provider_id:
                _clear_reschedule(state)
                return text_reply(sid, msg("reschedule_unknown", lang))
            state.pending_reschedule = action["ap"]
            state.pending_reschedule_provider = provider_id
            return self._select_provider(turn, state, lang, provider_id, intro_key="reschedule_slots")
        return text_reply(sid, msg("fallback", lang))

    # ---- pasos del caso 1 ----

    def _search(self, turn: Turn, state: SessionState, lang: str, procedure: str, city: str) -> AgentReply:
        _clear_reschedule(state)  # una busqueda nueva es una reserva nueva
        result = self.tools.call("search_providers", {"procedure": procedure, "city": city, "limit": 5})
        if not result.get("ok"):
            return text_reply(turn.session_id, msg("tool_error", lang))
        blocks = blocks_from_tool_result("search_providers", result)
        if not blocks:
            return text_reply(turn.session_id, msg("no_providers", lang, procedure=procedure, city=city), _SUGGEST["ask_city"][lang])
        state.last_offer = "providers"
        state.last_providers = [p["providerId"] for p in blocks[0]["providers"]]
        return make_reply(turn.session_id, [text_block(msg("providers", lang, procedure=procedure, city=city))] + blocks)

    def _select_provider(self, turn: Turn, state: SessionState, lang: str, provider_id: str, intro_key: str = "slots") -> AgentReply:
        result = self.tools.call("get_availability", {"providerId": provider_id, "limit": 4})
        if not result.get("ok"):
            key = "fallback" if result.get("code") == "NOT_FOUND" else "tool_error"
            return text_reply(turn.session_id, msg(key, lang))
        blocks = blocks_from_tool_result("get_availability", result)
        if not blocks:
            return text_reply(turn.session_id, msg("no_slots", lang))
        state.last_offer = "slots"
        state.last_slots = [(s["providerId"], s["slotId"]) for s in blocks[0]["slots"]]
        return make_reply(turn.session_id, [text_block(msg(intro_key, lang))] + blocks)

    def _select_slot(
        self, turn: Turn, state: SessionState, lang: str, provider_id: str, slot_id: str, appointment_id: str | None = None
    ) -> AgentReply:
        appointment_id = appointment_id or state.pending_reschedule
        if appointment_id:
            expected = state.appointments.get(appointment_id) or (
                state.pending_reschedule_provider if appointment_id == state.pending_reschedule else None
            )
            if expected and provider_id != expected:
                # Nunca se manda un reschedule con un slot de otro provider: se ofrecen los del mismo.
                return self._select_provider(turn, state, lang, expected, intro_key="reschedule_same_provider")
            tool = "reschedule_appointment"
            result = self.tools.call(tool, {"appointmentId": appointment_id, "newSlotId": slot_id, "patientRef": turn.patient_ref})
        else:
            tool = "book_appointment"
            result = self.tools.call(
                tool,
                {"providerId": provider_id, "slotId": slot_id, "patientRef": turn.patient_ref, "procedure": state.procedure},
            )
        if result.get("ok"):
            _clear_reschedule(state)
            state.last_offer = None
            appt = result["appointment"]
            state.appointments[appt["appointmentId"]] = appt["providerId"]
            key = "rescheduled" if tool == "reschedule_appointment" else "booked"
            blocks: list[ReplyBlock] = [text_block(msg(key, lang))] + blocks_from_tool_result(tool, result)
            return make_reply(turn.session_id, blocks)
        if result.get("code") == "SLOT_TAKEN":
            nxt = self._select_provider(turn, state, lang, provider_id, intro_key="slot_taken")
            return nxt
        if tool == "reschedule_appointment":
            # Turno cancelado (BAD_REQUEST) o ajeno: reintentar va a volver a fallar.
            key = _write_error_key(result)
            if key != "tool_error":
                _clear_reschedule(state)
            return text_reply(turn.session_id, msg(key, lang))
        return text_reply(turn.session_id, msg("tool_error", lang))


    # ---- recuperacion cuando el modelo fallo a mitad de turno ----

    def reply_from_records(self, turn: Turn, records: list[tuple[str, dict[str, Any]]]) -> AgentReply | None:
        """Si el modelo ya ejecuto una accion con efecto (reserva, cambio o cancelacion) y despues
        fallo, la respuesta sale de esos resultados: volver a correr el flujo repetiria la accion
        (y una reserva repetida devuelve SLOT_TAKEN aunque el turno haya quedado reservado).
        Si una escritura volvio UPSTREAM o INTERNAL, el resultado es incierto: no se corre el
        flujo (repetiria la reserva) y se pide al paciente que revise en un momento. Los
        resultados definitivos (SLOT_TAKEN, NOT_FOUND, BAD_REQUEST, FORBIDDEN) garantizan que no
        se escribio nada, igual que un TIMEOUT por presupuesto (corta antes de mandar la
        llamada): esos dejan correr el flujo normal.
        Devuelve None si no hubo ninguna escritura exitosa ni incierta.
        """
        lang = turn.lang
        state = self.sessions.get(turn.session_id)
        done: tuple[str, dict[str, Any]] | None = None
        uncertain = False
        for tool, result in records:
            name = tool_base_name(tool)
            if name not in WRITE_KEYS or not isinstance(result, dict):
                continue
            if result.get("ok"):
                done = (name, result)
            elif result.get("code") in UNCERTAIN_CODES:
                uncertain = True
        if done is None:
            return text_reply(turn.session_id, msg("unconfirmed", lang)) if uncertain else None
        name, result = done
        appt = result.get("appointment") or {}
        if name == "cancel_appointment":
            state.appointments.pop(appt.get("appointmentId", ""), None)
        elif appt.get("appointmentId"):
            state.appointments[appt["appointmentId"]] = appt.get("providerId", "")
            _clear_reschedule(state)
            state.last_offer = None
        blocks: list[ReplyBlock] = [text_block(msg(WRITE_KEYS[name], lang))] + blocks_from_records(records)
        return make_reply(turn.session_id, blocks)


WRITE_KEYS = {"book_appointment": "booked", "reschedule_appointment": "rescheduled", "cancel_appointment": "cancelled"}
# Escritura que salio sin respuesta definitiva: puede haber quedado hecha.
UNCERTAIN_CODES = ("UPSTREAM", "INTERNAL")


def _clear_reschedule(state: SessionState) -> None:
    state.pending_reschedule = None
    state.pending_reschedule_provider = None


def _write_error_key(result: dict[str, Any]) -> str:
    """Mensaje para un cancel/reschedule fallido. BAD_REQUEST: el turno ya esta cancelado (lambdas/tools)."""
    code = result.get("code")
    if code in ("NOT_FOUND", "FORBIDDEN"):
        return "not_found"
    if code == "BAD_REQUEST":
        return "not_active"
    return "tool_error"


def turn_from_request(request: dict[str, Any], lang: str, redact_fn) -> Turn:
    """Normaliza el input del router: postbacks `a=reply&t=...` se tratan como texto."""
    inp = request["input"]
    if inp.get("type") == "postback":
        action = parse_postback(inp.get("postbackData", ""))
        if action.get("a") == "reply" or not action.get("a"):
            return Turn(request["sessionId"], request["patientRef"], request["channel"], lang, text=redact_fn(action.get("t") or inp.get("text", "")))
        return Turn(request["sessionId"], request["patientRef"], request["channel"], lang, action=action)
    return Turn(request["sessionId"], request["patientRef"], request["channel"], lang, text=redact_fn(inp.get("text", "")))
