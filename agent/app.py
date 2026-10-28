"""Agente concierge (owner: Agustin): AgentCore Runtime + Strands.

Modos (variable AGENT_MODE):
- "local" (default fuera de AWS): flujo determinista con tools en memoria. Sin AWS ni modelo.
- "bedrock-local": Strands + Bedrock con tools en memoria, sin Gateway ni Memory.
  Necesita credenciales de AWS con acceso al modelo (no despliega nada).
- "aws" (lo setea el Runtime): Strands + Bedrock + tools del AgentCore Gateway (MCP, SigV4)
  + AgentCore Memory. Si el modelo o Memory fallan, cae al flujo determinista con las
  mismas tools del Gateway.

Contrato de entrada y salida: docs/contrato-eventos.md (secciones 5 y 6).

Uso local:
    python3 agent/app.py --local "I want rhinoplasty in Miami"
    python3 agent/app.py --local "postback:a=select_provider&p=prov_miami_01"
    python3 agent/app.py --local --chat        # conversacion de varios turnos (stdin)
    python3 agent/app.py --local --bedrock "..."   # modelo real con tools locales (pide credenciales)
"""
from __future__ import annotations

import json
import logging
import os
import sys
import threading
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))

from blocks import clean_text, text_reply, validate_reply  # noqa: E402
from contracts import AgentInvokeRequest, AgentReply  # noqa: E402
from flow import DeterministicFlow, SessionStore, Turn, turn_from_request  # noqa: E402
from guardrails import detect_language, handoff_message, is_clinical, output_looks_clinical  # noqa: E402
from pii import redact  # noqa: E402
from tool_client import GatewayToolClient, LocalToolClient, ToolClient  # noqa: E402

PROMPT = (Path(__file__).parent / "prompt.md").read_text(encoding="utf-8")

# Tope del turno completo (modelo + fallback determinista), medido desde que llega el request.
# El router invoca AgentCore con timeout de 75 s (Lambda de 90 s, PR #3): 65 s deja margen para
# el arranque de una sesion MCP del Gateway (GATEWAY_STARTUP_TIMEOUT_S) y la vuelta al router.
TURN_DEADLINE_S = float(os.environ.get("TURN_DEADLINE_S", "65"))

# Postbacks que ya traen todo lo necesario: van directo al flujo determinista, sin modelo.
# Menos latencia y costo, y el modelo queda fuera del camino de escritura (review de Lucas).
DIRECT_ACTIONS = frozenset({"select_slot", "cancel", "confirm"})

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(levelname)s %(name)s %(message)s")
log = logging.getLogger("concierge")


class Concierge:
    """Arma el turno, aplica guardrails y delega en el backend (modelo o flujo determinista)."""

    def __init__(self, tools: ToolClient, model_backend: Any | None = None) -> None:
        self.sessions = SessionStore()
        self.flow = DeterministicFlow(tools, self.sessions)
        self.model_backend = model_backend

    def respond(self, payload: dict[str, Any]) -> AgentReply:
        started = time.monotonic()
        deadline = started + TURN_DEADLINE_S
        session_id = str(payload.get("sessionId", ""))
        problems = validate_request(payload)
        if problems:
            log.warning("invalid_request session=%s problems=%s", _short(session_id), problems)
            safe_id = session_id if len(session_id) >= 33 else "rs-sess-invalid".ljust(33, "0")
            return text_reply(safe_id, "Sorry, something went wrong on my side. Please try again.")

        request: AgentInvokeRequest = payload  # type: ignore[assignment]
        state = self.sessions.peek(session_id)
        turn = turn_from_request(request, "en", redact)
        turn.lang = detect_language(turn.text, request.get("locale", "en-US"), state.lang if state else None)
        lang = turn.lang
        self.sessions.get(session_id).lang = lang

        path = "flow"
        # Tools que ya corrio el modelo en este turno (las anota el backend aunque despues falle).
        records: list[tuple[str, dict[str, Any]]] = []
        if turn.text and is_clinical(turn.text):
            path = "guardrail"
            reply = text_reply(session_id, handoff_message(turn.text, lang), clinical_handoff=True)
        elif is_direct_action(turn):
            path = "flow_direct"
            reply = self.flow.respond(turn, deadline)
        elif self.model_backend is not None:
            try:
                reply = self.model_backend.respond(turn, records)
                path = "model"
            except Exception as err:  # noqa: BLE001 - la demo no se puede quedar muda
                path = "model_failed"
                log.warning("model_failed session=%s error=%s tools=%d", _short(session_id), type(err).__name__, len(records))
                reply = self._fallback(turn, records, deadline)
        else:
            reply = self.flow.respond(turn, deadline)

        reply = enforce_output_guard(reply, turn)
        errors = validate_reply(reply)
        if errors:
            log.warning("invalid_reply session=%s errors=%s tools=%d", _short(session_id), errors, len(records))
            reply = self._fallback(turn, records, deadline)
        log.info(
            "turn session=%s path=%s input=%s blocks=%s handoff=%s ms=%d",
            _short(session_id),
            path,
            "postback:" + turn.action.get("a", "") if turn.action else "text",
            [b["type"] for b in reply["blocks"]],
            bool(reply.get("clinicalHandoff")),
            (time.monotonic() - started) * 1000,
        )
        return reply

    def _fallback(self, turn: Turn, records: list[tuple[str, dict[str, Any]]], deadline: float | None = None) -> AgentReply:
        """Si el modelo ya reservo, cambio o cancelo, se responde con eso; si una escritura quedo
        incierta (UPSTREAM o INTERNAL), "no pude confirmar"; si no, flujo determinista."""
        recovered = self.flow.reply_from_records(turn, records)
        if recovered is not None:
            log.info("fallback=records session=%s", _short(turn.session_id))
            return recovered
        return self.flow.respond(turn, deadline)


