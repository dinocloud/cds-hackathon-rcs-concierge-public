"""Backend con modelo: Strands + Bedrock + tools (Gateway o locales) + AgentCore Memory (owner: Agustin).

Decisiones:
- El modelo no ve ni maneja `patientRef`: lo inyectan los wrappers de las tools. Un hash de
  64 caracteres copiado por el modelo es una fuente de errores evitable.
- Los bloques ricos (carrusel, slots, confirmacion) salen de los resultados reales de las
  tools, nunca del texto del modelo: el modelo solo escribe la linea que los acompana.
- Memory: sesion = `sessionId` del router (HMAC, nunca el telefono), actor = `patientRef`.
  El texto ya llega redactado y, ademas, el session manager redacta cada mensaje antes de
  escribirlo (defensa en profundidad).
- Imports de strands y bedrock_agentcore adentro de las funciones: el modo local y los tests
  no los necesitan instalados.
"""
from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable

from blocks import blocks_from_records, clean_suggestions, clean_text, make_reply
from contracts import AgentReply, ReplyBlock, text_block
from flow import Turn
from pii import redact_message
from tool_client import ToolClient

log = logging.getLogger("concierge.strands")


@dataclass(frozen=True)
class ModelConfig:
    model_id: str
    region: str
    temperature: float = 0.3
    max_tokens: int = 800
    prompt_cache: bool = True
    # Presupuesto del modelo dentro del turno. El router invoca AgentCore con timeout de 75 s
    # (Lambda de 90 s, PR #3) y el Concierge corta el turno completo en TURN_DEADLINE_S = 65 s
    # (app.py). Al llegar a turn_budget_s se cancela el agente; lo que puede quedar en curso es
    # una lectura del modelo (read_timeout_s) o una tool (TOOL_READ_TIMEOUT_S = 10 s): 35 + 15 =
    # 50 s en el peor caso. El fallback determinista solo arranca tools que terminan antes de
    # los 65 s (flow.DeadlineToolClient), asi que el turno entero queda por debajo de 75 s.
    connect_timeout_s: int = 3
    read_timeout_s: int = 15
    max_model_attempts: int = 2
    turn_budget_s: float = 35.0

    @classmethod
    def from_env(cls) -> "ModelConfig":
        model_id = os.environ.get("MODEL_ID") or os.environ.get("AGENT_MODEL_ID")
        if not model_id:
            raise RuntimeError("Falta MODEL_ID (inference profile de Bedrock)")
        return cls(
            model_id=model_id,
            region=os.environ.get("AGENT_REGION") or os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-east-1",
            temperature=float(os.environ.get("MODEL_TEMPERATURE", "0.3")),
            max_tokens=int(os.environ.get("MODEL_MAX_TOKENS", "800")),
            prompt_cache=os.environ.get("PROMPT_CACHE", "true").lower() == "true",
            connect_timeout_s=int(os.environ.get("MODEL_CONNECT_TIMEOUT_S", "3")),
            read_timeout_s=int(os.environ.get("MODEL_READ_TIMEOUT_S", "15")),
            max_model_attempts=int(os.environ.get("MODEL_MAX_ATTEMPTS", "2")),
            turn_budget_s=float(os.environ.get("TURN_BUDGET_S", "35")),
        )


# ---------- Tools que ve el modelo ----------


def _compact(name: str, result: dict[str, Any]) -> dict[str, Any]:
    """Lo minimo que el modelo necesita para decidir; ahorra tokens y evita que copie URLs."""
    if not result.get("ok"):
        return {"ok": False, "code": result.get("code", "ERROR")}
    if name == "search_providers":
        keys = ("providerId", "name", "specialty", "rating", "reviewCount", "verified")
        return {"ok": True, "providers": [{k: p.get(k) for k in keys} for p in result.get("providers", [])]}
    if name == "get_availability":
        return {
            "ok": True,
            "providerId": result.get("providerId"),
            "providerName": result.get("providerName"),
            "slots": [{"slotId": s["slotId"], "startsAt": s["startsAt"]} for s in result.get("slots", [])],
        }
    appt = result.get("appointment") or {}
    return {
        "ok": True,
        "appointmentId": appt.get("appointmentId"),
        "status": appt.get("status"),
        "startsAt": appt.get("startsAt"),
        "providerName": (result.get("provider") or {}).get("name"),
    }


