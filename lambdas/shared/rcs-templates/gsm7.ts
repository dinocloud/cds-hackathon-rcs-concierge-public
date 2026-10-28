/**
 * Helpers GSM-7 para los textos SMS (owner: Leo). Un solo caracter fuera del
 * alfabeto GSM 03.38 pasa todo el mensaje a UCS-2 (70 caracteres por segmento
 * en vez de 160), asi que los textos SMS se normalizan antes de enviarse.
 */
import { LIMITS } from './limits';

const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
/** Tabla extendida: cada uno ocupa 2 septetos (escape + caracter). */
const GSM7_EXTENDED = '^{}\\[~]|€\f';

const BASIC = new Set(Array.from(GSM7_BASIC));
const EXTENDED = new Set(Array.from(GSM7_EXTENDED));

const REPLACEMENTS: Record<string, string> = {
  '‘': "'",
  '’': "'",
  '‚': "'",
  '“': '"',
  '”': '"',
  '„': '"',
  '–': '-',
  '—': '-',
  '−': '-',
  '…': '...',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
  '•': '-',
  '·': '-',
  '★': '*',
  '☆': '*',
  '\t': ' ',
};

export function isGsm7(text: string): boolean {
  return Array.from(text).every((c) => BASIC.has(c) || EXTENDED.has(c));
}

/** Reemplaza lo que no es GSM-7 por el equivalente mas cercano (o "?"). */
export function toGsm7(text: string): string {
  let out = '';
  for (const c of Array.from(text)) {
    if (BASIC.has(c) || EXTENDED.has(c)) {
      out += c;
      continue;
    }
    const mapped = REPLACEMENTS[c];
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    // Acentos que GSM-7 no tiene (a, i, o, u con tilde...): se quita el diacritico.
    const base = c.normalize('NFD').replace(/[̀-ͯ]/g, '');
    out += base.length > 0 && Array.from(base).every((b) => BASIC.has(b)) ? base : '?';
  }
  return out;
}

/** Septetos que ocupa un texto GSM-7 (los extendidos cuentan doble). */
export function gsm7Length(text: string): number {
  return Array.from(text).reduce((n, c) => n + (EXTENDED.has(c) ? 2 : 1), 0);
}

/**
 * Recorta un texto GSM-7 a `max` septetos (nunca parte un caracter extendido) y
 * agrega `ellipsis` si recorta.
 */
export function truncateGsm7(text: string, max: number, ellipsis = '...'): string {
  if (gsm7Length(text) <= max) return text;
  // Sin lugar para la elipsis, se recorta sin ella (igual que truncate).
  const tail = gsm7Length(ellipsis) < max ? ellipsis : '';
  const budget = max - gsm7Length(tail);
  let out = '';
  let used = 0;
  for (const c of Array.from(text)) {
    const cost = EXTENDED.has(c) ? 2 : 1;
    if (used + cost > budget) break;
    out += c;
    used += cost;
  }
  return tail ? `${out.trimEnd()}${tail}` : out;
}

/** Cantidad de segmentos SMS que factura el texto. */
export function smsSegments(text: string): number {
  if (text.length === 0) return 0;
  if (isGsm7(text)) {
    const len = gsm7Length(text);
    return len <= LIMITS.smsSegmentGsm7 ? 1 : Math.ceil(len / LIMITS.smsConcatSegmentGsm7);
  }
  const len = text.length; // UCS-2: unidades UTF-16
  return len <= LIMITS.smsSegmentUcs2 ? 1 : Math.ceil(len / LIMITS.smsConcatSegmentUcs2);
}
