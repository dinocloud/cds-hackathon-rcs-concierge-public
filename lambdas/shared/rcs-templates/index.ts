/**
 * Builders de payloads RCS (owner: Leo). Cada builder devuelve el
 * RcsMessageContent de SendRcsMessage, la version SMS del mismo mensaje
 * (`fallbackText`, que va al FallbackConfiguration y a CHANNEL_MODE=sms) y las
 * opciones del menu SMS numerado (`smsOptions`) para resolver "1", "2", "3".
 *
 * Formas y limites verificados contra la doc de AWS (ver limits.ts) y los tipos
 * de @aws-sdk/client-pinpoint-sms-voice-v2. Nota: la guia de rich cards muestra
 * `Content.RichCard.StandaloneCard.CardOrientation`, pero la API reference
 * (API_RcsContent: RichCard es RcsStandaloneCard) y el SDK usan
 * `Content.RichCard.CardOrientation`. Se sigue el SDK. VERIFICAR con DryRun en dev.
 */
import type { RcsCardMedia, RcsMessageContent, RcsSuggestedAction } from '@aws-sdk/client-pinpoint-sms-voice-v2';
import type { Appointment, Provider, ReminderKind, Slot } from '../contracts';
import { type TemplateCopy, type TemplateLocale, copyFor, intlLocale } from './copy';
import { LIMITS, MAX_SLOT_SUGGESTIONS, MAX_SMS_OPTIONS, truncate } from './limits';
import { type PostbackAction, encodePostback, replyPostback } from './postback';
import { buildSmsMenu, smsText } from './sms';

export { LIMITS, MAX_SLOT_SUGGESTIONS, MAX_SMS_OPTIONS, charLength, clampTtl, truncate } from './limits';
export { gsm7Length, isGsm7, smsSegments, toGsm7, truncateGsm7 } from './gsm7';
export type { PostbackAction, PostbackActionName } from './postback';
export {
  decodePostback,
  encodePostback,
  isTelemetryOnlyAction,
  replyPostback,
  resolveSmsReply,
  smsKeywordToPostback,
} from './postback';
export type { TemplateCopy, TemplateLocale } from './copy';
export { copyFor } from './copy';
export { buildSmsMenu, smsText } from './sms';

export type TemplateKind =
  | 'text'
  | 'provider_carousel'
  | 'provider_card'
  | 'slot_options'
  | 'booking_confirmation'
  | 'reminder';

export interface OutboundMessage {
  content: RcsMessageContent;
  /** Version SMS del mismo mensaje (GSM-7, <= LIMITS.smsBody septetos). Fallback y plan B. */
  fallbackText: string;
  /** Tipo de plantilla, para logs y Context. */
  kind?: TemplateKind;
  /**
   * Opciones del menu SMS en orden: el numero N que responda el paciente es
   * `smsOptions[N - 1]` (ver resolveSmsReply). El router debe guardarlas.
   */
  smsOptions?: PostbackAction[];
}

export interface TemplateOptions {
  /** Default en-US (lo que manda hoy el router). */
  locale?: TemplateLocale;
  /** Zona horaria para mostrar horarios. Default America/New_York. */
  timeZone?: string;
  /** Duracion para el evento de calendario (Appointment no la trae). Default 30. */
  durationMinutes?: number;
}

const DEFAULT_TZ = 'America/New_York';

// ---------- Helpers ----------

function reply(text: string, action: PostbackAction): RcsSuggestedAction {
  return { Reply: { Text: truncate(text, LIMITS.suggestionText), PostbackData: encodePostback(action) } };
}

const isHttps = (url: string | undefined): url is string =>
  !!url && url.startsWith('https://') && url.length <= LIMITS.openUrl;

function openUrl(text: string, url: string, action: PostbackAction): RcsSuggestedAction {
  return { OpenUrl: { Text: truncate(text, LIMITS.suggestionText), PostbackData: encodePostback(action), Url: url } };
}

