import { describe, expect, it } from 'vitest';
import {
  isNewCapabilityInstallation,
  isVerifiedCapabilityExecution,
  isVerifiedCapabilityReuse,
  type CapabilityExecution,
} from '../src/capabilities/types.js';

function execution(overrides: Partial<CapabilityExecution>): CapabilityExecution {
  return {
    handled: false,
    text: 'outcome',
    status: 'validation_failed',
    installed: true,
    capabilityId: 'existing_manifest',
    command: 'existingcmd',
    usage: { inputTokens: 0, outputTokens: 0, estimated: true },
    model: null,
    sources: [],
    ...overrides,
  };
}

describe('capability lifecycle gates', () => {
  it.each(['blocked_dependency', 'proposal_saved', 'validation_failed'] as const)(
    'never treats legacy installed metadata as success for %s',
    (status) => {
      const result = execution({ status });

      expect(isVerifiedCapabilityExecution(result)).toBe(false);
      expect(isNewCapabilityInstallation(result)).toBe(false);
      expect(isVerifiedCapabilityReuse(result)).toBe(false);
    },
  );

  it('distinguishes a new verified installation from verified reuse', () => {
    const installed = execution({ handled: true, status: 'installed' });
    const reused = execution({ handled: true, status: 'reused' });

    expect(isNewCapabilityInstallation(installed)).toBe(true);
    expect(isVerifiedCapabilityReuse(installed)).toBe(false);
    expect(isNewCapabilityInstallation(reused)).toBe(false);
    expect(isVerifiedCapabilityReuse(reused)).toBe(true);
  });
});
