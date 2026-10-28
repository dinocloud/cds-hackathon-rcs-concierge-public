import { createHmac } from 'crypto';

/**
 * Identidad del paciente sin PII: HMAC-SHA256(sal, telefono E.164).
 * - patientRef: 64 hex, se usa como actorId de Memory y en las tools.
 * - sessionId: "rs-sess-" + patientRef (72 caracteres, AgentCore pide >= 33).
 * La sal vive en Secrets Manager (MessagingStack), nunca en el repo.
 */
export function patientRef(phoneE164: string, salt: string): string {
  if (!salt) throw new Error('Falta la sal del hash de telefono');
  return createHmac('sha256', salt).update(normalizePhone(phoneE164)).digest('hex');
}

export function sessionIdFor(ref: string): string {
  const id = `rs-sess-${ref}`;
  if (id.length < 33) throw new Error('El session id de AgentCore debe tener al menos 33 caracteres');
  return id;
}

export function normalizePhone(phone: string): string {
  const digits = phone.replace(/[^\d+]/g, '');
  return digits.startsWith('+') ? digits : `+${digits}`;
}

/** Para logs: nunca loguear el telefono completo. */
export function maskPhone(phone: string): string {
  const p = normalizePhone(phone);
  return `${p.slice(0, 3)}******${p.slice(-2)}`;
}