/**
 * Media de tarjeta. La guia acepta `^(https://|s3://).+$` hasta 2000 caracteres;
 * el SDK documenta "S3 URI". VERIFICAR que un https publico (placeholder
 * sintetico) se acepte; si no, subir la imagen a S3 y pasar s3://.
 */
function cardMedia(url: string | undefined, height: 'SHORT' | 'MEDIUM' | 'TALL'): RcsCardMedia | undefined {
  if (!url || !/^(https:\/\/|s3:\/\/).+$/.test(url) || url.length > LIMITS.mediaUrl) return undefined;
  return { FileUrl: url, Height: height };
}

function limitSuggestions<T>(items: T[], max: number): T[] {
  return items.slice(0, max);
}

const isValidDate = (date: Date) => !Number.isNaN(date.getTime());

/**
 * Formato corto para slots y tarjetas. en-US: "Thu, Oct 29, 10:30 AM".
 * es-US: "jue 29/10, 10:30" (entra en los 25 caracteres de una sugerencia).
 * Con un ISO invalido devuelve el texto tal cual en vez de dejar que Intl tire
 * RangeError y se caiga toda la respuesta.
 */
export function formatSlot(iso: string, timeZone = DEFAULT_TZ, locale: TemplateLocale = 'en-US'): string {
  const date = new Date(iso);
  if (!isValidDate(date)) return iso;
  if (locale === 'es-US') {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat(intlLocale(locale), {
        weekday: 'short',
        day: 'numeric',
        month: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        timeZone,
      })
        .formatToParts(date)
        .map((p) => [p.type, p.value]),
    );
    return `${String(parts.weekday).replace('.', '')} ${parts.day}/${parts.month}, ${parts.hour}:${parts.minute}`;
  }
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  })
    .format(date)
    .replace(/[  ]/g, ' ');
}

const rating = (p: Provider) => p.rating.toFixed(1);

function providerCardContent(p: Provider, c: TemplateCopy) {
  const suggestions: RcsSuggestedAction[] = [reply(c.seeAvailability, { a: 'select_provider', p: p.providerId })];
  if (isHttps(p.profileUrl)) suggestions.push(openUrl(c.viewProfile, p.profileUrl, { a: 'view_profile', p: p.providerId }));
  return {
    Title: truncate(`${p.name}${p.verified ? ` · ${c.verified}` : ''}`, LIMITS.cardTitle),
    Description: truncate(c.providerDescription(p.specialty, p.city, rating(p), p.reviewCount), LIMITS.cardDescription),
    Media: cardMedia(p.imageUrl, 'MEDIUM'),
    Suggestions: limitSuggestions(suggestions, LIMITS.suggestionsPerCard),
  };
}

// ---------- Builders ----------

/** Texto con respuestas sugeridas opcionales (bloque `text`). */
export function textMessage(body: string, suggestions: string[] = [], opts: TemplateOptions = {}): OutboundMessage {
  const c = copyFor(opts.locale);
  const content: RcsMessageContent = { Content: { TextMessage: { Body: truncate(body, LIMITS.textBody) } } };
  const picked = limitSuggestions(suggestions, LIMITS.suggestionsPerMessage);
  // El texto viene del LLM: replyPostback lo recorta por largo codificado (nunca lanza).
  const replyAction = (t: string): PostbackAction => replyPostback(t);
  if (picked.length > 0) content.Suggestions = picked.map((t) => reply(t, replyAction(t)));
  if (picked.length === 0) return { content, fallbackText: smsText(body), kind: 'text' };

  const menu = buildSmsMenu<PostbackAction>(
    {
      header: body,
      options: picked.slice(0, MAX_SMS_OPTIONS).map((t) => ({ label: t, value: replyAction(t) })),
      footer: (n) => `${c.replyPrompt(n)}.`,
    },
    c.smsOptionLine,
  );
  return { content, fallbackText: menu.text, kind: 'text', smsOptions: menu.values };
}

