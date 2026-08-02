import {
  SOCIAL_PLATFORMS,
  SOCIAL_READ_ACTIONS,
  SOCIAL_WRITE_ACTIONS,
  socialActionAccess,
  type SocialCapability,
  type SocialCapabilityManifest,
  type SocialPlatform,
} from './types.js';

export class InvalidSocialManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSocialManifestError';
  }
}

export function validateSocialCapabilityManifest(manifest: SocialCapabilityManifest): void {
  if (!SOCIAL_PLATFORMS.includes(manifest.platform)) {
    throw new InvalidSocialManifestError(`unsupported platform: ${String(manifest.platform)}`);
  }
  if (!manifest.adapterId.trim() || !manifest.version.trim()) {
    throw new InvalidSocialManifestError('adapterId and version are required');
  }

  const seen = new Set<string>();
  for (const capability of manifest.capabilities) {
    if (
      !(SOCIAL_READ_ACTIONS as readonly string[]).includes(capability.action) &&
      !(SOCIAL_WRITE_ACTIONS as readonly string[]).includes(capability.action)
    ) {
      throw new InvalidSocialManifestError(`unknown capability: ${String(capability.action)}`);
    }
    if (seen.has(capability.action)) {
      throw new InvalidSocialManifestError(`duplicate capability: ${capability.action}`);
    }
    seen.add(capability.action);
    if (socialActionAccess(capability.action) !== capability.access) {
      throw new InvalidSocialManifestError(
        `capability ${capability.action} has incorrect access ${capability.access}`,
      );
    }
    if (capability.auth.length === 0) {
      throw new InvalidSocialManifestError(`capability ${capability.action} has no auth mode`);
    }
    if (capability.auth.some((auth) => auth !== 'anonymous' && auth !== 'session')) {
      throw new InvalidSocialManifestError(`capability ${capability.action} has invalid auth mode`);
    }
  }
}

/** Snapshot and recursively freeze adapter-owned manifest data before registry trust decisions. */
export function cloneAndFreezeSocialCapabilityManifest(
  source: SocialCapabilityManifest,
): SocialCapabilityManifest {
  if (typeof source !== 'object' || source === null || !Array.isArray(source.capabilities)) {
    throw new InvalidSocialManifestError('manifest must be an object with capabilities');
  }
  const manifest: SocialCapabilityManifest = {
    platform: source.platform,
    adapterId: source.adapterId,
    version: source.version,
    capabilities: source.capabilities.map((capability) =>
      Object.freeze({
        action: capability.action,
        access: capability.access,
        status: capability.status,
        auth: Object.freeze([...capability.auth]),
      }),
    ),
  };
  validateSocialCapabilityManifest(manifest);
  Object.freeze(manifest.capabilities);
  return Object.freeze(manifest);
}

export function isCapabilityAvailable(
  manifest: SocialCapabilityManifest,
  action: SocialCapability['action'],
): boolean {
  return manifest.capabilities.some(
    (capability) => capability.action === action && capability.status === 'available',
  );
}

/**
 * Roadmap manifests only. They are deliberately non-executable: adapters must replace `planned`
 * with `available` for the exact capabilities they implement before registration can succeed.
 */
export const PLANNED_SOCIAL_CAPABILITY_MANIFESTS: Readonly<
  Record<SocialPlatform, SocialCapabilityManifest>
> = Object.freeze(
  Object.fromEntries(
    SOCIAL_PLATFORMS.map((platform) => [
      platform,
      cloneAndFreezeSocialCapabilityManifest({
        platform,
        adapterId: `${platform}-planned`,
        version: '0.1.0',
        capabilities: [
          ...SOCIAL_READ_ACTIONS.map(
            (action): SocialCapability => ({
              action,
              access: 'read',
              status: 'planned',
              auth: action === 'content.metadata.read' ? ['anonymous', 'session'] : ['session'],
            }),
          ),
          ...SOCIAL_WRITE_ACTIONS.map(
            (action): SocialCapability => ({
              action,
              access: 'write',
              status: 'disabled',
              auth: ['session'],
            }),
          ),
        ],
      }),
    ]),
  ) as Record<SocialPlatform, SocialCapabilityManifest>,
);
