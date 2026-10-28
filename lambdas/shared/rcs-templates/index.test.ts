import type { RcsSuggestedAction } from '@aws-sdk/client-pinpoint-sms-voice-v2';
import { syntheticProviders, syntheticSlots } from '../../tools/synthetic-data';
import {
  LIMITS,
  MAX_SLOT_SUGGESTIONS,
  type OutboundMessage,
  bookingConfirmation,
  charLength,
  decodePostback,
  formatSlot,
  gsm7Length,
  isGsm7,
  providerCarousel,
  reminderCard,
  resolveSmsReply,
  slotOptions,
  smsKeywordToPostback,
  smsSegments,
  textMessage,
} from './index';
import type { Appointment, Provider } from '../contracts';

const allProviders = syntheticProviders();
const providers = allProviders.filter((p) => p.city === 'Miami');
const slots = syntheticSlots(providers[0].providerId, new Date('2026-10-26T12:00:00Z'));

const appt: Appointment = {
  appointmentId: 'apt_test',
  patientRef: 'ref',
  providerId: providers[0].providerId,
  slotId: 's',
  startsAt: '2026-10-29T14:00:00.000Z',
  status: 'BOOKED',
  reminderScheduleNames: [],
  createdAt: '',
  updatedAt: '',
};

const suggestionText = (s: RcsSuggestedAction) =>
  s.Reply?.Text ?? s.OpenUrl?.Text ?? s.CreateCalendarEvent?.Text ?? s.DialPhone?.Text ?? '';
const suggestionPostback = (s: RcsSuggestedAction) =>
  s.Reply?.PostbackData ?? s.OpenUrl?.PostbackData ?? s.CreateCalendarEvent?.PostbackData ?? '';

/** Invariantes de limites documentados para cualquier mensaje. */
function expectWithinLimits(msg: OutboundMessage) {
  const content = msg.content.Content;
  const cards = [
    ...(content?.Carousel?.CardContents ?? []),
    ...(content?.RichCard?.CardContent ? [content.RichCard.CardContent] : []),
  ];
  if (content?.Carousel) {
    expect(cards.length).toBeGreaterThanOrEqual(LIMITS.carouselCardsMin);
    expect(cards.length).toBeLessThanOrEqual(LIMITS.carouselCards);
  }
  const all: RcsSuggestedAction[] = [...(msg.content.Suggestions ?? [])];
  expect(all.length).toBeLessThanOrEqual(LIMITS.suggestionsPerMessage);
  for (const card of cards) {
    expect(charLength(card.Title ?? '')).toBeLessThanOrEqual(LIMITS.cardTitle);
    expect(charLength(card.Description ?? '')).toBeLessThanOrEqual(LIMITS.cardDescription);
    expect((card.Suggestions ?? []).length).toBeLessThanOrEqual(LIMITS.suggestionsPerCard);
    all.push(...(card.Suggestions ?? []));
  }
  for (const s of all) {
    expect(charLength(suggestionText(s))).toBeGreaterThan(0);
    expect(charLength(suggestionText(s))).toBeLessThanOrEqual(LIMITS.suggestionText);
    expect(suggestionPostback(s).length).toBeLessThanOrEqual(LIMITS.postbackData);
  }
  // SMS: GSM-7, dentro del tope propio (3 segmentos) y del limite del fallback.
  expect(isGsm7(msg.fallbackText)).toBe(true);
  expect(gsm7Length(msg.fallbackText)).toBeLessThanOrEqual(LIMITS.smsBody);
  expect(smsSegments(msg.fallbackText)).toBeLessThanOrEqual(3);
}