/**
 * Caso 1: carrusel de especialistas verificados (2 a 10 tarjetas). Con un solo
 * provider se manda una rich card (el carrusel exige minimo 2); sin providers, texto.
 */
export function providerCarousel(providers: Provider[], intro?: string, opts: TemplateOptions = {}): OutboundMessage {
  const c = copyFor(opts.locale);
  if (providers.length === 0) return textMessage(c.noProviders, [], opts);

  const shown = providers.slice(0, LIMITS.carouselCards);
  const menu = buildSmsMenu<PostbackAction>(
    {
      header: intro ?? c.carouselIntro,
      options: shown
        .slice(0, MAX_SMS_OPTIONS)
        .map((p) => ({ label: c.smsProviderLine(p.name, rating(p)), value: { a: 'select_provider', p: p.providerId } })),
      footer: (n) => `${c.replyPrompt(n)} ${c.smsPickProvider}`,
    },
    c.smsOptionLine,
  );

  const content: RcsMessageContent =
    shown.length >= LIMITS.carouselCardsMin
      ? { Content: { Carousel: { CardWidth: 'MEDIUM', CardContents: shown.map((p) => providerCardContent(p, c)) } } }
      : { Content: { RichCard: { CardOrientation: 'VERTICAL', CardContent: providerCardContent(shown[0], c) } } };

  return {
    content,
    fallbackText: menu.text,
    kind: shown.length >= LIMITS.carouselCardsMin ? 'provider_carousel' : 'provider_card',
    smsOptions: menu.values,
  };
}

/** Caso 1: disponibilidad como respuestas sugeridas (maximo MAX_SLOT_SUGGESTIONS). */
export function slotOptions(providerName: string, slots: Slot[], opts: TemplateOptions = {}): OutboundMessage {
  const c = copyFor(opts.locale);
  const tz = opts.timeZone ?? DEFAULT_TZ;
  const open = slots.filter((s) => s.available !== false).slice(0, MAX_SLOT_SUGGESTIONS);
  if (open.length === 0) return textMessage(c.noSlots(providerName), [], opts);

  const body = c.slotsBody(providerName);
  const label = (s: Slot) => formatSlot(s.startsAt, tz, opts.locale);
  const action = (s: Slot): PostbackAction => ({ a: 'select_slot', p: s.providerId, s: s.slotId });
  const menu = buildSmsMenu<PostbackAction>(
    {
      header: body,
      options: open.map((s) => ({ label: label(s), value: action(s) })),
      footer: (n) => `${c.replyPrompt(n)} ${c.smsPickSlot}`,
    },
    c.smsOptionLine,
  );
  return {
    content: {
      Content: { TextMessage: { Body: body } },
      Suggestions: open.map((s) => reply(label(s), action(s))),
    },
    fallbackText: menu.text,
    kind: 'slot_options',
    smsOptions: menu.values,
  };
}

