/**
 * Limites documentados de RCS y SMS (owner: Leo).
 *
 * Fuentes (consultadas el 21/10/2026):
 * - https://docs.aws.amazon.com/sms-voice/latest/userguide/rcs-rich-messaging.html (tabla "RCS message limits")
 * - https://docs.aws.amazon.com/sms-voice/latest/userguide/rcs-suggestions.html (tabla "Suggestion limits")
 * - https://docs.aws.amazon.com/sms-voice/latest/userguide/rcs-fallback-per-message.html (MessageBody del fallback)
 * - Tipos de @aws-sdk/client-pinpoint-sms-voice-v2 3.1154.0 (RcsCarousel, RcsCardContent, RcsCreateCalendarEventAction)
 */

export const LIMITS = {
  /** Texto visible de una sugerencia (Reply, OpenUrl, CreateCalendarEvent...). */
  suggestionText: 25,
  /** PostbackData de cualquier sugerencia. */
  postbackData: 2048,
  /**
   * Texto que viaja en el postback de una sugerencia generica (`a=reply&t=`).
   * Tope propio: el texto viene del LLM y se recorta en vez de romper el envio.
   */
  replyPostbackText: 256,
  /** Url de una sugerencia OpenUrl. VERIFICAR el tope exacto en la doc de suggestions. */
  openUrl: 2048,
  /** Titulo de rich card o tarjeta de carrusel. */
  cardTitle: 200,
  /** Descripcion de rich card o tarjeta de carrusel. */
  cardDescription: 2000,
  /** Tarjetas por carrusel: minimo 2, maximo 10. */
  carouselCardsMin: 2,
  carouselCards: 10,
  /** Sugerencias por tarjeta (rich card o tarjeta de carrusel). */
  suggestionsPerCard: 4,
  /** Sugerencias a nivel mensaje (RcsMessageContent.Suggestions). */
  suggestionsPerMessage: 11,
  /** Body de un TextMessage RCS. */
  textBody: 3072,
  /** FileUrl de media (https:// o s3://). */
  mediaUrl: 2000,
  /** Titulo y descripcion de CreateCalendarEvent. */
  calendarTitle: 100,
  calendarDescription: 500,
  /** MessageBody del FallbackConfiguration (SMS). */
  smsFallbackBody: 1600,
  /**
   * Tope propio para los textos SMS, en septetos GSM-7 (gsm7Length): 3 segmentos
   * concatenados (3 x 153). Los caracteres extendidos (`[]{}€^~|\\`) cuentan 2.
   * Decision de producto, no limite de AWS: mantiene costo y lectura acotados.
   */
  smsBody: 459,
  /** Segmentos GSM-7: 160 caracteres en uno solo, 153 por segmento si se concatena. */
  smsSegmentGsm7: 160,
  smsConcatSegmentGsm7: 153,
  /** Segmentos UCS-2 (si hay un caracter fuera de GSM-7): 70 y 67. */
  smsSegmentUcs2: 70,
  smsConcatSegmentUcs2: 67,
  /** TimeToLive de SendRcsMessage, en segundos (1 s a 48 h). */
  ttlMinSeconds: 1,
  ttlMaxSeconds: 172800,
} as const;

/** Respuestas sugeridas de horarios: la doc recomienda ofrecer 3 a 5 opciones. */
export const MAX_SLOT_SUGGESTIONS = 4;
/** Opciones listadas en un menu SMS (mantiene el texto en 3 segmentos). */
export const MAX_SMS_OPTIONS = 5;

/**
 * Recorta a `max` caracteres (code points, no unidades UTF-16) y agrega una
 * elipsis si recorta. Para SMS GSM-7 usar `ellipsis = '...'`.
 */
export function truncate(text: string, max: number, ellipsis = '…'): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const tail = Array.from(ellipsis);
  if (max <= tail.length) return chars.slice(0, max).join('');
  return `${chars.slice(0, max - tail.length).join('').trimEnd()}${ellipsis}`;
}

/** Largo en code points (lo que cuentan los limites de caracteres). */
export function charLength(text: string): number {
  return Array.from(text).length;
}

/** TTL dentro del rango documentado; valores invalidos caen al default. */
export function clampTtl(seconds: number, fallback = 300): number {
  if (!Number.isFinite(seconds)) return fallback;
  return Math.min(LIMITS.ttlMaxSeconds, Math.max(LIMITS.ttlMinSeconds, Math.round(seconds)));
}
