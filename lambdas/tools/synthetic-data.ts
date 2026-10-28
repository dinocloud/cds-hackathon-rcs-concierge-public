/**
 * Datos 100% sinteticos (owner: Pablo). Ningun nombre, foto ni dato sale de
 * clientes ni de providers reales. Generacion deterministica: mismo seed, mismos datos.
 */
import type { Provider, Slot } from '../shared/contracts';

const CITIES = ['Miami', 'Austin', 'San Diego'] as const;

const PROVIDER_SEEDS: Array<Pick<Provider, 'name' | 'specialty' | 'procedures'>> = [
  { name: 'Dr. Ava Synth', specialty: 'Facial plastic surgeon', procedures: ['rhinoplasty', 'facelift'] },
  { name: 'Dr. Leo Mock', specialty: 'Plastic surgeon', procedures: ['rhinoplasty', 'tummy tuck'] },
  { name: 'Dr. Mia Sample', specialty: 'Dermatologist', procedures: ['botox', 'fillers'] },
  { name: 'Dr. Noah Demo', specialty: 'Facial plastic surgeon', procedures: ['rhinoplasty', 'blepharoplasty'] },
  { name: 'Glow Test Med Spa', specialty: 'Med spa', procedures: ['botox', 'fillers', 'laser'] },
  { name: 'Dr. Zoe Fixture', specialty: 'Plastic surgeon', procedures: ['tummy tuck', 'facelift'] },
];

/** Placeholder publico: imagen neutra, sin rostros reales. */
const IMAGE_URL = 'https://placehold.co/600x400/png?text=Synthetic+Provider';
const PROFILE_BASE = 'https://example.com/providers/';

export function syntheticProviders(): Provider[] {
  const providers: Provider[] = [];
  CITIES.forEach((city, ci) => {
    PROVIDER_SEEDS.forEach((seed, pi) => {
      const providerId = `prov_${city.toLowerCase().replace(/\s/g, '')}_${String(pi + 1).padStart(2, '0')}`;
      providers.push({
        providerId,
        ...seed,
        city,
        rating: Math.round((4.2 + ((pi * 7 + ci * 3) % 8) / 10) * 10) / 10,
        reviewCount: 40 + ((pi * 37 + ci * 11) % 260),
        verified: pi % 3 !== 2,
        imageUrl: IMAGE_URL,
        profileUrl: `${PROFILE_BASE}${providerId}`,
      });
    });
  });
  return providers;
}

/** Slots de 30 min, 3 por dia habil, para los proximos `days` dias desde `from`. */
export function syntheticSlots(providerId: string, from: Date, days = 7): Slot[] {
  const slots: Slot[] = [];
  const hours = [14, 16, 19]; // UTC: manana y tarde en hora de EE.UU.
  for (let d = 1; d <= days; d++) {
    const day = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + d));
    if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue;
    for (const h of hours) {
      const startsAt = new Date(day);
      startsAt.setUTCHours(h, 0, 0, 0);
      slots.push({
        slotId: `${providerId}#${startsAt.toISOString()}`,
        providerId,
        startsAt: startsAt.toISOString(),
        durationMinutes: 30,
        available: true,
      });
    }
  }
  return slots;
}
