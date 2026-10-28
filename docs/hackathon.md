# Hackathon AWS CDS Agentic AI: reglas, criterios y fechas

## Reglas

- Caso real de cliente con al menos un servicio de AWS CDS: End User Messaging (RCS/SMS), WhatsApp o SES. Usamos End User Messaging RCS con fallback a SMS.
- Desplegado en AWS, con AgentCore como opción recomendada. Usamos Runtime, Memory y Gateway.
- Proyecto nuevo y 100% de DinoCloud, solo con datos sintéticos: nada de código ni datos de clientes.
- Cuenta dev de DinoCloud. Sin Amazon Connect: servicios nativos de CDS.
- Oportunidad nueva en ACE con el código de campaña del hackathon (lo gestiona Agustín).

## Criterios de evaluación (sobre 100)

| Criterio | Puntos | Cómo lo atacamos |
| --- | --- | --- |
| Ejecución técnica | 40 | RCS nativo (carrusel, respuestas sugeridas, rich cards), fallback por mensaje a SMS, AgentCore completo, IaC con tests, repo prolijo |
| Valor | 20 | Cierra el hueco entre el lead y la consulta confirmada |
| Demo | 20 | Dos teléfonos, un flujo completo y el fallback visible en el dashboard |
| Funcionalidad | 10 | Reservar, reprogramar, cancelar y recordar de punta a punta |
| Creatividad | 10 | Concierge con tono de marca sobre RCS y modo demo con tiempo comprimido |

El jurado mira la solución desplegada, el repo, la arquitectura y el video, y puntúa sobre todo la ejecución técnica. Se valoran la simplicidad y las buenas prácticas de repo.

## Entregables (Devpost)

- Repositorio con el código completo (este repo).
- Diagrama de arquitectura en AWS (`docs/adr/001-arquitectura.md`).
- Descripción: qué problema resuelve y cómo.
- Video de demo de unos 3 minutos (guion en `docs/casos.md`).
- URL o instrucciones para probarla.
- ID de la oportunidad nueva en ACE.

## Fechas

| Hito | Fecha |
| --- | --- |
| Checkpoint interno: caso 1 completo y un recordatorio que cae a SMS | Vie 23/10/2026 |
| Code freeze | Mar 27/10/2026, 12:00 ART |
| Grabación y ensayo del video | Mar 27/10/2026, tarde |
| Envío en Devpost (margen interno: antes de las 15:00) | Mié 28/10/2026, 17:00 ART (13:00 PT) |

## Equipo

| Persona | Rol |
| --- | --- |
| Agustín | TL, arquitectura, agente, Devpost y ACE |
| Leo | Canal RCS: agente RCS, plantillas, inbound y postbacks |
| Pablo | Backend e infra: datos, tools, Scheduler, recordatorios, dashboard |