describe('rcs-templates: carrusel de providers', () => {
  it('arma un carrusel con tarjetas, "See availability" y fallback SMS numerado', () => {
    const msg = providerCarousel(providers);
    const cards = msg.content.Content?.Carousel?.CardContents ?? [];
    expect(msg.kind).toBe('provider_carousel');
    expect(cards.length).toBe(Math.min(providers.length, LIMITS.carouselCards));
    expect(cards[0].Title).toContain(providers[0].name);
    expect(cards[0].Description).toContain(providers[0].specialty);
    expect(cards[0].Description).toContain(`${providers[0].rating.toFixed(1)}/5`);
    expect(cards[0].Media?.FileUrl).toBe(providers[0].imageUrl);
    expect(cards[0].Suggestions?.[0].Reply?.Text).toBe('See availability');
    expect(decodePostback(cards[0].Suggestions?.[0].Reply?.PostbackData ?? '')).toEqual({
      a: 'select_provider',
      p: providers[0].providerId,
    });
    expect(cards[0].Suggestions?.[1].OpenUrl?.Url).toBe(providers[0].profileUrl);
    expect(msg.fallbackText).toMatch(/^Top verified providers:\n1\) /);
    expect(msg.fallbackText).toContain('Reply 1 to 5 to see times.');
    expect(msg.smsOptions?.[0]).toEqual({ a: 'select_provider', p: providers[0].providerId });
    expectWithinLimits(msg);
  });

  it('en es-US usa "Ver horarios" y "Responde 1, 2 o 3"', () => {
    const msg = providerCarousel(providers.slice(0, 3), undefined, { locale: 'es-US' });
    const cards = msg.content.Content?.Carousel?.CardContents ?? [];
    expect(cards[0].Suggestions?.[0].Reply?.Text).toBe('Ver horarios');
    expect(msg.fallbackText).toContain('Responde 1, 2 o 3 para ver horarios.');
    expectWithinLimits(msg);
  });

  it('corta a 10 tarjetas y a 5 opciones SMS', () => {
    const msg = providerCarousel(allProviders); // 18 providers
    expect(msg.content.Content?.Carousel?.CardContents).toHaveLength(LIMITS.carouselCards);
    expect(msg.smsOptions).toHaveLength(5);
    expectWithinLimits(msg);
  });

  it('con un solo provider manda rich card (el carrusel pide minimo 2) y sin providers, texto', () => {
    const one = providerCarousel([providers[0]]);
    expect(one.kind).toBe('provider_card');
    expect(one.content.Content?.RichCard?.CardOrientation).toBe('VERTICAL');
    expect(one.content.Content?.Carousel).toBeUndefined();
    expectWithinLimits(one);
    const none = providerCarousel([]);
    expect(none.content.Content?.TextMessage?.Body).toMatch(/couldn't find/);
  });

  it('recorta titulos y descripciones largos y omite media con URL invalida', () => {
    const long: Provider = {
      ...providers[0],
      name: `Dr. ${'Longname '.repeat(40)}`,
      specialty: 'S'.repeat(2500),
      imageUrl: 'http://insecure.example/img.png',
      profileUrl: 'http://insecure.example/profile',
    };
    const msg = providerCarousel([long, providers[1]]);
    const card = msg.content.Content?.Carousel?.CardContents?.[0];
    expect(charLength(card?.Title ?? '')).toBe(LIMITS.cardTitle);
    expect(charLength(card?.Description ?? '')).toBe(LIMITS.cardDescription);
    expect(card?.Media).toBeUndefined();
    expect(card?.Suggestions).toHaveLength(1); // sin OpenUrl si no es https
    expectWithinLimits(msg);
  });
});

