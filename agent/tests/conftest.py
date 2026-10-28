from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any

import pytest

os.environ["AGENT_MODE"] = "local"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tool_client import LocalToolClient  # noqa: E402

REF = "a" * 64
SESSION = "rs-sess-" + REF


class SpyTools:
    """LocalToolClient que registra cada llamada (nombre y argumentos)."""

    def __init__(self) -> None:
        self.inner = LocalToolClient()
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def call(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        self.calls.append((name, dict(args)))
        return self.inner.call(name, args)

    def names(self) -> list[str]:
        return [n for n, _ in self.calls]


def make_request(inp: dict[str, Any], channel: str = "RCS", locale: str = "en-US", ref: str = REF) -> dict[str, Any]:
    return {
        "version": "1",
        "sessionId": "rs-sess-" + ref,
        "patientRef": ref,
        "channel": channel,
        "input": inp,
        "receivedAt": "2026-10-26T12:00:00Z",
        "locale": locale,
    }


def text(t: str, **kw: Any) -> dict[str, Any]:
    return make_request({"type": "text", "text": t}, **kw)


def postback(data: str, **kw: Any) -> dict[str, Any]:
    return make_request({"type": "postback", "postbackData": data}, **kw)


@pytest.fixture
def spy() -> SpyTools:
    return SpyTools()


@pytest.fixture
def concierge(spy: SpyTools):
    import app

    return app.Concierge(spy)
