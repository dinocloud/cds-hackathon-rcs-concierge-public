"""Review de Lucas (PR #4): reprogramar en sesion nueva, postbacks directos y deadline del fallback."""
from __future__ import annotations

import time
from urllib.parse import urlencode

import app
from conftest import REF, postback, text
from flow import DeadlineToolClient
from test_smoke import _assert_valid, _block, _booked

PROVIDER = "prov_miami_02"
OTHER = "prov_miami_01"


def _book_in_first_session(spy, provider: str = PROVIDER) -> str:
    appointment_id, _ = _booked(app.Concierge(spy), provider)
    return appointment_id


# ---------- High: reprogramar desde el recordatorio en una sesion nueva ----------


def test_reprogramar_desde_el_recordatorio_en_una_sesion_nueva(spy):
    appointment_id = _book_in_first_session(spy)

    fresh = app.Concierge(spy)  # otra microVM: SessionStore vacio, mismas tools
    reply = fresh.respond(postback(urlencode({"a": "reschedule", "ap": appointment_id, "p": PROVIDER, "k": "T24"})))
    _assert_valid(reply)
    assert spy.calls[-1][0] == "get_availability"
    assert spy.calls[-1][1]["providerId"] == PROVIDER
    slots = _block(reply, "slot_options")
    assert slots["providerId"] == PROVIDER
    assert all("Someone else" not in (b.get("suggestions") or []) for b in reply["blocks"])
    new_slot = slots["slots"][0]["slotId"]

    reply = fresh.respond(postback(urlencode({"a": "select_slot", "p": PROVIDER, "s": new_slot})))
    _assert_valid(reply)
    confirmation = _block(reply, "booking_confirmation")
    assert confirmation["appointment"]["appointmentId"] == appointment_id
    assert confirmation["appointment"]["status"] == "RESCHEDULED"
    assert confirmation["appointment"]["slotId"] == new_slot
    assert spy.calls[-1] == (
        "reschedule_appointment",
        {"appointmentId": appointment_id, "newSlotId": new_slot, "patientRef": REF},
    )
    assert spy.names().count("book_appointment") == 1


def test_reprogramar_sin_provider_en_sesion_nueva_no_ofrece_otro_especialista(spy):
    appointment_id = _book_in_first_session(spy)
    before = len(spy.calls)
    reply = app.Concierge(spy).respond(postback(urlencode({"a": "reschedule", "ap": appointment_id})))
    _assert_valid(reply)
    assert len(spy.calls) == before  # sin providerId no hay a quien pedirle horarios
    assert "Reschedule" in reply["blocks"][0]["text"]
    assert not reply["blocks"][0].get("suggestions")


def test_reprogramar_nunca_manda_un_slot_de_otro_provider(spy):
    appointment_id = _book_in_first_session(spy)
    other_slot = spy.inner.call("get_availability", {"providerId": OTHER})["slots"][0]["slotId"]
    fresh = app.Concierge(spy)
    fresh.respond(postback(urlencode({"a": "reschedule", "ap": appointment_id, "p": PROVIDER})))

    reply = fresh.respond(postback(urlencode({"a": "select_slot", "p": OTHER, "s": other_slot})))
    _assert_valid(reply)
    assert "reschedule_appointment" not in spy.names()
    assert spy.names().count("book_appointment") == 1  # solo la reserva original
    assert reply["blocks"][0]["text"].startswith("Rescheduling keeps the same provider")
    assert _block(reply, "slot_options")["providerId"] == PROVIDER

    # Tambien con `ap` explicito en el postback.
    fresh.respond(postback(urlencode({"a": "select_slot", "p": OTHER, "s": other_slot, "ap": appointment_id})))
    assert "reschedule_appointment" not in spy.names()
    assert spy.names().count("book_appointment") == 1


def test_elegir_otro_provider_despues_de_reprogramar_es_una_reserva_nueva(spy):
    appointment_id = _book_in_first_session(spy)
    fresh = app.Concierge(spy)
    fresh.respond(postback(urlencode({"a": "reschedule", "ap": appointment_id, "p": PROVIDER})))
    reply = fresh.respond(postback(urlencode({"a": "select_provider", "p": OTHER})))
    slot = _block(reply, "slot_options")["slots"][0]["slotId"]
    reply = fresh.respond(postback(urlencode({"a": "select_slot", "p": OTHER, "s": slot})))
    assert _block(reply, "booking_confirmation")["appointment"]["status"] == "BOOKED"
    assert "reschedule_appointment" not in spy.names()


def test_el_prompt_no_ofrece_otro_especialista_al_reprogramar():
    assert "Someone else" not in app.PROMPT
    assert "same provider" in app.PROMPT


# ---------- Medium: postbacks de escritura directo al flujo ----------


class _ExplodingModel:
    def __init__(self) -> None:
        self.calls = 0

    def respond(self, turn, records=None):
        self.calls += 1
        raise AssertionError("el modelo no deberia ver este turno")


def test_postbacks_de_escritura_van_directo_al_flujo_sin_modelo(spy):
    appointment_id = _book_in_first_session(spy)
    model = _ExplodingModel()
    concierge = app.Concierge(spy, model)

    reply = concierge.respond(postback(urlencode({"a": "confirm", "ap": appointment_id, "k": "T48"})))
    assert "all set" in reply["blocks"][0]["text"]
    reply = concierge.respond(postback(urlencode({"a": "reschedule", "ap": appointment_id, "p": PROVIDER})))
    new_slot = _block(reply, "slot_options")["slots"][0]["slotId"]
    reply = concierge.respond(postback(urlencode({"a": "select_slot", "p": PROVIDER, "s": new_slot})))
    assert _block(reply, "booking_confirmation")["appointment"]["status"] == "RESCHEDULED"
    reply = concierge.respond(postback(urlencode({"a": "cancel", "ap": appointment_id})))
    assert "cancelled" in reply["blocks"][0]["text"]
    assert model.calls == 0


def test_select_provider_y_texto_siguen_pasando_por_el_modelo(spy):
    model = _ExplodingModel()
    concierge = app.Concierge(spy, model)
    concierge.respond(postback(urlencode({"a": "select_provider", "p": PROVIDER})))
    concierge.respond(text("botox in Austin"))
    assert model.calls == 2  # fallo y cayo al flujo, pero el modelo lo intento


# ---------- Medium: el fallback respeta el deadline del turno ----------


def test_fallback_respeta_el_deadline_del_turno(spy, monkeypatch):
    class BudgetGoneThenCrash:
        def respond(self, turn, records=None):
            raise RuntimeError("model took the whole budget")

    monkeypatch.setattr(app, "TURN_DEADLINE_S", 5.0)  # menos que la reserva de una tool (10 s)
    reply = app.Concierge(spy, BudgetGoneThenCrash()).respond(text("rhinoplasty in Miami"))
    _assert_valid(reply)
    assert spy.calls == []  # el flujo no arranca tools que no terminan antes del timeout del router
    assert "snag" in reply["blocks"][0]["text"]


def test_deadline_tool_client_corta_antes_de_llamar(spy):
    late = DeadlineToolClient(spy, deadline=time.monotonic() + 1, reserve_s=10)
    assert late.call("book_appointment", {"providerId": "p", "slotId": "s"})["code"] == "TIMEOUT"
    assert spy.calls == []
    on_time = DeadlineToolClient(spy, deadline=time.monotonic() + 60, reserve_s=10)
    assert on_time.call("get_availability", {"providerId": PROVIDER})["ok"]
