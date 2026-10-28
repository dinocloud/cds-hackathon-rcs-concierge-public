"""Tools en memoria para correr el agente sin AWS (modo local / tests).

Imita lambdas/tools (y lambdas/tools/synthetic-data.ts) con datos sinteticos. No es la fuente de verdad: la Lambda lo es.
Mismos codigos que la Lambda: BAD_REQUEST para un turno ya cancelado o un slot de otro provider,
INTERNAL para un error no manejado (ver LocalTools.call). book_appointment es idempotente por paciente
y slot, como en la Lambda (PR #9): el reintento sobre la propia reserva activa devuelve ese turno.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

_SEEDS = [
    ("Dr. Ava Synth", "Facial plastic surgeon", ["rhinoplasty", "facelift"]),
    ("Dr. Leo Mock", "Plastic surgeon", ["rhinoplasty", "tummy tuck"]),
    ("Dr. Mia Sample", "Dermatologist", ["botox", "fillers"]),
    ("Dr. Noah Demo", "Facial plastic surgeon", ["rhinoplasty", "blepharoplasty"]),
    ("Glow Test Med Spa", "Med spa", ["botox", "fillers", "laser"]),
    ("Dr. Zoe Fixture", "Plastic surgeon", ["tummy tuck", "facelift"]),
]
_CITIES = ["Miami", "Austin", "San Diego"]
_IMAGE = "https://placehold.co/600x400/png?text=Synthetic+Provider"
_ACTIVE_STATUSES = ("BOOKED", "CONFIRMED", "RESCHEDULED")


class LocalTools:
    def __init__(self, now: datetime | None = None) -> None:
        self.now = now or datetime.now(timezone.utc)
        self.providers = []
        for ci, city in enumerate(_CITIES):
            for pi, (name, specialty, procedures) in enumerate(_SEEDS):
                pid = f"prov_{city.lower().replace(' ', '')}_{pi + 1:02d}"
                self.providers.append(
                    {
                        "providerId": pid,
                        "name": name,
                        "specialty": specialty,
                        "procedures": procedures,
                        "city": city,
                        "rating": round(4.2 + ((pi * 7 + ci * 3) % 8) / 10, 1),
                        "reviewCount": 40 + (pi * 37 + ci * 11) % 260,
                        "verified": pi % 3 != 2,
                        "imageUrl": _IMAGE,
                        "profileUrl": f"https://example.com/providers/{pid}",
                    }
                )
        self.taken: set[str] = set()
        self.appointments: dict[str, dict] = {}

    def _owned(self, appointment_id: str, patient_ref: str) -> tuple[dict | None, dict | None]:
        """Como loadOwned de lambdas/tools: existe, es del paciente y sigue activo."""
        appt = self.appointments.get(appointment_id)
        if not appt:
            return None, {"ok": False, "error": "Turno inexistente", "code": "NOT_FOUND"}
        if appt["patientRef"] != patient_ref:
            return None, {"ok": False, "error": "El turno no es de este paciente", "code": "FORBIDDEN"}
        # Operar sobre un turno cancelado liberaria un slot que ya puede ser de otro paciente.
        if appt["status"] not in _ACTIVE_STATUSES:
            return None, {"ok": False, "error": "El turno ya esta cancelado", "code": "BAD_REQUEST"}
        return appt, None

    def _take_slot_of(self, slot_id: str, provider_id: str) -> dict | None:
        """Como takeSlotOf de lambdas/tools. Devuelve el error, o None si tomo el slot."""
        if not slot_id.startswith(provider_id + "#"):
            return {"ok": False, "error": "El slot no pertenece a ese provider", "code": "BAD_REQUEST"}
        if slot_id in self.taken:
            return {"ok": False, "error": "Slot tomado", "code": "SLOT_TAKEN"}
        self.taken.add(slot_id)
        return None

    def _find_own_booking(self, patient_ref: str, slot_id: str) -> dict | None:
        """Como findOwnBooking de lambdas/tools: turno activo del mismo paciente en ese slot."""
        return next(
            (
                a
                for a in self.appointments.values()
                if a["patientRef"] == patient_ref and a["slotId"] == slot_id and a["status"] in _ACTIVE_STATUSES
            ),
            None,
        )

    def call(self, name: str, args: dict) -> dict:
        """Despacho como createGatewayHandler: argumentos invalidos dan BAD_REQUEST y un error
        no manejado vuelve como INTERNAL, sin el detalle."""
        try:
            return getattr(self, name)(**args)
        except (TypeError, AttributeError) as err:
            return {"ok": False, "error": str(err), "code": "BAD_REQUEST"}
        except Exception:  # noqa: BLE001 - mismo contrato que la Lambda
            return {"ok": False, "error": "Error interno", "code": "INTERNAL"}

    def _provider(self, provider_id: str) -> dict | None:
        return next((p for p in self.providers if p["providerId"] == provider_id), None)

    def _slots(self, provider_id: str) -> list[dict]:
        out = []
        for d in range(1, 8):
            day = (self.now + timedelta(days=d)).replace(minute=0, second=0, microsecond=0)
            if day.weekday() >= 5:
                continue
            for h in (14, 16, 19):
                start = day.replace(hour=h).strftime("%Y-%m-%dT%H:%M:%S.000Z")
                slot_id = f"{provider_id}#{start}"
                out.append(
                    {
                        "slotId": slot_id,
                        "providerId": provider_id,
                        "startsAt": start,
                        "durationMinutes": 30,
                        "available": slot_id not in self.taken,
                    }
                )
        return out

    # ---- Tools con la misma firma que el Gateway ----

    def search_providers(self, procedure: str, city: str, limit: int = 5) -> dict:
        found = [
            p
            for p in self.providers
            if p["city"].lower() == city.strip().lower() and procedure.strip().lower() in p["procedures"]
        ]
        found.sort(key=lambda p: p["rating"], reverse=True)
        return {"ok": True, "providers": found[: max(1, min(limit, 5))]}

    def get_availability(self, providerId: str, fromDate: str | None = None, limit: int = 4) -> dict:
        if not self._provider(providerId):
            return {"ok": False, "error": "Provider inexistente", "code": "NOT_FOUND"}
        provider = self._provider(providerId)
        slots = [s for s in self._slots(providerId) if s["available"]]
        if fromDate:
            slots = [s for s in slots if s["startsAt"] >= fromDate]
        return {"ok": True, "providerId": providerId, "providerName": provider["name"], "slots": slots[: max(1, min(limit, 4))]}

    def book_appointment(self, providerId: str, slotId: str, patientRef: str, procedure: str | None = None) -> dict:
        provider = self._provider(providerId)
        if not provider:
            return {"ok": False, "error": "Provider inexistente", "code": "NOT_FOUND"}
        error = self._take_slot_of(slotId, providerId)
        if error:
            # Reintento del router o llamada repetida del modelo: el turno existente, sin
            # agendar recordatorios de nuevo. Un slot de otro paciente sigue siendo SLOT_TAKEN.
            if error["code"] == "SLOT_TAKEN":
                existing = self._find_own_booking(patientRef, slotId)
                if existing:
                    return {"ok": True, "appointment": existing, "provider": provider}
            return error
        now = self.now.isoformat()
        appt = {
            "appointmentId": f"apt_{uuid.uuid4().hex[:8]}",
            "patientRef": patientRef,
            "providerId": providerId,
            "slotId": slotId,
            "procedure": procedure,
            "startsAt": slotId.split("#", 1)[1],
            "status": "BOOKED",
            "reminderScheduleNames": [],
            "createdAt": now,
            "updatedAt": now,
        }
        self.appointments[appt["appointmentId"]] = appt
        return {"ok": True, "appointment": appt, "provider": provider}

    def reschedule_appointment(self, appointmentId: str, newSlotId: str, patientRef: str) -> dict:
        appt, error = self._owned(appointmentId, patientRef)
        if error:
            return error
        error = self._take_slot_of(newSlotId, appt["providerId"])
        if error:
            return error
        self.taken.discard(appt["slotId"])
        appt.update(
            slotId=newSlotId,
            startsAt=newSlotId.split("#", 1)[1],
            status="RESCHEDULED",
            updatedAt=self.now.isoformat(),
        )
        return {"ok": True, "appointment": appt, "provider": self._provider(appt["providerId"])}

    def cancel_appointment(self, appointmentId: str, patientRef: str) -> dict:
        appt, error = self._owned(appointmentId, patientRef)
        if error:
            return error
        appt.update(status="CANCELLED", reminderScheduleNames=[], updatedAt=self.now.isoformat())
        self.taken.discard(appt["slotId"])
        return {"ok": True, "appointment": appt, "provider": self._provider(appt["providerId"])}