describe('rcs-templates: horarios', () => {
  it('limita los slots a 4 respuestas sugeridas de 25 caracteres con postback select_slot', () => {
    const msg = slotOptions(providers[0].name, slots);
    expect(msg.content.Suggestions).toHaveLength(MAX_SLOT_SUGGESTIONS);
    const first = decodePostback(msg.content.Suggestions?.[0].Reply?.PostbackData ?? '');
    expect(first).toEqual({ a: 'select_slot', p: slots[0].providerId, s: slots[0].slotId });
    expect(msg.fallbackText).toContain('Reply 1 to 4 to book.');
    expect(resolveSmsReply('2', msg.smsOptions)).toEqual({ a: 'select_slot', p: slots[1].providerId, s: slots[1].slotId });
    expectWithinLimits(msg);
  });

  it('formato corto en es-US entra en una sugerencia y no lleva espacios raros', () => {
    expect(formatSlot('2026-10-29T14:00:00.000Z')).toBe('Thu, Oct 29, 10:00 AM');
    expect(formatSlot('2026-10-29T14:00:00.000Z', 'America/New_York', 'es-US')).toBe('jue 29/10, 10:00');
    expect(() => formatSlot('2026-13-45')).not.toThrow();
    expect(formatSlot('not-a-date', 'America/New_York', 'es-US')).toBe('not-a-date');
    const msg = slotOptions(providers[0].name, slots, { locale: 'es-US' });
    expect(msg.fallbackText).toContain('Responde del 1 al 4 para reservar.');
    expectWithinLimits(msg);
  });

  it('ignora slots no disponibles y sin slots responde texto', () => {
    const msg = slotOptions(providers[0].name, [{ ...slots[0], available: false }, slots[1]]);
    expect(msg.content.Suggestions).toHaveLength(1);
    expect(msg.fallbackText).toContain('Reply 1 to book.');
    const none = slotOptions(providers[0].name, []);
    expect(none.content.Content?.TextMessage?.Body).toMatch(/no open times/);
  });
});

describe('rcs-templates: confirmacion', () => {
  it('rich card con agregar al calendario, reprogramar y cancelar', () => {
    const msg = bookingConfirmation(appt, providers[0]);
    const card = msg.content.Content?.RichCard?.CardContent;
    expect(card?.Title).toBe(`You're booked with ${providers[0].name}`);
    const cal = card?.Suggestions?.[0].CreateCalendarEvent;
    expect(cal?.StartTime?.toISOString()).toBe('2026-10-29T14:00:00.000Z');
    expect(cal?.EndTime?.toISOString()).toBe('2026-10-29T14:30:00.000Z');
    expect(charLength(cal?.Title ?? '')).toBeLessThanOrEqual(LIMITS.calendarTitle);
    expect(charLength(cal?.Description ?? '')).toBeLessThanOrEqual(LIMITS.calendarDescription);
    expect(decodePostback(cal?.PostbackData ?? '')).toEqual({ a: 'add_calendar', ap: 'apt_test' });
    expect(card?.Suggestions?.slice(1).map((s) => decodePostback(s.Reply?.PostbackData ?? '')?.a)).toEqual([
      'reschedule',
      'cancel',
    ]);
    expect(msg.fallbackText).toContain('Ref apt_test.');
    expect(msg.fallbackText).toContain('1) Reschedule\n2) Cancel\nReply 1 or 2.');
    expect(resolveSmsReply('2', msg.smsOptions)).toEqual({ a: 'cancel', ap: 'apt_test' });
    expectWithinLimits(msg);
  });

  it('menu SMS de la confirmacion: 1 reprograma y 2 cancela (los numeros no pasan por smsKeywordToPostback)', () => {
    const msg = bookingConfirmation(appt, providers[0]);
    expect(resolveSmsReply('1', msg.smsOptions)).toEqual({ a: 'reschedule', ap: 'apt_test', p: appt.providerId });
    expect(resolveSmsReply('2)', msg.smsOptions)).toEqual({ a: 'cancel', ap: 'apt_test' });
    expect(resolveSmsReply('3', msg.smsOptions)).toBeUndefined();
    expect(smsKeywordToPostback('1', 'apt_test')).toBeUndefined();
    expect(smsKeywordToPostback('2', 'apt_test')).toBeUndefined();
  });

  it('con un startsAt invalido no tira RangeError y omite agregar al calendario', () => {
    const msg = bookingConfirmation({ ...appt, startsAt: 'not-a-date' }, providers[0]);
    const sugg = msg.content.Content?.RichCard?.CardContent?.Suggestions ?? [];
    expect(sugg.some((s) => s.CreateCalendarEvent)).toBe(false);
    expect(sugg.map((s) => decodePostback(s.Reply?.PostbackData ?? '')?.a)).toEqual(['reschedule', 'cancel']);
    expectWithinLimits(msg);
  });

  it('respeta durationMinutes para el fin del evento', () => {
    const msg = bookingConfirmation(appt, providers[0], { durationMinutes: 60 });
    const cal = msg.content.Content?.RichCard?.CardContent?.Suggestions?.[0].CreateCalendarEvent;
    expect(cal?.EndTime?.toISOString()).toBe('2026-10-29T15:00:00.000Z');
  });
});

