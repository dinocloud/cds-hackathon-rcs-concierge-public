/**
 * Esquema de PostbackData (owner: Leo). Documentado en docs/contrato-eventos.md, seccion 3.
 *
 * Formato: application/x-www-form-urlencoded con la accion en `a`. Se mantiene
 * este formato (y no `slot:<id>`) porque el agente ya lo parsea con parse_qs
 * (agent/app.py, agent/prompt.md) y los slotId llevan `#` y `:`.
 * Limite: 2048 caracteres por postback (doc de suggestions).
 */
import type { ReminderKind } from '../contracts';
import { LIMITS } from './limits';

export type PostbackAction =
  | { a: 'select_provider'; p: string }
  | { a: 'select_slot'; p: string; s: string }
  | { a: 'confirm'; ap: string; k?: ReminderKind }
  // `p` (providerId) es opcional y aditivo: deja reprogramar en una sesion nueva del agente,
  // que no tiene el turno en memoria (review de Lucas, PR #4). Solo mismo provider.
  | { a: 'reschedule'; ap: string; p?: string; k?: ReminderKind }
  | { a: 'cancel'; ap: string; k?: ReminderKind }
  | { a: 'view_profile'; p: string }
  | { a: 'add_calendar'; ap: string }
  | { a: 'reply'; t: string };

export type PostbackActionName = PostbackAction['a'];

export function encodePostback(action: PostbackAction): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(action)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const data = params.toString();
  if (data.length > LIMITS.postbackData) {
    // Recortar un postback lo corrompe: mejor fallar fuerte en el test.
    throw new Error(`PostbackData supera ${LIMITS.postbackData} caracteres (${data.length})`);
  }
  return data;
}

/** Largo de `a=reply&t=<texto>` ya codificado (lo que cuenta el tope de PostbackData). */
const encodedReplyLength = (t: string): number => new URLSearchParams({ a: 'reply', t }).toString().length;

/**
 * Accion `reply` para texto de usuario o del LLM: nunca lanza. Aplica el tope
 * blando de LIMITS.replyPostbackText (code points) y despues recorta hasta que
 * el postback codificado entre en LIMITS.postbackData. Emojis y CJK ocupan
 * 9 a 12 caracteres codificados cada uno, asi que el tope en code points solo
 * no alcanza. Recorta por code point (no parte pares sustitutos) y sin elipsis.
 */
export function replyPostback(text: string): PostbackAction {
  const chars = Array.from(text).slice(0, LIMITS.replyPostbackText);
  let t = chars.join('').trimEnd();
  if (encodedReplyLength(t) > LIMITS.postbackData) {
    // Busqueda binaria del prefijo mas largo que entra.
    let lo = 0;
    let hi = chars.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (encodedReplyLength(chars.slice(0, mid).join('')) <= LIMITS.postbackData) lo = mid;
      else hi = mid - 1;
    }
    t = chars.slice(0, lo).join('').trimEnd();
  }
  return { a: 'reply', t };
}

const isReminderKind = (k: string | undefined): k is ReminderKind => k === 'T48' || k === 'T24';

export function decodePostback(data: string): PostbackAction | undefined {
  const params = Object.fromEntries(new URLSearchParams(data));
  switch (params.a) {
    case 'select_provider':
      return params.p ? { a: 'select_provider', p: params.p } : undefined;
    case 'select_slot':
      return params.p && params.s ? { a: 'select_slot', p: params.p, s: params.s } : undefined;
    case 'reschedule':
      if (!params.ap) return undefined;
      return {
        a: 'reschedule',
        ap: params.ap,
        ...(params.p ? { p: params.p } : {}),
        ...(isReminderKind(params.k) ? { k: params.k } : {}),
      };
    case 'confirm':
    case 'cancel':
      if (!params.ap) return undefined;
      return isReminderKind(params.k) ? { a: params.a, ap: params.ap, k: params.k } : { a: params.a, ap: params.ap };
    case 'view_profile':
      return params.p ? { a: 'view_profile', p: params.p } : undefined;
    case 'add_calendar':
      return params.ap ? { a: 'add_calendar', ap: params.ap } : undefined;
    case 'reply':
      return params.t ? { a: 'reply', t: params.t } : undefined;
    default:
      return undefined;
  }
}

/** Acciones que solo se registran (log y metrica): el router no las manda al agente. */
const TELEMETRY_ONLY: ReadonlySet<string> = new Set<PostbackActionName>(['view_profile', 'add_calendar']);

/**
 * true para `view_profile` (el telefono abre la URL) y `add_calendar` (el
 * telefono crea el evento). El router corta estos taps antes del agente para que
 * no conteste nada (docs/contrato-eventos.md, seccion 3). Acepta la accion
 * decodificada o solo su nombre.
 */
export function isTelemetryOnlyAction(action: PostbackAction | string | undefined): boolean {
  const name = typeof action === 'string' ? action : action?.a;
  return name !== undefined && TELEMETRY_ONLY.has(name);
}

// ---------- Respuestas por SMS (sin postbacks) ----------
// Para el menu SMS numerado (fallback y plan B CHANNEL_MODE=sms). Todavia no
// esta cableado de punta a punta: el router tiene que guardar las smsOptions
// del ultimo mensaje por paciente (TODO Leo). El parser unico del messageBody
// entrante es el del router (inbound-router/events.ts); aca no se parsea.

/**
 * Resuelve "1", "2.", "#3" o "3)" contra las opciones del ultimo menu SMS
 * enviado (`OutboundMessage.smsOptions`). El router debe guardar esas opciones
 * por paciente para poder resolverlas.
 */
export function resolveSmsReply(text: string, options: readonly PostbackAction[] | undefined): PostbackAction | undefined {
  if (!options || options.length === 0) return undefined;
  const match = /^\s*#?\s*(\d{1,2})\s*[.)]?\s*$/.exec(text);
  if (!match) return undefined;
  const index = Number(match[1]) - 1;
  return index >= 0 && index < options.length ? options[index] : undefined;
}

const REMINDER_KEYWORDS: Record<string, 'confirm' | 'reschedule' | 'cancel'> = {
  C: 'confirm',
  CONFIRM: 'confirm',
  CONFIRMAR: 'confirm',
  YES: 'confirm',
  SI: 'confirm',
  R: 'reschedule',
  RESCHEDULE: 'reschedule',
  REPROGRAMAR: 'reschedule',
  X: 'cancel',
  CANCEL: 'cancel',
  CANCELAR: 'cancel',
};

/**
 * Palabras clave por SMS (C/R/X, CONFIRM/CONFIRMAR, RESCHEDULE/REPROGRAMAR,
 * CANCEL/CANCELAR, YES/SI) a postback, sin estado. Solo letras y palabras: los
 * numeros dependen del menu enviado (en la confirmacion 1 es reprogramar, en el
 * recordatorio 1 es confirmar) y siempre los resuelve `resolveSmsReply`.
 */
export function smsKeywordToPostback(text: string, appointmentId: string, providerId?: string): PostbackAction | undefined {
  const key = text
    .trim()
    .toUpperCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[.!)]+$/, '');
  const action = REMINDER_KEYWORDS[key];
  if (!action) return undefined;
  // `providerId` es opcional: si el router lo conoce, reprogramar funciona en una sesion nueva.
  if (action === 'reschedule' && providerId) return { a: action, ap: appointmentId, p: providerId };
  return { a: action, ap: appointmentId };
}
