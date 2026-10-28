"""StrandsBackend con un modelo guionado (sin Bedrock, sin AWS) y tools locales.

Corre solo si strands-agents esta instalado (pip install -r agent/requirements.txt);
si no, se saltea. Verifica el cableado real de Strands: tools, inyeccion de patientRef,
bloques a partir de resultados de tools y parseo del JSON final.
"""
from __future__ import annotations

import json
from typing import Any
from urllib.parse import urlencode

import pytest

strands = pytest.importorskip("strands")

from strands.models import Model  # noqa: E402

import app  # noqa: E402
from blocks import validate_reply  # noqa: E402
from conftest import REF, postback, text  # noqa: E402
from strands_backend import ModelConfig, StrandsBackend, parse_final, user_message  # noqa: E402


def _last_tool_result(messages: list[dict[str, Any]]) -> dict[str, Any]:
    for msg in reversed(messages):
        for part in msg.get("content", []):
            if "toolResult" in part:
                return json.loads(part["toolResult"]["content"][0]["text"])
    raise AssertionError("no hay toolResult")


class ScriptedModel(Model):
    """Cada paso: ("tool", name, input | fn(messages) -> input) o ("text", str)."""

    def __init__(self, script: list[tuple]) -> None:
        self.script = list(script)
        self.seen_system: list[Any] = []
        self.config: dict[str, Any] = {}

    def update_config(self, **model_config: Any) -> None:
        self.config.update(model_config)

    def get_config(self) -> Any:
        return self.config

    async def structured_output(self, output_model, prompt, system_prompt=None, **kwargs):  # pragma: no cover
        raise NotImplementedError
        yield  # noqa

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        self.seen_system.append(kwargs.get("system_prompt_content") or system_prompt)
        step = self.script.pop(0)
        if step[0] == "raise":
            raise step[1]
        yield {"messageStart": {"role": "assistant"}}
        if step[0] == "tool":
            _, name, args = step
            args = args(messages) if callable(args) else args
            yield {"contentBlockStart": {"start": {"toolUse": {"toolUseId": f"tu-{len(self.script)}", "name": name}}}}
            yield {"contentBlockDelta": {"delta": {"toolUse": {"input": json.dumps(args)}}}}
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "tool_use"}}
        else:
            yield {"contentBlockStart": {"start": {}}}
            yield {"contentBlockDelta": {"delta": {"text": step[1]}}}
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "end_turn"}}


def _concierge(spy, script):
    model = ScriptedModel(script)
    backend = StrandsBackend(spy, app.PROMPT, ModelConfig(model_id="test-model", region="us-east-1"), model_factory=lambda: model)
    return app.Concierge(spy, backend), model


def test_caso1_con_strands_y_modelo_guionado(spy):
    concierge, model = _concierge(
        spy,
        [
            ("tool", "search_providers", {"procedure": "rhinoplasty", "city": "Miami"}),
            ("text", '{"text": "Here are top verified providers near you:", "suggestions": [], "clinicalHandoff": false}'),
            ("tool", "get_availability", {"providerId": "prov_miami_02"}),
            ("text", '{"text": "Love that pick. Here are the next openings:"}'),
            ("tool", "book_appointment", lambda msgs: {"providerId": "prov_miami_02", "slotId": _last_slot(spy), "procedure": "rhinoplasty"}),
            ("text", '{"text": "You are booked!"}'),
        ],
    )

    reply = concierge.respond(text("I want rhinoplasty in Miami"))
    assert validate_reply(reply) == []
    assert [b["type"] for b in reply["blocks"]] == ["text", "provider_carousel"]
    assert reply["blocks"][0]["text"] == "Here are top verified providers near you:"

    reply = concierge.respond(postback(urlencode({"a": "select_provider", "p": "prov_miami_02"})))
    assert [b["type"] for b in reply["blocks"]] == ["text", "slot_options"]
    assert "suggestions" not in reply["blocks"][0]

    slot = reply["blocks"][1]["slots"][0]["slotId"]
    # select_slot va directo al flujo (sin modelo); el modelo reserva desde texto, como "1" por SMS.
    reply = concierge.respond(text("1"))
    assert validate_reply(reply) == []
    assert [b["type"] for b in reply["blocks"]] == ["text", "booking_confirmation"]
    assert reply["blocks"][1]["appointment"]["patientRef"] == REF

    # El modelo nunca manejo patientRef: lo inyecto el wrapper.
    name, args = spy.calls[-1]
    assert name == "book_appointment" and args["patientRef"] == REF
    # Prompt caching: cachePoint al final del system prompt.
    assert any(isinstance(s, list) and {"cachePoint": {"type": "default"}} in s for s in model.seen_system)


def _last_slot(spy) -> str:
    result = spy.inner.call("get_availability", {"providerId": "prov_miami_02"})
    return result["slots"][0]["slotId"]


def test_modelo_reserva_y_lanza_no_reserva_dos_veces(spy):
    """Review PR #4, punto 1: el modelo reserva, Bedrock falla en la llamada siguiente."""
    slot = _last_slot(spy)
    concierge, _ = _concierge(
        spy,
        [
            ("tool", "book_appointment", {"providerId": "prov_miami_02", "slotId": slot, "procedure": "rhinoplasty"}),
            ("raise", RuntimeError("bedrock throttled")),
        ],
    )
    # select_slot va directo al flujo (sin modelo); el modelo reserva desde texto, como "1" por SMS.
    reply = concierge.respond(text("1"))
    assert validate_reply(reply) == []
    assert spy.names().count("book_appointment") == 1
    assert [b["type"] for b in reply["blocks"]] == ["text", "booking_confirmation"]
    assert reply["blocks"][1]["appointment"]["slotId"] == slot
    assert "taken" not in reply["blocks"][0]["text"]


