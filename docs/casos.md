# Casos de uso de la POC

Alcance cerrado: casos 1 y 2. El seguimiento posterior con pedido de reseña y la reactivación de interesados quedan afuera. Todos los datos son sintéticos: providers, slots, turnos y teléfonos de prueba del equipo.

## Caso 1: concierge de turnos

**Objetivo:** que el paciente pase de "quiero averiguar" a "tengo una consulta confirmada" sin salir de la app de mensajes.

**Actores:** paciente (teléfono con RCS), agente concierge, tools del Gateway.

### Flujo

| # | Paciente ve / hace | Sistema |
| --- | --- | --- |
| 1 | Escribe "I want rhinoplasty in Miami" | End User Messaging publica el mensaje en SNS. `inbound-router` deriva `patientRef` y `sessionId` del teléfono (HMAC, sin PII) e invoca al Runtime |
| 2 | | El agente llama `search_providers(procedure, city)` por Gateway |
| 3 | Recibe una línea de texto y un carrusel de hasta 5 especialistas verificados: nombre, especialidad, rating, botones "See availability" y "View profile" | El router arma el carrusel con `providerCarousel` y lo manda con `SendRcsMessage` |
| 4 | Toca "See availability" en una tarjeta | Llega un postback `a=select_provider&p=<id>`; el agente llama `get_availability` |
| 5 | Recibe hasta 4 horarios como respuestas sugeridas | `slotOptions` |
| 6 | Toca un horario | Postback `a=select_slot&p=<id>&s=<slot>`; el agente llama `book_appointment`, que toma el slot y programa los recordatorios |
| 7 | Recibe la tarjeta de confirmación con "Reschedule" y "Cancel" | `bookingConfirmation` |

### Reglas

- Si falta el procedimiento o la ciudad, el agente pregunta una sola cosa por vez.
- Si el slot ya no está libre (`SLOT_TAKEN`), ofrece los siguientes.
- Sin consejo clínico: síntomas, riesgos, dosis o resultados se derivan a la consulta con el provider (`clinicalHandoff`).
- El agente nunca ve el teléfono; usa `patientRef`.

### Criterio de aceptación (checkpoint vie 23/10)

- Flujo completo en un teléfono real con RCS, de la primera pregunta a la confirmación, en menos de 1 minuto con la sesión precalentada.

## Caso 2: recordatorios a 48 h y 24 h con caída a SMS

**Objetivo:** bajar ausencias y reprogramaciones tardías con un recordatorio accionable, y que llegue aunque el dispositivo no soporte RCS.

**Actores:** EventBridge Scheduler, `reminder-sender`, paciente con y sin RCS.

### Flujo

| # | Paciente ve / hace | Sistema |
| --- | --- | --- |
| 1 | (Al reservar en el caso 1) | `book_appointment` crea dos schedules one-time: T-48h y T-24h. En `DEMO_MODE` se comprimen a 2 y 4 minutos desde la reserva |
| 2 | | Scheduler invoca `reminder-sender` con `{appointmentId, kind}` |
| 3 | Con RCS: tarjeta "Your consult is in 2 days" con fecha, checklist previo y botones Confirm, Reschedule, Cancel | `reminderCard` + `SendRcsMessage` con `FallbackConfiguration` a SMS y TTL |
| 3b | Sin RCS (o vence el TTL): SMS "Reminder: ... Reply C to confirm, R to reschedule, X to cancel" | El fallback lo resuelve End User Messaging, no código propio |
| 4 | Toca un botón o responde C, R o X | Postback o texto; el agente confirma, ofrece nuevos slots (`reschedule_appointment`) o cancela (`cancel_appointment`, que borra los schedules pendientes) |
| 5 | | Los eventos de entrega (RCS entregado, leído, fallback, SMS entregado) van a `message-events` y al dashboard |

### Reglas

- Un schedule que dispara después de cancelar se ignora (`INACTIVE`).
- Reprogramar borra los schedules viejos y crea nuevos.
- El checklist previo es logístico (documento, preguntas, medicación para la clínica), nunca indicaciones clínicas.

### Criterio de aceptación (checkpoint vie 23/10)

- El mismo recordatorio llega por RCS a un teléfono y por SMS a otro, y el dashboard muestra los dos caminos.

## Guion de la demo (3 minutos)

1. Teléfono con RCS: "quiero averiguar por rinoplastia en Miami", carrusel, elegir slot, confirmación.
2. Modo demo: llega el recordatorio de "48 h" y el paciente reprograma con un toque.
3. Segundo teléfono sin RCS: recibe el mismo recordatorio por SMS; el dashboard muestra RCS contra SMS.
4. Cierre: arquitectura y repo.
