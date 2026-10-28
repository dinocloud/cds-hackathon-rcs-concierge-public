/**
 * Validacion unica de CHANNEL_MODE: la usan la config de CDK (`infra/config/dev.ts`) y la
 * Lambda (`channelModeFromEnv`), asi un valor invalido falla igual en el synth y en runtime.
 * - Vacio o ausente: `rcs`.
 * - No distingue mayusculas ni espacios (`SMS`, ` Rcs ` son validos).
 * - Cualquier otro valor lanza un error (fail fast).
 */
export type ChannelMode = 'rcs' | 'sms';

export function parseChannelMode(value: string | undefined): ChannelMode {
  const mode = (value ?? '').trim().toLowerCase();
  if (mode === '') return 'rcs';
  if (mode === 'rcs' || mode === 'sms') return mode;
  throw new Error(`CHANNEL_MODE invalido: "${value}" (valores validos: rcs, sms)`);
}
