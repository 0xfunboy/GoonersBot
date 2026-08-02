export const SOCIAL_PLATFORMS = ['x', 'instagram', 'facebook', 'tiktok', 'youtube'] as const;

export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

export const SOCIAL_READ_ACTIONS = [
  'session.validate',
  'profile.read',
  'content.metadata.read',
  'content.media.resolve',
  'content.comments.read',
] as const;

export const SOCIAL_WRITE_ACTIONS = [
  'post.create',
  'post.delete',
  'comment.create',
  'reaction.create',
  'follow.create',
] as const;

export type SocialReadAction = (typeof SOCIAL_READ_ACTIONS)[number];
export type SocialWriteAction = (typeof SOCIAL_WRITE_ACTIONS)[number];
export type SocialAction = SocialReadAction | SocialWriteAction;
export type SocialAccess = 'read' | 'write';

/**
 * A reference to authentication material, never authentication material itself.
 * Resolution belongs in a deployment-specific secret/session provider.
 */
export type SocialCredentialReference =
  | {
      kind: 'cookie_jar';
      /** Environment variable whose value is the path to a mounted Netscape cookie jar. */
      pathEnv: string;
    }
  | {
      kind: 'secret_store';
      provider: string;
      secretId: string;
      version?: string;
    };

export interface SocialRequestBase {
  requestId: string;
  /** Stable internal actor id (for example `telegram-user:123`), used only for policy/audit. */
  principalId: string;
  platform: SocialPlatform;
  /** Stable logical account id, not an email, handle, token, or password. */
  accountRef?: string;
  credentialRef?: SocialCredentialReference;
}

export interface SocialReadRequest<
  TInput = Readonly<Record<string, unknown>>,
> extends SocialRequestBase {
  action: SocialReadAction;
  input: TInput;
}

export interface SocialWriteRequest<
  TInput = Readonly<Record<string, unknown>>,
> extends SocialRequestBase {
  action: SocialWriteAction;
  accountRef: string;
  /** Caller-generated key identifying one intended mutation. */
  idempotencyKey: string;
  input: TInput;
}

export interface SocialAdapterContext {
  signal?: AbortSignal;
}

export type SocialCapabilityStatus = 'available' | 'planned' | 'disabled';

export interface SocialCapability {
  readonly action: SocialAction;
  readonly access: SocialAccess;
  readonly status: SocialCapabilityStatus;
  /** Auth modes understood by the future/installed adapter. */
  readonly auth: readonly ('anonymous' | 'session')[];
}

export interface SocialCapabilityManifest {
  readonly platform: SocialPlatform;
  readonly adapterId: string;
  readonly version: string;
  readonly capabilities: readonly SocialCapability[];
}

/** Read adapters cannot expose mutating methods through this interface. */
export interface SocialReadAdapter {
  readonly platform: SocialPlatform;
  readonly manifest: SocialCapabilityManifest;
  executeRead(request: SocialReadRequest, context: SocialAdapterContext): Promise<unknown>;
}

/** Write adapters are registered separately and remain unusable unless policy enables them. */
export interface SocialWriteAdapter {
  readonly platform: SocialPlatform;
  readonly manifest: SocialCapabilityManifest;
  executeWrite(request: SocialWriteRequest, context: SocialAdapterContext): Promise<unknown>;
}

export function socialActionAccess(action: SocialAction): SocialAccess {
  return (SOCIAL_READ_ACTIONS as readonly string[]).includes(action) ? 'read' : 'write';
}