describe('rcs-templates: recordatorio', () => {
  it('T-48h con confirmar, reprogramar, cancelar y checklist', () => {
    const msg = reminderCard(appt, providers[0], 'T48');
    const card = msg.content.Content?.RichCard?.CardContent;
    const actions = card?.Suggestions?.map((s) => decodePostback(s.Reply?.PostbackData ?? ''));
    expect(actions?.map((a) => a?.a)).toEqual(['confirm', 'reschedule', 'cancel']);
    expect(actions?.[0]).toEqual({ a: 'confirm', ap: 'apt_test', k: 'T48' });
    expect(card?.Title).toContain('in 2 days');
    expect(card?.Description).toContain('Before you go:\n- Bring a photo ID');
    expect(msg.fallbackText).toMatch(/in 2 days/);
    expect(msg.fallbackText).toContain('1) Confirm\n2) Reschedule\n3) Cancel\nReply 1, 2 or 3.');
    expect(msg.fallbackText).toContain('Bring a photo ID');
    expectWithinLimits(msg);
  });

  it('reprogramar lleva ap y p (providerId) en RCS y en el menu SMS: sirve en una sesion nueva', () => {
    const msg = reminderCard(appt, providers[0], 'T24');
    const data = msg.content.Content?.RichCard?.CardContent?.Suggestions?.[1].Reply?.PostbackData ?? '';
    expect(data).toBe(`a=reschedule&ap=apt_test&p=${encodeURIComponent(appt.providerId)}&k=T24`);
    expect(decodePostback(data)).toEqual({ a: 'reschedule', ap: 'apt_test', p: appt.providerId, k: 'T24' });
    expect(resolveSmsReply('2', msg.smsOptions)).toEqual({ a: 'reschedule', ap: 'apt_test', p: appt.providerId, k: 'T24' });
    const booked = bookingConfirmation(appt, providers[0]).content.Content?.RichCard?.CardContent?.Suggestions ?? [];
    const reschedule = booked.map((s) => decodePostback(s.Reply?.PostbackData ?? '')).find((a) => a?.a === 'reschedule');
    expect(reschedule).toEqual({ a: 'reschedule', ap: 'apt_test', p: appt.providerId });
  });

  it('reprogramar sin p (postbacks viejos) se sigue decodificando igual', () => {
    expect(decodePostback('a=reschedule&ap=apt_1&k=T48')).toEqual({ a: 'reschedule', ap: 'apt_1', k: 'T48' });
    expect(decodePostback('a=reschedule&ap=apt_1')).toEqual({ a: 'reschedule', ap: 'apt_1' });
    expect(decodePostback('a=reschedule&p=prov_1')).toBeUndefined();
    expect(smsKeywordToPostback('R', 'apt_1', 'prov_1')).toEqual({ a: 'reschedule', ap: 'apt_1', p: 'prov_1' });
    expect(smsKeywordToPostback('C', 'apt_1', 'prov_1')).toEqual({ a: 'confirm', ap: 'apt_1' });
  });

  it('T-24h en es-US: "mañana" en RCS y SMS GSM-7', () => {
    const msg = reminderCard(appt, providers[0], 'T24', { locale: 'es-US' });
    expect(msg.content.Content?.RichCard?.CardContent?.Title).toContain('mañana');
    expect(msg.fallbackText).toContain('Responde 1, 2 o 3.');
    expect(msg.fallbackText).toContain('identificacion'); // sin tilde: GSM-7
    expectWithinLimits(msg);
  });

  it('las respuestas SMS 1/2/3 y C/R/X resuelven al mismo postback', () => {
    const msg = reminderCard(appt, providers[0], 'T24');
    expect(resolveSmsReply('3', msg.smsOptions)).toEqual({ a: 'cancel', ap: 'apt_test', k: 'T24' });
    expect(smsKeywordToPostback(' x ', 'apt_test')).toEqual({ a: 'cancel', ap: 'apt_test' });
    expect(smsKeywordToPostback('C.', 'apt_test')).toEqual({ a: 'confirm', ap: 'apt_test' });
    expect(smsKeywordToPostback('Reprogramar', 'apt_test')).toEqual({ a: 'reschedule', ap: 'apt_test' });
    expect(smsKeywordToPostback('sí', 'apt_test')).toEqual({ a: 'confirm', ap: 'apt_test' });
    expect(smsKeywordToPostback('1', 'apt_test')).toBeUndefined();
    expect(smsKeywordToPostback('hola', 'apt_test')).toBeUndefined();
  });

  it('si el provider tiene un nombre enorme, el SMS sigue en 3 segmentos y conserva las opciones', () => {
    const msg = reminderCard(appt, { ...providers[0], name: 'Dr. ' + 'Verylongname '.repeat(20) }, 'T48');
    expect(msg.smsOptions).toHaveLength(3);
    expectWithinLimits(msg);
  });
});

