import { cloneAndFreezeSocialCapabilityManifest, isCapabilityAvailable } from './manifest.js';
import type {
  SocialPlatform,
  SocialReadAction,
  SocialReadAdapter,
  SocialWriteAction,
  SocialWriteAdapter,
} from './types.js';

export class SocialAdapterUnavailableError extends Error {
  constructor(platform: SocialPlatform, action: SocialReadAction | SocialWriteAction) {
    super(`no social adapter is available for ${platform}:${action}`);
    this.name = 'SocialAdapterUnavailableError';
  }
}

export class SocialClientRegistry {
  private readonly readAdapters = new Map<SocialPlatform, SocialReadAdapter>();
  private readonly writeAdapters = new Map<SocialPlatform, SocialWriteAdapter>();

  registerRead(adapter: SocialReadAdapter): void {
    const registered = snapshotReadAdapter(adapter);
    if (
      !registered.manifest.capabilities.some(
        (item) => item.access === 'read' && item.status === 'available',
      )
    ) {
      throw new Error(
        `read adapter ${registered.manifest.adapterId} has no available read capability`,
      );
    }
    if (this.readAdapters.has(registered.platform)) {
      throw new Error(`read adapter already registered for ${registered.platform}`);
    }
    this.readAdapters.set(registered.platform, registered);
  }

  registerWrite(adapter: SocialWriteAdapter): void {
    const registered = snapshotWriteAdapter(adapter);
    if (
      !registered.manifest.capabilities.some(
        (item) => item.access === 'write' && item.status === 'available',
      )
    ) {
      throw new Error(
        `write adapter ${registered.manifest.adapterId} has no available write capability`,
      );
    }
    if (this.writeAdapters.has(registered.platform)) {
      throw new Error(`write adapter already registered for ${registered.platform}`);
    }
    this.writeAdapters.set(registered.platform, registered);
  }

  requireRead(platform: SocialPlatform, action: SocialReadAction): SocialReadAdapter {
    const adapter = this.readAdapters.get(platform);
    if (adapter === undefined || !isCapabilityAvailable(adapter.manifest, action)) {
      throw new SocialAdapterUnavailableError(platform, action);
    }
    return adapter;
  }

  requireWrite(platform: SocialPlatform, action: SocialWriteAction): SocialWriteAdapter {
    const adapter = this.writeAdapters.get(platform);
    if (adapter === undefined || !isCapabilityAvailable(adapter.manifest, action)) {
      throw new SocialAdapterUnavailableError(platform, action);
    }
    return adapter;
  }
}

function snapshotManifest(
  adapter: SocialReadAdapter | SocialWriteAdapter,
): SocialCapabilityManifestSnapshot {
  const platform = adapter.platform;
  const manifest = cloneAndFreezeSocialCapabilityManifest(adapter.manifest);
  if (platform !== manifest.platform) {
    throw new Error(`adapter platform ${platform} does not match manifest ${manifest.platform}`);
  }
  return { platform, manifest };
}

type SocialCapabilityManifestSnapshot = Pick<SocialReadAdapter, 'platform' | 'manifest'>;

function snapshotReadAdapter(adapter: SocialReadAdapter): SocialReadAdapter {
  const { platform, manifest } = snapshotManifest(adapter);
  if (typeof adapter.executeRead !== 'function') throw new Error('read adapter method is required');
  return Object.freeze({
    platform,
    manifest,
    executeRead: adapter.executeRead.bind(adapter),
  });
}

function snapshotWriteAdapter(adapter: SocialWriteAdapter): SocialWriteAdapter {
  const { platform, manifest } = snapshotManifest(adapter);
  if (typeof adapter.executeWrite !== 'function') {
    throw new Error('write adapter method is required');
  }
  return Object.freeze({
    platform,
    manifest,
    executeWrite: adapter.executeWrite.bind(adapter),
  });
}
