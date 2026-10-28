"""Clientes de tools sin red: parseo del Gateway (MCP), GatewayToolClient con un MCP falso y firma SigV4."""
from __future__ import annotations

import json
import logging
from datetime import timedelta

import pytest

from tool_client import GatewayToolClient, LocalToolClient, parse_mcp_result


def test_parse_mcp_result_texto_json():
    payload = {"ok": True, "providers": []}
    result = {"status": "success", "toolUseId": "t", "content": [{"text": json.dumps(payload)}]}
    assert parse_mcp_result(result) == payload


def test_parse_mcp_result_structured_y_body_anidado():
    assert parse_mcp_result({"structuredContent": {"ok": False, "code": "SLOT_TAKEN"}})["code"] == "SLOT_TAKEN"
    nested = {"content": [{"text": json.dumps({"statusCode": 200, "body": json.dumps({"ok": True, "slots": []})})}]}
    assert parse_mcp_result(nested) == {"ok": True, "slots": []}


def test_parse_mcp_result_error_sin_payload():
    out = parse_mcp_result({"status": "error", "content": [{"text": "boom"}]})
    assert out["ok"] is False and out["code"] == "UPSTREAM"


def test_local_tool_client_rechaza_tools_desconocidas():
    client = LocalToolClient()
    assert client.call("drop_tables", {})["code"] == "BAD_REQUEST"
    assert client.call("search_providers", {"unexpected": 1})["code"] == "BAD_REQUEST"


# ---------- GatewayToolClient con un cliente MCP falso ----------

OK = {"content": [{"text": json.dumps({"ok": True, "slots": []})}]}
REF = "a" * 64


class FakeMCP:
    def __init__(self, behaviors: list, stop_error: Exception | None = None) -> None:
        self.behaviors = behaviors
        self.calls: list[tuple[str, dict, timedelta | None]] = []
        self.stopped = False
        self.stop_error = stop_error

    def call_tool_sync(self, tool_use_id, name, arguments=None, read_timeout_seconds=None):
        self.calls.append((name, arguments, read_timeout_seconds))
        behavior = self.behaviors.pop(0)
        if isinstance(behavior, Exception):
            raise behavior
        return behavior

    def stop(self, *args):
        self.stopped = True
        if self.stop_error:
            raise self.stop_error


def _gateway(clients: list) -> tuple[GatewayToolClient, list]:
    """GatewayToolClient cuyo _new_client entrega los fakes en orden (o lanza si el item es una excepcion)."""
    gw = GatewayToolClient("https://gw.example.invalid/mcp", "us-east-1", read_timeout_s=7)
    created: list = []

    def new_client():
        item = clients.pop(0)
        if isinstance(item, Exception):
            raise item
        created.append(item)
        return item

    gw._new_client = new_client  # type: ignore[method-assign]
    return gw, created


def test_gateway_lectura_reintenta_con_cliente_nuevo():
    first, second = FakeMCP([TimeoutError("read")]), FakeMCP([OK])
    gw, created = _gateway([first, second])
    out = gw.call("get_availability", {"providerId": "prov_miami_01", "fromDate": None})
    assert out == {"ok": True, "slots": []}
    assert created == [first, second] and first.stopped
    name, args, timeout = second.calls[0]
    assert name == "tools___get_availability"
    assert args == {"providerId": "prov_miami_01"}  # los None no viajan
    assert timeout == timedelta(seconds=7)


@pytest.mark.parametrize("tool", ["book_appointment", "reschedule_appointment", "cancel_appointment"])
def test_gateway_escritura_no_se_reintenta_si_la_llamada_salio(tool):
    first, second = FakeMCP([TimeoutError("read")]), FakeMCP([OK])
    gw, _ = _gateway([first, second])
    out = gw.call(tool, {"appointmentId": "apt_1", "patientRef": REF})
    assert out["ok"] is False and out["code"] == "UPSTREAM"
    assert len(first.calls) == 1 and second.calls == []
    assert first.stopped  # se descarto el cliente: la proxima llamada reconecta


def test_gateway_escritura_reintenta_si_fallo_la_conexion():
    client = FakeMCP([{"structuredContent": {"ok": True, "appointment": {}}}])
    gw, _ = _gateway([ConnectionError("handshake"), client])
    out = gw.call("book_appointment", {"providerId": "p", "slotId": "s", "patientRef": REF})
    assert out["ok"] is True
    assert len(client.calls) == 1


def test_gateway_reconecta_en_la_llamada_siguiente():
    first, second = FakeMCP([TimeoutError("read")]), FakeMCP([OK])
    gw, created = _gateway([first, second])
    assert gw.call("cancel_appointment", {"appointmentId": "apt_1", "patientRef": REF})["code"] == "UPSTREAM"
    assert gw.call("search_providers", {"procedure": "botox", "city": "Miami"})["ok"] is True
    assert created == [first, second]


def test_gateway_lectura_falla_dos_veces_devuelve_upstream():
    gw, _ = _gateway([FakeMCP([RuntimeError("a")]), FakeMCP([RuntimeError("b")])])
    out = gw.call("search_providers", {"procedure": "botox", "city": "Miami"})
    assert out == {"ok": False, "error": "Gateway no disponible", "code": "UPSTREAM"}


def test_gateway_rechaza_tools_desconocidas_sin_conectar():
    gw, created = _gateway([])
    assert gw.call("drop_tables", {})["code"] == "BAD_REQUEST"
    assert created == []


def test_gateway_reset_loguea_el_error_al_cerrar(caplog):
    gw, _ = _gateway([FakeMCP([RuntimeError("x")], stop_error=OSError("closed")), FakeMCP([OK])])
    with caplog.at_level(logging.DEBUG, logger="concierge.tools"):
        gw.call("search_providers", {"procedure": "botox", "city": "Miami"})
    assert any("gateway_client_stop_failed" in r.getMessage() and "OSError" in r.getMessage() for r in caplog.records)


# ---------- SigV4HttpxAuth (firma local con credenciales falsas) ----------


def _signed(token: str | None):
    boto3 = pytest.importorskip("boto3")
    httpx = pytest.importorskip("httpx")
    from gateway_auth import SigV4HttpxAuth

    auth = SigV4HttpxAuth(service="bedrock-agentcore", region="us-east-1")
    auth.session = boto3.Session(
        aws_access_key_id="test-key-id", aws_secret_access_key="test-secret", aws_session_token=token, region_name="us-east-1"
    )
    request = httpx.Request(
        "POST", "https://gw.example.invalid/mcp", content=b'{"jsonrpc":"2.0"}', headers={"content-type": "application/json"}
    )
    return next(auth.auth_flow(request))


def test_sigv4_agrega_authorization_fecha_y_token():
    signed = _signed("test-session-token")
    authz = signed.headers["Authorization"]
    assert authz.startswith("AWS4-HMAC-SHA256 Credential=test-key-id/")
    assert "/us-east-1/bedrock-agentcore/aws4_request" in authz
    assert "SignedHeaders=" in authz and "Signature=" in authz
    assert len(signed.headers["X-Amz-Date"]) == 16  # formato 20261022T120000Z
    assert signed.headers["X-Amz-Security-Token"] == "test-session-token"


def test_sigv4_sin_token_de_sesion_no_agrega_el_header():
    signed = _signed(None)
    assert "Authorization" in signed.headers
    assert "X-Amz-Security-Token" not in signed.headers