def build_tools(
    client: ToolClient,
    patient_ref: str,
    records: list[tuple[str, dict[str, Any]]],
    deadline: float | None = None,
) -> list[Any]:
    """Tools de Strands ligadas a un turno: inyectan patientRef y registran el resultado completo.

    Pasado `deadline` (time.monotonic) no se arrancan tools nuevas: una reserva tardia que el
    router ya no puede confirmar es peor que pedirle al paciente que repita.
    """
    from strands import tool

    def run(name: str, args: dict[str, Any]) -> str:
        if deadline is not None and time.monotonic() > deadline:
            log.warning("tool_skipped_budget tool=%s", name)
            result: dict[str, Any] = {"ok": False, "error": "turn_budget_exceeded", "code": "TIMEOUT"}
            records.append((name, result))
            return json.dumps(_compact(name, result))
        try:
            result = client.call(name, args)
        except Exception as err:  # noqa: BLE001
            log.warning("tool_failed tool=%s error=%s", name, type(err).__name__)
            result = {"ok": False, "error": "tool_unavailable", "code": "UPSTREAM"}
        records.append((name, result))
        return json.dumps(_compact(name, result))

    @tool
    def search_providers(procedure: str, city: str, limit: int = 5) -> str:
        """Find verified providers (synthetic data) for a procedure in a city, best rated first. Up to 5.

        Args:
            procedure: Procedure in English, lowercase (e.g. rhinoplasty, botox, fillers).
            city: City name (e.g. Miami).
            limit: Max results, 1 to 5.
        """
        return run("search_providers", {"procedure": procedure.strip().lower(), "city": city.strip(), "limit": limit})

    @tool
    def get_availability(providerId: str, fromDate: str | None = None, limit: int = 4) -> str:
        """List the next free consultation slots of a provider. Up to 4.

        Args:
            providerId: Provider ID returned by search_providers or received in a postback.
            fromDate: Optional ISO 8601 date to search from.
            limit: Max slots, 1 to 4.
        """
        return run("get_availability", {"providerId": providerId, "fromDate": fromDate, "limit": limit})

    @tool
    def book_appointment(providerId: str, slotId: str, procedure: str | None = None) -> str:
        """Book a consultation slot for this patient and schedule the 48 h and 24 h reminders.

        Args:
            providerId: Provider ID.
            slotId: Slot ID returned by get_availability or received in a postback.
            procedure: Procedure of the consultation, if known.
        """
        return run("book_appointment", {"providerId": providerId, "slotId": slotId, "patientRef": patient_ref, "procedure": procedure})

    @tool
    def reschedule_appointment(appointmentId: str, newSlotId: str) -> str:
        """Move an existing appointment of this patient to another slot of the same provider.

        Args:
            appointmentId: Appointment ID.
            newSlotId: New slot ID returned by get_availability.
        """
        return run("reschedule_appointment", {"appointmentId": appointmentId, "newSlotId": newSlotId, "patientRef": patient_ref})

    @tool
    def cancel_appointment(appointmentId: str) -> str:
        """Cancel an appointment of this patient, free the slot and delete pending reminders.

        Args:
            appointmentId: Appointment ID.
        """
        return run("cancel_appointment", {"appointmentId": appointmentId, "patientRef": patient_ref})

    return [search_providers, get_availability, book_appointment, reschedule_appointment, cancel_appointment]


# ---------- Memory ----------


def make_session_manager(memory_id: str, session_id: str, actor_id: str, region: str):
    """AgentCore Memory (memoria de corto plazo de la sesion) con redaccion antes de cada escritura."""
    from bedrock_agentcore.memory.integrations.strands.config import AgentCoreMemoryConfig
    from bedrock_agentcore.memory.integrations.strands.session_manager import AgentCoreMemorySessionManager

    class RedactingSessionManager(AgentCoreMemorySessionManager):
        def append_message(self, message, agent, **kwargs):  # type: ignore[override]
            super().append_message(redact_message(message), agent, **kwargs)

    config = AgentCoreMemoryConfig(memory_id=memory_id, session_id=session_id, actor_id=actor_id)
    return RedactingSessionManager(agentcore_memory_config=config, region_name=region)


# ---------- Backend ----------


# Claves de postback que el modelo puede ver (docs/contrato-eventos.md); el resto se descarta.
POSTBACK_KEYS = ("a", "p", "s", "ap")
_POSTBACK_VALUE = re.compile(r"^[A-Za-z0-9_.:#+-]{1,96}$")  # slotId = <providerId>#<ISO>
# Marcadores que pone pii.redact: se conservan. Cualquier otro [..] se neutraliza.
_REDACTION_MARKER = re.compile(r"\[(EMAIL|PHONE|CARD|SSN|DOB|ADDRESS|NAME)\]")


def sanitize_patient_text(text: str) -> str:
    """Una sola linea y sin delimitadores: el paciente no puede fabricar `[postback]` ni `[context]`."""
    flat = " ".join((text or "").split())
    parts = _REDACTION_MARKER.split(flat)
    # split con un grupo de captura alterna texto / nombre del marcador.
    out = []
    for i, part in enumerate(parts):
        out.append(f"[{part}]" if i % 2 else part.replace("[", "(").replace("]", ")"))
    return "".join(out)


def sanitize_postback(action: dict[str, str]) -> dict[str, str]:
    """Lista blanca de claves y valores con forma de ID (sin espacios, saltos ni corchetes)."""
    return {k: action[k] for k in POSTBACK_KEYS if isinstance(action.get(k), str) and _POSTBACK_VALUE.match(action[k])}


