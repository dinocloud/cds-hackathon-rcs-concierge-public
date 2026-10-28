"""book_appointment idempotente en las tools locales, espejo de lambdas/tools (PR #9 de Lucas)."""
from __future__ import annotations

from datetime import datetime, timezone

from local_tools import LocalTools

PROVIDER = "prov_miami_01"
NOW = datetime(2026, 10, 26, 12, 0, tzinfo=timezone.utc)


def _setup() -> tuple[LocalTools, str]:
    tools = LocalTools(now=NOW)
    slot = tools.get_availability(PROVIDER)["slots"][0]["slotId"]
    return tools, slot


def _book(tools: LocalTools, slot: str, ref: str) -> dict:
    return tools.call("book_appointment", {"providerId": PROVIDER, "slotId": slot, "patientRef": ref})


def test_reservar_dos_veces_el_mismo_slot_devuelve_el_turno_existente():
    tools, slot = _setup()
    first = _book(tools, slot, "A")["appointment"]

    again = _book(tools, slot, "A")

    assert again["ok"] is True
    assert again["appointment"]["appointmentId"] == first["appointmentId"]
    assert again["appointment"]["status"] == "BOOKED"
    assert again["provider"]["providerId"] == PROVIDER
    # Ni turno nuevo ni recordatorios nuevos.
    assert len(tools.appointments) == 1
    assert again["appointment"]["reminderScheduleNames"] == first["reminderScheduleNames"]


def test_el_turno_reprogramado_al_slot_tambien_cuenta_como_reserva_propia():
    tools, slot = _setup()
    other_slot = tools.get_availability(PROVIDER)["slots"][1]["slotId"]
    appt = _book(tools, slot, "A")["appointment"]
    tools.call("reschedule_appointment", {"appointmentId": appt["appointmentId"], "newSlotId": other_slot, "patientRef": "A"})

    again = _book(tools, other_slot, "A")

    assert again["ok"] is True
    assert again["appointment"]["status"] == "RESCHEDULED"
    assert len(tools.appointments) == 1


def test_el_slot_reservado_por_otro_paciente_sigue_siendo_slot_taken():
    tools, slot = _setup()
    _book(tools, slot, "A")

    assert _book(tools, slot, "B") == {"ok": False, "error": "Slot tomado", "code": "SLOT_TAKEN"}


def test_un_turno_propio_cancelado_en_ese_slot_no_cuenta_como_reserva_existente():
    tools, slot = _setup()
    appt = _book(tools, slot, "A")["appointment"]
    tools.call("cancel_appointment", {"appointmentId": appt["appointmentId"], "patientRef": "A"})
    _book(tools, slot, "B")

    assert _book(tools, slot, "A")["code"] == "SLOT_TAKEN"


def test_un_slot_de_otro_provider_sigue_siendo_bad_request():
    tools, slot = _setup()
    _book(tools, slot, "A")

    out = tools.call("book_appointment", {"providerId": "prov_miami_02", "slotId": slot, "patientRef": "A"})

    assert out["code"] == "BAD_REQUEST"
