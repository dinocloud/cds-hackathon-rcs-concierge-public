import { buildSmsMenu } from './sms';
import { clampTtl, charLength, truncate, LIMITS } from './limits';
import { gsm7Length, isGsm7, smsSegments, toGsm7, truncateGsm7 } from './gsm7';
import { decodePostback, encodePostback, isTelemetryOnlyAction, resolveSmsReply } from './postback';

describe('limits', () => {
  it('truncate cuenta code points y agrega elipsis', () => {
    expect(truncate('abcdef', 10)).toBe('abcdef');
    expect(truncate('abcdefghijkl', 5)).toBe('abcd…');
    expect(truncate('abcdefghijkl', 6, '...')).toBe('abc...');
    expect(charLength(truncate('😀'.repeat(30), 25))).toBe(25);
  });

  it('clampTtl acota a 1..172800 y usa default si no es numero', () => {
    expect(clampTtl(0)).toBe(1);
    expect(clampTtl(999999)).toBe(LIMITS.ttlMaxSeconds);
    expect(clampTtl(Number('abc'))).toBe(300);
    expect(clampTtl(60)).toBe(60);
  });
});

describe('gsm7', () => {
  it('detecta y normaliza caracteres fuera de GSM-7', () => {
    expect(isGsm7('Responde 1, 2 o 3. ¿Mañana? €')).toBe(true);
    expect(isGsm7('días')).toBe(false);
    expect(toGsm7('días, educación, ÚLTIMO')).toBe('dias, educacion, ULTIMO');
    expect(toGsm7('10:00 AM – ok')).toBe('10:00 AM - ok');
    expect(toGsm7('中')).toBe('?');
  });

  it('cuenta segmentos GSM-7 y UCS-2', () => {
    expect(smsSegments('')).toBe(0);
    expect(smsSegments('a'.repeat(160))).toBe(1);
    expect(smsSegments('a'.repeat(161))).toBe(2);
    expect(smsSegments('a'.repeat(459))).toBe(3);
    expect(smsSegments('á'.repeat(70))).toBe(1);
    expect(smsSegments('á'.repeat(71))).toBe(2);
    expect(gsm7Length('€[')).toBe(4);
  });

  it('truncateGsm7 mide en septetos y no parte un extendido', () => {
    expect(truncateGsm7('abc', 3)).toBe('abc');
    expect(truncateGsm7('€€€', 4, '')).toBe('€€');
    expect(truncateGsm7('€€€', 5, '')).toBe('€€');
    expect(gsm7Length(truncateGsm7('[]'.repeat(100), 50))).toBeLessThanOrEqual(50);
    expect(truncateGsm7('abcdef', 5)).toBe('ab...');
    expect(truncateGsm7('abcdef', 2)).toBe('ab');
    expect(truncateGsm7('abcdef', 0)).toBe('');
  });
});

