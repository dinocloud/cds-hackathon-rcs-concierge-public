# Aurora Concierge por RCS: one pager

**En una línea:** el paciente pasa de "quiero averiguar" a "tengo turno confirmado" sin salir de la app de mensajes, y si su teléfono no soporta RCS el recordatorio igual le llega por SMS.

## Problema

- El caso de uso es un marketplace de estética donde millones de personas investigan procedimientos con reseñas, fotos y Q&A. Su negocio es convertir esa investigación en leads y consultas para los providers.
- **El recorrido termina en el lead.** No hay reserva de consulta, agenda ni recordatorios.
- Lo que pasa entre el "me interesa" y la consulta queda fuera del marketplace: ahí se pierden pacientes.

## Solución

Un agente conversacional sobre RCS que cierra ese hueco, con un tono cálido y bien informado, y sin consejos clínicos.

| Caso | Qué ve el paciente |
| --- | --- |
| 1. Concierge de turnos | Pregunta por un procedimiento y recibe un carrusel de especialistas verificados. La disponibilidad le llega como botones, y con un toque reserva y recibe la confirmación |
| 2. Recordatorios a 48 h y 24 h | Tarjeta con confirmar, reprogramar o cancelar, más un checklist previo. Si el dispositivo no soporta RCS, cae solo a SMS |

## Arquitectura

AWS End User Messaging envía y recibe por RCS (rich cards, carrusel, respuestas sugeridas) y entrega las respuestas por SNS a una Lambda. La Lambda invoca un agente en AgentCore Runtime, con Memory para la sesión y Gateway para las tools de buscar providers, ver disponibilidad y reservar, todas sobre DynamoDB con datos sintéticos. Al reservar, EventBridge Scheduler programa los dos recordatorios, que salen con `SendRcsMessage` con fallback a SMS por TTL. Un dashboard muestra en vivo qué se entregó por RCS y qué cayó a SMS. Todo vive en la cuenta dev de DinoCloud, con IaC en un repo nuevo.

```
Paciente <-> End User Messaging (RCS / SMS) -> SNS -> Lambda -> AgentCore (Runtime + Memory + Gateway) -> tools -> DynamoDB
                                         ^                                                     |
                                         +---- recordatorios <- EventBridge Scheduler <--------+
```

## Qué mostramos en la demo (3 minutos)

1. Un teléfono con RCS: "quiero averiguar por rinoplastia en Miami", aparece el carrusel, el paciente elige un slot y recibe la confirmación.
2. Modo demo con el tiempo comprimido: llega el recordatorio de "48 h" con botones y el paciente reprograma con un toque.
3. Un segundo teléfono sin RCS recibe el mismo recordatorio por SMS, y el dashboard muestra los dos caminos.
4. Cierre: la arquitectura y el repo.

## Por qué gana

- **Ejecución técnica (40 de 100):** usa RCS nativo con carrusel, respuestas sugeridas y fallback a SMS, que es justo lo que AWS CDS acaba de lanzar. Suma AgentCore completo y un diagrama simple.
- **Valor (20):** cierra el hueco entre el interés del paciente y la consulta confirmada, que hoy no existe.
- **Demo (20):** dos teléfonos, un flujo completo y el fallback visible en vivo.
- **Reglas:** proyecto nuevo, solo datos sintéticos, sin código ni datos de clientes y sin Connect.