def test_modelo_reserva_recibe_upstream_y_lanza_no_reintenta(spy):
    """Segunda review PR #4: la reserva salio pero volvio UPSTREAM; el flujo no la repite."""
    slot = _last_slot(spy)

    class UpstreamOnBook:
        def call(self, name, args):
            if name == "book_appointment":
                spy.calls.append((name, dict(args)))
                return {"ok": False, "error": "Resultado incierto del Gateway", "code": "UPSTREAM"}
            return spy.call(name, args)

    tools = UpstreamOnBook()
    model = ScriptedModel(
        [
            ("tool", "book_appointment", {"providerId": "prov_miami_02", "slotId": slot}),
            ("raise", RuntimeError("bedrock throttled")),
        ]
    )
    backend = StrandsBackend(tools, app.PROMPT, ModelConfig(model_id="test-model", region="us-east-1"), model_factory=lambda: model)
    reply = app.Concierge(tools, backend).respond(text("1"))  # select_slot ya no pasa por el modelo
    assert validate_reply(reply) == []
    assert spy.names().count("book_appointment") == 1
    assert [b["type"] for b in reply["blocks"]] == ["text"]
    assert "couldn't confirm" in reply["blocks"][0]["text"]


def test_gateway_usa_el_read_timeout_de_la_instancia(monkeypatch):
    import mcp.client.streamable_http as streamable_http
    import strands.tools.mcp as strands_mcp

    from tool_client import GatewayToolClient

    seen: dict[str, Any] = {}

    class FakeClient:
        def __init__(self, transport, startup_timeout=None):
            self.transport = transport

        def start(self):
            self.transport()

    monkeypatch.setattr(streamable_http, "streamablehttp_client", lambda url, auth=None, timeout=None: seen.update(timeout=timeout))
    monkeypatch.setattr(strands_mcp, "MCPClient", FakeClient)
    GatewayToolClient("https://gw.example.invalid/mcp", "us-east-1", read_timeout_s=3)._new_client()
    assert seen["timeout"] == 3


def test_tools_no_arrancan_pasado_el_presupuesto(spy):
    from strands_backend import build_tools

    records: list = []
    tools = {t.tool_name: t for t in build_tools(spy, REF, records, deadline=0.0)}
    out = json.loads(tools["book_appointment"](providerId="prov_miami_02", slotId="x"))
    assert out == {"ok": False, "code": "TIMEOUT"}
    assert spy.calls == [] and records[0][1]["code"] == "TIMEOUT"


def test_bedrock_model_con_timeouts_y_reintentos_acotados():
    backend = StrandsBackend(None, "p", ModelConfig(model_id="us.anthropic.test", region="us-east-1"))
    model = backend._bedrock_model()  # crea el cliente boto3, sin llamadas de red
    cfg = model.client.meta.config
    assert cfg.connect_timeout == 3 and cfg.read_timeout == 15
    assert cfg.retries["total_max_attempts"] == 2  # incluye el intento inicial
    retry = backend._retry_strategy()
    assert retry._max_attempts == 2 and retry._max_delay <= 2
    # Peor caso: se cancela en turn_budget_s y queda en curso una lectura del modelo o una tool.
    from tool_client import TOOL_READ_TIMEOUT_S

    c = backend.config
    assert c.turn_budget_s + max(c.read_timeout_s, TOOL_READ_TIMEOUT_S) < 60


def test_tool_specs_no_exponen_patient_ref(spy):
    from strands_backend import build_tools

    for t in build_tools(spy, REF, []):
        props = t.tool_spec["inputSchema"]["json"]["properties"]
        assert "patientRef" not in props


def test_user_message_no_incluye_identidad():
    from flow import Turn

    msg = user_message(Turn("rs-sess-" + REF, REF, "RCS", "es", text="quiero botox en Miami"))
    assert REF not in msg
    assert "reply_language=Spanish" in msg


def test_parse_final_tolera_texto_plano():
    assert parse_final('{"text": "hi", "suggestions": ["a"]}')["suggestions"] == ["a"]
    assert parse_final("just text")["text"] == "just text"


def test_imports_de_aws_existen_en_las_versiones_instaladas():
    """Los imports perezosos de los modos aws no se ejecutan en local: se validan aca."""
    import inspect

    pytest.importorskip("bedrock_agentcore")
    from bedrock_agentcore.memory.integrations.strands.config import AgentCoreMemoryConfig
    from bedrock_agentcore.memory.integrations.strands.session_manager import AgentCoreMemorySessionManager
    from mcp.client.streamable_http import streamablehttp_client
    from strands.tools.mcp import MCPClient

    import gateway_auth

    assert "auth" in inspect.signature(streamablehttp_client).parameters
    assert hasattr(MCPClient, "call_tool_sync")
    assert hasattr(AgentCoreMemorySessionManager, "append_message")
    AgentCoreMemoryConfig(memory_id="m", session_id="rs-sess-" + REF, actor_id=REF)
    assert gateway_auth.SigV4HttpxAuth
