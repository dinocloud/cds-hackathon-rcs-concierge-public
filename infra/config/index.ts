import { devConfig } from './dev';
import { EnvConfig } from './types';

const configs: Record<string, EnvConfig> = { dev: devConfig };

export function loadConfig(envName: string): EnvConfig {
  const cfg = configs[envName];
  if (!cfg) {
    throw new Error(`Ambiente desconocido "${envName}". Disponibles: ${Object.keys(configs).join(', ')}`);
  }
  return cfg;
}

export type { EnvConfig } from './types';
