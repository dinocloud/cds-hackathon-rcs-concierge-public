/**
 * Textos de las plantillas por idioma (owner: Leo). El default es en-US, el
 * mismo locale que manda hoy el router. Los textos SMS se pasan por toGsm7
 * antes de enviarse, asi que aca pueden llevar tildes.
 */
import type { ReminderKind } from '../contracts';

export type TemplateLocale = 'en-US' | 'es-US';

export interface TemplateCopy {
  carouselIntro: string;
  noProviders: string;
  verified: string;
  providerDescription(specialty: string, city: string, rating: string, reviews: number): string;
  seeAvailability: string;
  viewProfile: string;
  smsProviderLine(name: string, rating: string): string;
  smsPickProvider: string;
  slotsBody(providerName: string): string;
  noSlots(providerName: string): string;
  smsPickSlot: string;
  bookedTitle(providerName: string): string;
  bookedDescription(when: string, ref: string): string;
  smsBooked(providerName: string, when: string, ref: string): string;
  addToCalendar: string;
  calendarTitle(providerName: string): string;
  calendarDescription(ref: string): string;
  confirm: string;
  reschedule: string;
  cancel: string;
  reminderLead(kind: ReminderKind): string;
  reminderTitle(providerName: string, lead: string): string;
  beforeYouGo: string;
  checklist: readonly string[];
  smsReminder(providerName: string, lead: string, when: string): string;
  smsChecklist: string;
  /** "Reply 1, 2 or 3" segun la cantidad de opciones. */
  replyPrompt(n: number): string;
  /** Linea de una opcion del menu SMS numerado: (1, "Confirm") da "1) Confirm". */
  smsOptionLine(n: number, label: string): string;
}

const EN: TemplateCopy = {
  carouselIntro: 'Top verified providers:',
  noProviders: "I couldn't find providers for that search. Try another procedure or city.",
  verified: 'Verified',
  providerDescription: (specialty, city, rating, reviews) => `${specialty} in ${city}\n${rating}/5 from ${reviews} reviews`,
  seeAvailability: 'See availability',
  viewProfile: 'View profile',
  smsProviderLine: (name, rating) => `${name}, ${rating}/5`,
  smsPickProvider: 'to see times.',
  slotsBody: (providerName) => `Here's when ${providerName} can see you for a consult:`,
  noSlots: (providerName) => `${providerName} has no open times this week. Want to try another provider?`,
  smsPickSlot: 'to book.',
  bookedTitle: (providerName) => `You're booked with ${providerName}`,
  bookedDescription: (when, ref) => `${when}. We'll remind you 48 h and 24 h before. Ref ${ref}.`,
  smsBooked: (providerName, when, ref) => `Booked with ${providerName}, ${when}. Ref ${ref}.`,
  addToCalendar: 'Add to calendar',
  calendarTitle: (providerName) => `Consult with ${providerName}`,
  calendarDescription: (ref) => `Booked via the appointment concierge (demo). Ref ${ref}.`,
  confirm: 'Confirm',
  reschedule: 'Reschedule',
  cancel: 'Cancel',
  reminderLead: (kind) => (kind === 'T48' ? 'in 2 days' : 'tomorrow'),
  reminderTitle: (providerName, lead) => `Your consult with ${providerName} is ${lead}`,
  beforeYouGo: 'Before you go:',
  checklist: ['Bring a photo ID', 'Write down your questions', 'List current medications for the clinic'],
  smsReminder: (providerName, lead, when) => `Reminder: your consult with ${providerName} is ${lead}, ${when}.`,
  smsChecklist: 'Bring a photo ID, your questions and your medication list.',
  replyPrompt: (n) => {
    if (n <= 1) return 'Reply 1';
    if (n === 2) return 'Reply 1 or 2';
    if (n === 3) return 'Reply 1, 2 or 3';
    return `Reply 1 to ${n}`;
  },
  smsOptionLine: (n, label) => `${n}) ${label}`,
};

const ES: TemplateCopy = {
  carouselIntro: 'Especialistas verificados:',
  noProviders: 'No encontré especialistas para esa búsqueda. Prueba con otro procedimiento o ciudad.',
  verified: 'Verificado',
  providerDescription: (specialty, city, rating, reviews) => `${specialty} en ${city}\n${rating}/5 en ${reviews} reseñas`,
  seeAvailability: 'Ver horarios',
  viewProfile: 'Ver perfil',
  smsProviderLine: (name, rating) => `${name}, ${rating}/5`,
  smsPickProvider: 'para ver horarios.',
  slotsBody: (providerName) => `Estos son los horarios de ${providerName} para la consulta:`,
  noSlots: (providerName) => `${providerName} no tiene horarios libres esta semana. ¿Probamos con otro especialista?`,
  smsPickSlot: 'para reservar.',
  bookedTitle: (providerName) => `Turno reservado con ${providerName}`,
  bookedDescription: (when, ref) => `${when}. Te recordamos 48 h y 24 h antes. Ref ${ref}.`,
  smsBooked: (providerName, when, ref) => `Turno reservado con ${providerName}, ${when}. Ref ${ref}.`,
  addToCalendar: 'Agregar al calendario',
  calendarTitle: (providerName) => `Consulta con ${providerName}`,
  calendarDescription: (ref) => `Reservado con el concierge de turnos (demo). Ref ${ref}.`,
  confirm: 'Confirmar',
  reschedule: 'Reprogramar',
  cancel: 'Cancelar',
  reminderLead: (kind) => (kind === 'T48' ? 'en 2 días' : 'mañana'),
  reminderTitle: (providerName, lead) => `Tu consulta con ${providerName} es ${lead}`,
  beforeYouGo: 'Antes de ir:',
  checklist: ['Lleva una identificación con foto', 'Anota tus preguntas', 'Lista tus medicamentos actuales'],
  smsReminder: (providerName, lead, when) => `Recordatorio: tu consulta con ${providerName} es ${lead}, ${when}.`,
  smsChecklist: 'Lleva identificación con foto, tus preguntas y tu lista de medicamentos.',
  replyPrompt: (n) => {
    if (n <= 1) return 'Responde 1';
    if (n === 2) return 'Responde 1 o 2';
    if (n === 3) return 'Responde 1, 2 o 3';
    return `Responde del 1 al ${n}`;
  },
  smsOptionLine: (n, label) => `${n}) ${label}`,
};

export function copyFor(locale: TemplateLocale = 'en-US'): TemplateCopy {
  return locale === 'es-US' ? ES : EN;
}

/** Locale de Intl para fechas. */
export function intlLocale(locale: TemplateLocale = 'en-US'): string {
  return locale === 'es-US' ? 'es-US' : 'en-US';
}
