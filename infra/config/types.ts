/**
 * Configuracion por ambiente. Nada de credenciales aca: los IDs de recursos
 * creados a mano (RCS agent, numero SMS) vienen de variables de entorno.
 */
export interface EnvConfig {
  /** Nombre corto del ambiente, se usa como prefijo de recursos. */
  readonly envName: string;
  /** Cuenta AWS. En synth local se usa una cuenta dummy. */
  readonly account: string;
  readonly region: string;
  /** Prefijo comun de nombres de recursos. */
  readonly prefix: string;
  readonly messaging: {
    /** ID del RCS agent registrado a mano (scripts/register-rcs-agent.md). */
    readonly rcsAgentId: string;
    /**
     * PhoneNumberId (`phone-...`), PoolId (`pool-...`) o ARN de uno de los dos. El tipo de ARN
     * de IAM se deduce del prefijo (`originationIdentityArn` en infra/lib/naming.ts).
     */
    readonly smsOriginationIdentity: string;
    /** Protect configuration opcional (limita paises, evita SMS pumping). */
    readonly protectConfigurationId?: string;
    /** TTL en segundos del intento RCS antes de caer a SMS (1 a 172800). */
    readonly rcsTtlSeconds: number;
    /**
     * Canal de respuesta del inbound-router: `rcs` (SendRcsMessage con fallback a SMS) o
     * `sms` (solo SendTextMessage, plan B del ADR 001).
     */
    readonly channelMode: 'rcs' | 'sms';
  };
  readonly agent: {
    readonly modelId: string;
    /** Dias de retencion de eventos de AgentCore Memory. */
    readonly memoryEventExpiryDays: number;
  };
  readonly reminders: {
    /** Si es true, T-48h y T-24h se comprimen a minutos desde la reserva. */
    readonly demoMode: boolean;
    readonly demoMinutes48h: number;
    readonly demoMinutes24h: number;
  };
  readonly tags: Record<string, string>;
}