def is_direct_action(turn: Turn) -> bool:
    """select_slot, cancel y confirm, y reschedule con `ap`: no necesitan al modelo."""
    if not turn.action:
        return False
    a = turn.action.get("a")
    return a in DIRECT_ACTIONS or (a == "reschedule" and bool(turn.action.get("ap")))


def validate_request(payload: dict[str, Any]) -> list[str]:
    problems = []
    if payload.get("version") != "1":
        problems.append("version")
    if not isinstance(payload.get("sessionId"), str) or len(payload["sessionId"]) < 33:
        problems.append("sessionId")
    if not isinstance(payload.get("patientRef"), str) or not payload["patientRef"]:
        problems.append("patientRef")
    if payload.get("channel") not in ("RCS", "SMS"):
        problems.append("channel")
    inp = payload.get("input")
    if not isinstance(inp, dict) or inp.get("type") not in ("text", "postback"):
        problems.append("input")
    elif inp["type"] == "postback" and not isinstance(inp.get("postbackData"), str):
        problems.append("input.postbackData")
    elif inp["type"] == "text" and not isinstance(inp.get("text"), str):
        problems.append("input.text")
    return problems


def enforce_output_guard(reply: AgentReply, turn: Turn) -> AgentReply:
    """Si el texto del modelo suena a indicacion clinica, se reemplaza por la derivacion."""
    for block in reply["blocks"]:
        if block["type"] == "text" and output_looks_clinical(block["text"]):
            block["text"] = clean_text(handoff_message(turn.text, turn.lang))
            block.pop("suggestions", None)
            reply["clinicalHandoff"] = True
    return reply


def _short(session_id: str) -> str:
    return session_id[:16]


# ---------- Wiring ----------


def make_concierge(mode: str | None = None) -> Concierge:
    mode = mode or os.environ.get("AGENT_MODE", "local")
    if mode == "local":
        return Concierge(LocalToolClient())

    from strands_backend import ModelConfig, StrandsBackend

    config = ModelConfig.from_env()
    if mode == "bedrock-local":
        tools: ToolClient = LocalToolClient()
        return Concierge(tools, StrandsBackend(tools, PROMPT, config))
    if mode == "aws":
        tools = GatewayToolClient(
            gateway_url=os.environ["GATEWAY_URL"],
            region=config.region,
            target_name=os.environ.get("GATEWAY_TARGET_NAME", "tools"),
        )
        memory_id = os.environ.get("MEMORY_ID") or None
        return Concierge(tools, StrandsBackend(tools, PROMPT, config, memory_id=memory_id))
    raise ValueError(f"AGENT_MODE desconocido: {mode}")


_concierge: Concierge | None = None
_concierge_lock = threading.Lock()


def get_concierge() -> Concierge:
    """Singleton por proceso. Lock para que dos invocaciones concurrentes no armen dos clientes."""
    global _concierge
    if _concierge is None:
        with _concierge_lock:
            if _concierge is None:
                _concierge = make_concierge()
    return _concierge


def invoke(payload: dict[str, Any], context: Any = None) -> AgentReply:
    """Entrypoint de AgentCore Runtime: recibe AgentInvokeRequest y devuelve AgentReply."""
    return get_concierge().respond(payload)


def reset() -> None:
    """Para tests: descarta el estado en memoria."""
    global _concierge
    with _concierge_lock:
        _concierge = None


def _local_request(message: str, session: str = "0" * 64) -> AgentInvokeRequest:
    is_postback = message.startswith("postback:")
    return {
        "version": "1",
        "sessionId": "rs-sess-" + session,
        "patientRef": session,
        "channel": "RCS",
        "input": {"type": "postback", "postbackData": message[len("postback:"):]} if is_postback else {"type": "text", "text": message},
        "receivedAt": "2026-10-26T12:00:00Z",
        "locale": "en-US",
    }


def _cli(argv: list[str]) -> None:
    if "--bedrock" in argv:
        os.environ["AGENT_MODE"] = "bedrock-local"
    else:
        os.environ.setdefault("AGENT_MODE", "local")
    args = [a for a in argv if not a.startswith("--")]
    if "--chat" in argv:
        print("Concierge local. Escribi un mensaje, 'postback:a=...' para simular un boton, o 'exit'.")
        while True:
            try:
                line = input("> ").strip()
            except EOFError:
                break
            if line in ("exit", "quit"):
                break
            print(json.dumps(invoke(_local_request(line)), indent=2, ensure_ascii=False))
        return
    message = " ".join(args) or "hi"
    print(json.dumps(invoke(_local_request(message)), indent=2, ensure_ascii=False))


if __name__ == "__main__" and "--local" in sys.argv:
    _cli(sys.argv[1:])
else:
    try:
        from bedrock_agentcore.runtime import BedrockAgentCoreApp

        app = BedrockAgentCoreApp()
        app.entrypoint(invoke)
        if __name__ == "__main__":
            app.run()
    except ImportError:
        app = None  # modo local o tests sin bedrock-agentcore instalado
