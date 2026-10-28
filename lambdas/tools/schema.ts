/**
 * Contrato de las tools que expone el AgentCore Gateway. Es la fuente unica:
 * la usa la infra (schema inline del Gateway target) y la Lambda (tipos).
 * Si cambia algo aca, avisar a Agustin (agent/prompt.md describe estas tools).
 */

export const TOOL_NAMES = [
  'search_providers',
  'get_availability',
  'book_appointment',
  'reschedule_appointment',
  'cancel_appointment',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/** Subconjunto de JSON Schema que acepta el Gateway (type, properties, required, items). */
export interface JsonSchema {
  type: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
}

export interface ToolDefinition {
  name: ToolName;
  description: string;
  inputSchema: JsonSchema;
}

const str = (description: string): JsonSchema => ({ type: 'string', description });

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'search_providers',
    description:
      'Busca especialistas verificados (datos sinteticos) por procedimiento y ciudad. Devuelve hasta 5, ordenados por rating.',
    inputSchema: {
      type: 'object',
      properties: {
        procedure: str('Procedimiento en ingles, en minusculas (ej: rhinoplasty, botox).'),
        city: str('Ciudad (ej: Miami).'),
        limit: { type: 'integer', description: 'Maximo de resultados (1 a 5).' },
      },
      required: ['procedure', 'city'],
    },
  },
  {
    name: 'get_availability',
    description: 'Lista los proximos slots libres de un provider para consulta.',
    inputSchema: {
      type: 'object',
      properties: {
        providerId: str('ID del provider devuelto por search_providers.'),
        fromDate: str('Fecha ISO 8601 desde la cual buscar. Opcional.'),
        limit: { type: 'integer', description: 'Maximo de slots (1 a 4, entran como respuestas sugeridas).' },
      },
      required: ['providerId'],
    },
  },
  {
    name: 'book_appointment',
    description:
      'Reserva un slot para el paciente de la sesion y programa los recordatorios T-48h y T-24h.',
    inputSchema: {
      type: 'object',
      properties: {
        providerId: str('ID del provider.'),
        slotId: str('ID del slot devuelto por get_availability.'),
        patientRef: str('Referencia opaca del paciente (hash del telefono), la inyecta el router.'),
        procedure: str('Procedimiento de la consulta.'),
      },
      required: ['providerId', 'slotId', 'patientRef'],
    },
  },
  {
    name: 'reschedule_appointment',
    description: 'Mueve un turno existente a otro slot del mismo provider y reprograma los recordatorios.',
    inputSchema: {
      type: 'object',
      properties: {
        appointmentId: str('ID del turno.'),
        newSlotId: str('ID del nuevo slot.'),
        patientRef: str('Referencia opaca del paciente.'),
      },
      required: ['appointmentId', 'newSlotId', 'patientRef'],
    },
  },
  {
    name: 'cancel_appointment',
    description: 'Cancela un turno, libera el slot y borra los recordatorios pendientes.',
    inputSchema: {
      type: 'object',
      properties: {
        appointmentId: str('ID del turno.'),
        patientRef: str('Referencia opaca del paciente.'),
      },
      required: ['appointmentId', 'patientRef'],
    },
  },
];
