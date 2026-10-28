/**
 * Version SMS de las plantillas (owner: Leo). Sirve para el MessageBody del
 * FallbackConfiguration y para CHANNEL_MODE=sms (plan B del ADR 001).
 *
 * Reglas: texto GSM-7, lista numerada, "Reply 1, 2 or 3" y tope de
 * LIMITS.smsBody (3 segmentos, medido en septetos con gsm7Length). Si no entra, se sacan opciones del final del
 * menu (nunca se corta una opcion a la mitad) y se devuelven solo las que quedaron.
 */
import { gsm7Length, toGsm7, truncateGsm7 } from './gsm7';
import { LIMITS } from './limits';

export interface SmsMenuInput<T> {
  /** Encabezado (una o varias lineas). */
  header: string;
  /** Opciones con su etiqueta visible y el valor que resuelve el numero. */
  options: Array<{ label: string; value: T }>;
  /** Linea final dado n opciones, por ejemplo "Reply 1, 2 or 3 to book." */
  footer: (n: number) => string;
  /** Texto despues del footer (checklist corto). Se descarta antes que una opcion. */
  trailer?: string;
  /** Tope en septetos GSM-7. Default LIMITS.smsBody. */
  maxChars?: number;
}

export interface SmsMenu<T> {
  text: string;
  values: T[];
}

export function smsText(text: string, maxChars: number = LIMITS.smsBody): string {
  return truncateGsm7(toGsm7(text.trim()), maxChars, '...');
}

export function buildSmsMenu<T>(input: SmsMenuInput<T>, lineFor: (n: number, label: string) => string): SmsMenu<T> {
  const max = input.maxChars ?? LIMITS.smsBody;
  const header = toGsm7(input.header.trim());
  const render = (count: number, withTrailer: boolean) => {
    const lines = input.options.slice(0, count).map((o, i) => toGsm7(lineFor(i + 1, o.label)));
    const parts = [header, ...lines];
    if (count > 0) parts.push(toGsm7(input.footer(count)));
    if (withTrailer && input.trailer) parts.push(toGsm7(input.trailer));
    return parts.filter((p) => p.length > 0).join('\n');
  };

  for (const withTrailer of [true, false]) {
    for (let count = input.options.length; count >= 1; count--) {
      const text = render(count, withTrailer);
      if (gsm7Length(text) <= max) return { text, values: input.options.slice(0, count).map((o) => o.value) };
    }
  }
  // Ni una opcion entra: se recorta el encabezado y se deja la primera opcion.
  const firstOnly = input.options.length > 0 ? 1 : 0;
  const rest = render(firstOnly, false).slice(header.length);
  const text = `${truncateGsm7(header, Math.max(0, max - gsm7Length(rest)), '...')}${rest}`;
  return { text: truncateGsm7(text, max, '...'), values: input.options.slice(0, firstOnly).map((o) => o.value) };
}
