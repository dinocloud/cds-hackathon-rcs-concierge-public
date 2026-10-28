"""Clientes de tools del concierge (owner: Agustin).

- `LocalToolClient`: tools en memoria (agent/local_tools.py), para --local y tests.
- `GatewayToolClient`: AgentCore Gateway por MCP (streamable HTTP) firmado con SigV4,
  credenciales del rol del Runtime (cadena por defecto de boto3), nunca del repo.

Los dos devuelven el mismo `{ok: true, ...} | {ok: false, error, code}` que la Lambda tools
(lambdas/tools/schema.ts es la fuente de verdad de nombres y parametros).
"""
from __future__ import annotations

import json
import logging
import os
import threading
import uuid
from datetime import timedelta
from typing import Any, Protocol

log = logging.getLogger("concierge.tools")

TOOL_NAMES = (
    "search_providers",
    "get_availability",
    "book_appointment",
    "reschedule_appointment",
    "cancel_appointment",
)
# Solo las de lectura se reintentan. Las de escritura no: un timeout que llega despues de que
# la Lambda ya reservo repetiria la accion (la Lambda no tiene idempotency key todavia).
READ_TOOLS = frozenset({"search_providers", "get_availability"})
WRITE_TOOLS = frozenset(TOOL_NAMES) - READ_TOOLS

# Presupuesto de tiempo: el router invoca AgentCore con timeout de 75 s (PR #3) y el turno
# completo se corta en TURN_DEADLINE_S (app.py). El fallback reserva TOOL_READ_TIMEOUT_S por tool.
TOOL_READ_TIMEOUT_S = float(os.environ.get("TOOL_READ_TIMEOUT_S", "10"))
GATEWAY_STARTUP_TIMEOUT_S = int(os.environ.get("GATEWAY_STARTUP_TIMEOUT_S", "10"))


class ToolClient(Protocol):
    def call(self, name: str, args: dict[str, Any]) -> dict[str, Any]: ...


class LocalToolClient:
    def __init__(self, tools: Any | None = None) -> None:
        from local_tools import LocalTools

        self.tools = tools or LocalTools()

    def call(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        if name not in TOOL_NAMES:
            return {"ok": False, "error": f"Tool desconocida: {name}", "code": "BAD_REQUEST"}
        clean = {k: v for k, v in args.items() if v is not None}
        return self.tools.call(name, clean)


def parse_mcp_result(result: Any) -> dict[str, Any]:
    """MCPToolResult de Strands -> dict de la Lambda. El Gateway envuelve el JSON en content[].text."""
    if not isinstance(result, dict):
        return {"ok": False, "error": "Respuesta invalida del Gateway", "code": "UPSTREAM"}
    structured = result.get("structuredContent")
    if isinstance(structured, dict) and "ok" in structured:
        return structured
    for part in result.get("content") or []:
        text = part.get("text") if isinstance(part, dict) else None
        if not text:
            continue
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            continue
        # Algunas versiones del Gateway anidan el payload de la Lambda en {"body": ...} (VERIFICAR).
        if isinstance(payload, dict) and "ok" not in payload and isinstance(payload.get("body"), (str, dict)):
            body = payload["body"]
            payload = json.loads(body) if isinstance(body, str) else body
        if isinstance(payload, dict):
            return payload
    if result.get("status") == "error":
        return {"ok": False, "error": "Error del Gateway", "code": "UPSTREAM"}
    return {"ok": False, "error": "Respuesta vacia del Gateway", "code": "UPSTREAM"}


class GatewayToolClient:
    """MCP client de larga vida contra el Gateway.

    Si una llamada falla se descarta el cliente (la proxima reconecta). Reintentos:
    - Tools de lectura: un reintento con un cliente nuevo.
    - Tools de escritura: solo si fallo la conexion, antes de mandar la llamada. Si la llamada
      ya salio, el resultado es incierto y se devuelve UPSTREAM sin repetirla.
    """

    def __init__(
        self,
        gateway_url: str,
        region: str,
        target_name: str = "tools",
        read_timeout_s: float = TOOL_READ_TIMEOUT_S,
    ) -> None:
        self.gateway_url = gateway_url
        self.region = region
        self.target_name = target_name
        self.read_timeout = timedelta(seconds=read_timeout_s)
        self._client = None
        self._lock = threading.Lock()

    def _new_client(self):
        from mcp.client.streamable_http import streamablehttp_client
        from strands.tools.mcp import MCPClient

        from gateway_auth import SigV4HttpxAuth

        auth = SigV4HttpxAuth(service="bedrock-agentcore", region=self.region)
        client = MCPClient(
            lambda: streamablehttp_client(self.gateway_url, auth=auth, timeout=self.read_timeout.total_seconds()),
            startup_timeout=GATEWAY_STARTUP_TIMEOUT_S,
        )
        client.start()
        return client

    def _ensure(self):
        with self._lock:
            if self._client is None:
                self._client = self._new_client()
            return self._client

    def _reset(self) -> None:
        with self._lock:
            if self._client is not None:
                try:
                    self._client.stop(None, None, None)
                except Exception as err:  # noqa: BLE001 - cerrar es best effort
                    log.debug("gateway_client_stop_failed error=%s", type(err).__name__)
            self._client = None

    def call(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        if name not in TOOL_NAMES:
            return {"ok": False, "error": f"Tool desconocida: {name}", "code": "BAD_REQUEST"}
        clean = {k: v for k, v in args.items() if v is not None}
        full_name = f"{self.target_name}___{name}"
        retry_after_send = name in READ_TOOLS
        for attempt in (1, 2):
            try:
                client = self._ensure()
            except Exception as err:  # noqa: BLE001 - no se mando nada: se puede reintentar siempre
                log.warning("gateway_connect_failed tool=%s attempt=%d error=%s", name, attempt, type(err).__name__)
                self._reset()
                continue
            try:
                result = client.call_tool_sync(
                    f"tu_{uuid.uuid4().hex[:12]}", full_name, clean, read_timeout_seconds=self.read_timeout
                )
                return parse_mcp_result(result)
            except Exception as err:  # noqa: BLE001 - se loguea sin argumentos (pueden traer patientRef)
                log.warning("gateway_call_failed tool=%s attempt=%d error=%s", name, attempt, type(err).__name__)
                self._reset()
                if not retry_after_send:
                    return {"ok": False, "error": "Resultado incierto del Gateway", "code": "UPSTREAM"}
        return {"ok": False, "error": "Gateway no disponible", "code": "UPSTREAM"}