def user_message(turn: Turn) -> str:
    """Lo que ve el modelo en cada turno. Sin telefono ni patientRef."""
    head = f"[context] channel={turn.channel} reply_language={'Spanish' if turn.lang == 'es' else 'English'}"
    if turn.action:
        a = sanitize_postback(turn.action)
        params = " ".join(f"{k}={v}" for k, v in a.items())
        hints = {
            "select_provider": "the patient tapped See availability on this provider",
            "select_slot": "the patient tapped this time slot",
            "confirm": "the patient confirmed the appointment from a reminder",
            "reschedule": "the patient wants to reschedule this appointment",
            "cancel": "the patient wants to cancel this appointment",
        }
        return f"{head}\n[postback] {params} ({hints.get(a.get('a', ''), 'button tap')})"
    return f"{head}\n[patient] {sanitize_patient_text(turn.text)}"


def parse_final(text: str) -> dict[str, Any]:
    """El prompt pide un JSON {text, suggestions, clinicalHandoff}; si no vino, se usa el texto plano."""
    match = re.search(r"\{.*\}", text or "", re.S)
    if match:
        try:
            data = json.loads(match.group(0))
            if isinstance(data, dict) and isinstance(data.get("text"), str):
                return data
        except json.JSONDecodeError:
            pass
    return {"text": (text or "").strip()}


class StrandsBackend:
    def __init__(
        self,
        tools: ToolClient,
        prompt: str,
        config: ModelConfig,
        memory_id: str | None = None,
        model_factory: Callable[[], Any] | None = None,
    ) -> None:
        self.tools = tools
        self.prompt = prompt
        self.config = config
        self.memory_id = memory_id
        self._model_factory = model_factory or self._bedrock_model
        self._model = None

    def _bedrock_model(self):
        from botocore.config import Config
        from strands.models import BedrockModel

        return BedrockModel(
            model_id=self.config.model_id,
            region_name=self.config.region,
            temperature=self.config.temperature,
            max_tokens=self.config.max_tokens,
            boto_client_config=Config(
                connect_timeout=self.config.connect_timeout_s,
                read_timeout=self.config.read_timeout_s,
                retries={"total_max_attempts": self.config.max_model_attempts, "mode": "standard"},
            ),
        )

    def _retry_strategy(self):
        """Strands reintenta el throttling por su cuenta (default: 6 intentos, hasta 240 s); se acota."""
        from strands import ModelRetryStrategy

        return ModelRetryStrategy(max_attempts=self.config.max_model_attempts, initial_delay=1, max_delay=2)

    def _system_prompt(self) -> Any:
        # Prompt caching de Bedrock: cachePoint al final del system prompt (prefijo estatico).
        # Bedrock solo cachea desde ~1024 tokens en Sonnet; por debajo lo ignora sin error (VERIFICAR).
        if self.config.prompt_cache:
            return [{"text": self.prompt}, {"cachePoint": {"type": "default"}}]
        return self.prompt

    def respond(self, turn: Turn, records: list[tuple[str, dict[str, Any]]] | None = None) -> AgentReply:
        """`records` (opcional) lo pasa el Concierge: aca se anota cada tool que corrio, aunque
        el modelo falle despues. Asi el fallback sabe si ya hubo una reserva."""
        from strands import Agent

        self._model = self._model or self._model_factory()
        records = records if records is not None else []
        deadline = time.monotonic() + self.config.turn_budget_s
        session_manager = (
            make_session_manager(self.memory_id, turn.session_id, turn.patient_ref, self.config.region) if self.memory_id else None
        )
        timer: threading.Timer | None = None
        try:
            agent = Agent(
                model=self._model,
                system_prompt=self._system_prompt(),
                tools=build_tools(self.tools, turn.patient_ref, records, deadline),
                session_manager=session_manager,
                callback_handler=None,
                retry_strategy=self._retry_strategy(),
            )
            # Al agotar el presupuesto se cancela el agente: corta el streaming del modelo y no
            # arranca tools nuevas. Una tool en curso (funcion sync en asyncio.to_thread) termina
            # y queda anotada en records, asi que una reserva nunca queda a mitad sin registro.
            timer = threading.Timer(self.config.turn_budget_s, agent.cancel)
            timer.daemon = True
            timer.start()
            result = agent(user_message(turn))
        finally:
            if timer is not None:
                timer.cancel()
            if session_manager is not None and hasattr(session_manager, "close"):
                session_manager.close()

        final = parse_final(str(result))
        rich: list[ReplyBlock] = blocks_from_records(records)
        text = clean_text(final.get("text")) or ("Here you go:" if turn.lang != "es" else "Aquí tienes:")
        # Si hay slots, las respuestas sugeridas son los slots: no se mezclan con las del modelo.
        suggestions = [] if any(b["type"] == "slot_options" for b in rich) else clean_suggestions(final.get("suggestions"))
        log.info("turn_done tools=%s blocks=%s", [n for n, _ in records], [b["type"] for b in rich])
        return make_reply(turn.session_id, [text_block(text, suggestions)] + rich, bool(final.get("clinicalHandoff")))