describe('postback', () => {
  it('codifica y decodifica postbacks, ignorando campos vacios', () => {
    const data = encodePostback({ a: 'select_slot', p: 'prov_1', s: 'prov_1#2026-10-29T14:00:00.000Z' });
    expect(decodePostback(data)).toEqual({ a: 'select_slot', p: 'prov_1', s: 'prov_1#2026-10-29T14:00:00.000Z' });
    expect(encodePostback({ a: 'confirm', ap: 'apt_1' })).toBe('a=confirm&ap=apt_1');
    expect(encodePostback({ a: 'confirm', ap: 'apt_1', k: 'T24' })).toBe('a=confirm&ap=apt_1&k=T24');
    expect(decodePostback('a=confirm&ap=apt_1&k=bogus')).toEqual({ a: 'confirm', ap: 'apt_1' });
    expect(decodePostback('a=view_profile&p=prov_1')).toEqual({ a: 'view_profile', p: 'prov_1' });
    expect(decodePostback('a=add_calendar&ap=apt_1')).toEqual({ a: 'add_calendar', ap: 'apt_1' });
    expect(decodePostback('a=unknown')).toBeUndefined();
    expect(decodePostback('a=select_slot&p=x')).toBeUndefined();
  });

  it('falla si el postback supera 2048 caracteres', () => {
    expect(() => encodePostback({ a: 'reply', t: 'x'.repeat(3000) })).toThrow(/2048/);
  });

  it('isTelemetryOnlyAction: solo view_profile y add_calendar', () => {
    expect(isTelemetryOnlyAction({ a: 'view_profile', p: 'prov_1' })).toBe(true);
    expect(isTelemetryOnlyAction(decodePostback('a=add_calendar&ap=apt_1'))).toBe(true);
    expect(isTelemetryOnlyAction('view_profile')).toBe(true);
    for (const a of ['select_provider', 'select_slot', 'confirm', 'reschedule', 'cancel', 'reply']) {
      expect(isTelemetryOnlyAction(a)).toBe(false);
    }
    expect(isTelemetryOnlyAction({ a: 'cancel', ap: 'apt_1' })).toBe(false);
    expect(isTelemetryOnlyAction(undefined)).toBe(false);
  });

  it('resolveSmsReply acepta "2", "#2", "2." y rechaza fuera de rango', () => {
    const options = [
      { a: 'reply' as const, t: 'uno' },
      { a: 'reply' as const, t: 'dos' },
    ];
    expect(resolveSmsReply('2', options)).toEqual(options[1]);
    expect(resolveSmsReply(' #1 ', options)).toEqual(options[0]);
    expect(resolveSmsReply('2.', options)).toEqual(options[1]);
    expect(resolveSmsReply('3', options)).toBeUndefined();
    expect(resolveSmsReply('0', options)).toBeUndefined();
    expect(resolveSmsReply('dos', options)).toBeUndefined();
    expect(resolveSmsReply('1', undefined)).toBeUndefined();
  });
});

describe('buildSmsMenu', () => {
  const line = (n: number, label: string) => `${n}) ${label}`;

  it('saca opciones del final hasta entrar en el tope, nunca corta una opcion', () => {
    const options = Array.from({ length: 5 }, (_, i) => ({ label: `Option ${i + 1} ${'x'.repeat(30)}`, value: i }));
    const menu = buildSmsMenu({ header: 'Pick:', options, footer: (n) => `Reply 1 to ${n}.`, maxChars: 120 }, line);
    expect(charLength(menu.text)).toBeLessThanOrEqual(120);
    expect(menu.values.length).toBeLessThan(5);
    expect(menu.text).toContain(`Reply 1 to ${menu.values.length}.`);
  });

  it('descarta el trailer antes que una opcion', () => {
    const options = [1, 2, 3].map((v) => ({ label: `Opt ${v}`, value: v }));
    const menu = buildSmsMenu(
      { header: 'H', options, footer: () => 'Reply.', trailer: 'T'.repeat(100), maxChars: 40 },
      line,
    );
    expect(menu.values).toEqual([1, 2, 3]);
    expect(menu.text).not.toContain('TTT');
  });

  it('mide el tope en septetos: los extendidos GSM-7 cuentan doble', () => {
    const options = [1, 2].map((v) => ({ label: `Opt ${v}`, value: v }));
    // 'Opt 1'/'Opt 2' + footer: con un header de 20 caracteres pero 40 septetos no entran las dos opciones.
    const header = '€'.repeat(20);
    const plain = buildSmsMenu({ header: 'a'.repeat(20), options, footer: () => 'R', maxChars: 40 }, line);
    expect(plain.values).toEqual([1, 2]);
    const menu = buildSmsMenu({ header, options, footer: () => 'R', maxChars: 40 }, line);
    expect(gsm7Length(menu.text)).toBeLessThanOrEqual(40);
    expect(menu.values.length).toBeLessThan(2);
  });

  it('si ni una opcion entra, recorta el encabezado', () => {
    const menu = buildSmsMenu(
      { header: 'H'.repeat(500), options: [{ label: 'Only', value: 1 }], footer: () => 'Reply 1.', maxChars: 60 },
      line,
    );
    expect(charLength(menu.text)).toBeLessThanOrEqual(60);
    expect(menu.values).toEqual([1]);
    expect(menu.text).toContain('1) Only');
  });
});