describe('rcs-templates: texto', () => {
  it('texto sin sugerencias: SMS igual al body', () => {
    const msg = textMessage('Hi! How can I help?');
    expect(msg.content.Suggestions).toBeUndefined();
    expect(msg.fallbackText).toBe('Hi! How can I help?');
    expect(msg.smsOptions).toBeUndefined();
  });

  it('texto con sugerencias: maximo 11, recortadas a 25 caracteres y menu SMS', () => {
    const many = Array.from({ length: 15 }, (_, i) => `Option number ${i + 1} with a long label`);
    const msg = textMessage('Pick one:', many);
    expect(msg.content.Suggestions).toHaveLength(LIMITS.suggestionsPerMessage);
    expect(msg.smsOptions?.[0]).toEqual({ a: 'reply', t: many[0] });
    expectWithinLimits(msg);
  });

  it('sugerencia del LLM de mas de 2048 caracteres: recorta el postback en vez de lanzar', () => {
    const long = 'x'.repeat(3000);
    const msg = textMessage('Pick one:', [long, 'ok']);
    const data = msg.content.Suggestions?.[0].Reply?.PostbackData ?? '';
    expect(decodePostback(data)).toEqual({ a: 'reply', t: 'x'.repeat(LIMITS.replyPostbackText) });
    expect(msg.smsOptions?.[0]).toEqual({ a: 'reply', t: 'x'.repeat(LIMITS.replyPostbackText) });
    expectWithinLimits(msg);
  });

  it.each([
    ['300 emojis', '\u{1F600}'.repeat(300)],
    ['300 caracteres CJK', '\u4F60'.repeat(300)],
  ])('sugerencia con %s: recorta por largo codificado y no lanza', (_label, long) => {
    const msg = textMessage('Pick one:', [long, 'ok']);
    const data = msg.content.Suggestions?.[0].Reply?.PostbackData ?? '';
    expect(data.length).toBeLessThanOrEqual(LIMITS.postbackData);
    const decoded = decodePostback(data);
    expect(decoded?.a).toBe('reply');
    const t = decoded?.a === 'reply' ? decoded.t : '';
    expect(charLength(t)).toBeGreaterThan(0);
    expect(charLength(t)).toBeLessThan(LIMITS.replyPostbackText);
    expect(long.startsWith(t)).toBe(true);
    // Prefijo mas largo posible: un caracter mas ya no entra.
    const next = Array.from(long).slice(0, charLength(t) + 1).join('');
    expect(new URLSearchParams({ a: 'reply', t: next }).toString().length).toBeGreaterThan(LIMITS.postbackData);
    expect(msg.smsOptions?.[0]).toEqual(decoded);
    expectWithinLimits(msg);
  });

  it('normaliza el SMS a GSM-7 (comillas, elipsis, emojis)', () => {
    const msg = textMessage('It’s “done”… ✨');
    expect(msg.fallbackText).toBe('It\'s "done"... ?');
    expect(isGsm7(msg.fallbackText)).toBe(true);
  });
});