/** Caso 1: confirmacion de la reserva, con "agregar al calendario". */
export function bookingConfirmation(appointment: Appointment, provider: Provider, opts: TemplateOptions = {}): OutboundMessage {
  const c = copyFor(opts.locale);
  const when = formatSlot(appointment.startsAt, opts.timeZone ?? DEFAULT_TZ, opts.locale);
  const ap = appointment.appointmentId;
  // `p` en reprogramar: el agente puede no tener el turno en memoria (sesion nueva).
  const reschedule: PostbackAction = { a: 'reschedule', ap, p: appointment.providerId };
  const start = new Date(appointment.startsAt);
  const end = new Date(start.getTime() + (opts.durationMinutes ?? 30) * 60_000);

  // Con fecha invalida no se ofrece "agregar al calendario" (un Date invalido rompe el request).
  const calendar: RcsSuggestedAction[] = [];
  if (isValidDate(start)) {
    calendar.push({
      // VERIFICAR: StartTime/EndTime viajan como timestamp del SDK (Date); la doc muestra ISO 8601 UTC.
      CreateCalendarEvent: {
        Text: truncate(c.addToCalendar, LIMITS.suggestionText),
        PostbackData: encodePostback({ a: 'add_calendar', ap }),
        Title: truncate(c.calendarTitle(provider.name), LIMITS.calendarTitle),
        StartTime: start,
        EndTime: end,
        Description: truncate(c.calendarDescription(ap), LIMITS.calendarDescription),
      },
    });
  }
  const suggestions: RcsSuggestedAction[] = [
    ...calendar,
    reply(c.reschedule, reschedule),
    reply(c.cancel, { a: 'cancel', ap }),
  ];

  const menu = buildSmsMenu<PostbackAction>(
    {
      header: c.smsBooked(provider.name, when, ap),
      options: [
        { label: c.reschedule, value: reschedule },
        { label: c.cancel, value: { a: 'cancel', ap } },
      ],
      footer: (n) => `${c.replyPrompt(n)}.`,
    },
    c.smsOptionLine,
  );

  return {
    content: {
      Content: {
        RichCard: {
          CardOrientation: 'VERTICAL',
          CardContent: {
            Title: truncate(c.bookedTitle(provider.name), LIMITS.cardTitle),
            Description: truncate(c.bookedDescription(when, ap), LIMITS.cardDescription),
            Media: cardMedia(provider.imageUrl, 'SHORT'),
            Suggestions: limitSuggestions(suggestions, LIMITS.suggestionsPerCard),
          },
        },
      },
    },
    fallbackText: menu.text,
    kind: 'booking_confirmation',
    smsOptions: menu.values,
  };
}

/** Checklist previo a la visita (en-US). La version es-US esta en copy.ts. */
export const PRE_VISIT_CHECKLIST = copyFor('en-US').checklist;

/** Caso 2: recordatorio T-48h / T-24h con confirmar, reprogramar y cancelar. */
export function reminderCard(
  appointment: Appointment,
  provider: Provider,
  kind: ReminderKind,
  opts: TemplateOptions = {},
): OutboundMessage {
  const c = copyFor(opts.locale);
  const when = formatSlot(appointment.startsAt, opts.timeZone ?? DEFAULT_TZ, opts.locale);
  const lead = c.reminderLead(kind);
  const ap = appointment.appointmentId;
  const checklist = c.checklist.map((item) => `- ${item}`).join('\n');
  // Mismo orden en RCS y SMS: 1 confirmar, 2 reprogramar, 3 cancelar (resolveSmsReply).
  const actions: Array<{ label: string; value: PostbackAction }> = [
    { label: c.confirm, value: { a: 'confirm', ap, k: kind } },
    // `p` (providerId): el recordatorio llega 24 o 48 h despues, a una sesion nueva del agente.
    { label: c.reschedule, value: { a: 'reschedule', ap, p: appointment.providerId, k: kind } },
    { label: c.cancel, value: { a: 'cancel', ap, k: kind } },
  ];

  const menu = buildSmsMenu<PostbackAction>(
    {
      header: c.smsReminder(provider.name, lead, when),
      options: actions,
      footer: (n) => `${c.replyPrompt(n)}.`,
      trailer: c.smsChecklist,
    },
    c.smsOptionLine,
  );

  return {
    content: {
      Content: {
        RichCard: {
          CardOrientation: 'VERTICAL',
          CardContent: {
            Title: truncate(c.reminderTitle(provider.name, lead), LIMITS.cardTitle),
            Description: truncate(`${when}\n\n${c.beforeYouGo}\n${checklist}`, LIMITS.cardDescription),
            Suggestions: limitSuggestions(
              actions.map((a) => reply(a.label, a.value)),
              LIMITS.suggestionsPerCard,
            ),
          },
        },
      },
    },
    fallbackText: menu.text,
    kind: 'reminder',
    smsOptions: menu.values,
  };
}
