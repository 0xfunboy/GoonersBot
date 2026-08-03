import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/index.js';
import { QUOTA_PLANS } from '../src/quota/plans.js';
import type { GroupQuotaReport } from '../src/services/groupQuota.js';
import {
  classifyExplicitSystemInfoRequest,
  NodeSystemInfoReader,
  parseFanRpm,
  parseTemperatureCelsius,
  SystemInfoService,
  type SystemHostSource,
  type SystemInfoReader,
  type SystemInfoScope,
} from '../src/services/systemInfo.js';

const GiB = 1024 ** 3;

function appConfig(): AppConfig {
  return {
    env: {
      FREE_LLM_MODEL: 'economy-model',
      BOT_ADMINS: ['@operator-that-must-not-leak'],
    },
    llm: {
      provider: 'custom_openai_compatible',
      baseUrl: 'https://private.example/api/v1',
      apiKey: 'super-secret-key',
      model: 'premium-model',
      visionModel: 'vision-model',
      nsfwModel: 'uncensored-model',
      fallback: {
        baseUrl: 'https://fallback.example/v1',
        apiKey: 'fallback-secret',
        model: 'fallback-model',
      },
      freeFallbacks: [
        {
          name: 'provider-secret-name',
          baseUrl: 'https://free.example/v1',
          apiKey: 'free-secret',
          model: 'meta-llama/llama-3.1',
        },
      ],
    },
    miningLlm: { model: 'mining-model' },
    embeddings: { model: 'embedding-model' },
    brain: {
      sceneModel: 'scene-model',
      evaluatorModel: 'evaluator-model',
      cortex: { model: 'cortex-model' },
      plannerModel: 'planner-model',
      replyModel: 'reply-model',
      rankerModel: 'ranker-model',
    },
  } as unknown as AppConfig;
}

function quotaReport(plan: 'free' | 'plus' | 'pro' = 'free'): GroupQuotaReport {
  return {
    plan: QUOTA_PLANS[plan],
    daily: {
      conversations: 5,
      llmTokens: 12_500,
      webSearches: 3,
      pageScans: 4,
      news: 1,
      images: 1,
      media: 4,
      mediaBytes: 50 * 1024 * 1024,
    },
    hourly: { conversations: 2, passiveReplies: 0 },
    dayKey: 'secret-day-key-not-rendered',
    hourKey: 'secret-hour-key-not-rendered',
  };
}

function snapshotReader(): SystemInfoReader {
  return {
    readHardware: vi.fn(async () => ({
      cpuModel: 'AMD EPYC 7B13 64-Core Processor',
      logicalCores: 16,
      totalMemoryBytes: 32 * GiB,
      freeMemoryBytes: 8 * GiB,
      boardVendor: 'Supermicro',
      boardName: 'X11SCL-IF',
      productName: 'Server Chassis',
      biosVersion: '2.4',
      components: [
        {
          category: 'graphics',
          name: 'Intel Corporation HD Graphics 630',
          vendorId: '0x8086',
          deviceId: '0x5912',
        },
      ],
    })),
    readSensors: vi.fn(async () => ({
      temperatures: [
        { chip: 'coretemp', label: 'Package id 0', celsius: 44.125 },
        { chip: 'nvme', label: 'Composite', celsius: 37.85 },
      ],
      fans: [{ chip: 'nct6798', label: 'CPU Fan', rpm: 1_240 }],
    })),
    readStorage: vi.fn(async () => ({
      disks: [{ model: 'SanDisk Ultra 3D NVMe', sizeBytes: 512 * GiB, rotational: false }],
      fileSystem: {
        totalBytes: 256 * GiB,
        usedBytes: 96 * GiB,
        availableBytes: 160 * GiB,
      },
    })),
  };
}

describe('classifyExplicitSystemInfoRequest', () => {
  it('requires an addressed, explicit request and extracts only requested scopes', () => {
    expect(
      classifyExplicitSystemInfoRequest(
        'Mostrami CPU, temperature, ventole e dischi del server',
        true,
      ),
    ).toEqual({ explicit: true, scopes: ['hardware', 'sensors', 'storage'] });
    expect(
      classifyExplicitSystemInfoRequest(
        'Quali modelli LLM usa il bot e quanta quota rimane?',
        true,
      ),
    ).toEqual({ explicit: true, scopes: ['models', 'quota'] });
  });

  it('does not turn passive or shopping conversation into host inspection', () => {
    expect(classifyExplicitSystemInfoRequest('La CPU del server è calda', true)).toEqual({
      explicit: false,
      scopes: [],
    });
    expect(classifyExplicitSystemInfoRequest('Che CPU mi consigli di comprare?', true)).toEqual({
      explicit: false,
      scopes: [],
    });
    expect(classifyExplicitSystemInfoRequest('Mostrami la CPU del server', false)).toEqual({
      explicit: false,
      scopes: [],
    });
  });

  it('supports terse addressed diagnostics and avoids ambiguous model chatter', () => {
    expect(classifyExplicitSystemInfoRequest('temp cpu?', true)).toEqual({
      explicit: true,
      scopes: ['hardware', 'sensors'],
    });
    expect(classifyExplicitSystemInfoRequest('quali modelli hai disponibili?', true)).toEqual({
      explicit: true,
      scopes: ['models'],
    });
    expect(
      classifyExplicitSystemInfoRequest('dimmi quali modelli anime ti piacciono', true),
    ).toEqual({
      explicit: false,
      scopes: [],
    });
  });

  it('routes identity requests to a fixed safe scope and expands a generic report minimally', () => {
    expect(
      classifyExplicitSystemInfoRequest('Dimmi IP, hostname e username del server', true),
    ).toEqual({ explicit: true, scopes: ['identity'] });
    expect(classifyExplicitSystemInfoRequest('Fammi un report di sistema', true)).toEqual({
      explicit: true,
      scopes: ['hardware', 'sensors', 'storage', 'models', 'quota'],
    });
  });
});

describe('NodeSystemInfoReader', () => {
  it('parses fixed sysfs sources, resolves PCI names and excludes network/logical devices', async () => {
    const directories: Record<string, readonly string[]> = {
      '/sys/bus/pci/devices': ['0000:00:02.0', '0000:00:1f.6', '../escape'],
      '/sys/class/hwmon': ['hwmon0'],
      '/sys/class/hwmon/hwmon0': [
        'name',
        'temp1_input',
        'temp1_label',
        'temp2_input',
        'fan1_input',
        'fan1_label',
        'fan2_input',
      ],
      '/sys/block': ['nvme0n1', 'loop0', 'dm-0', 'zram0'],
    };
    const files: Record<string, string> = {
      '/sys/devices/virtual/dmi/id/board_vendor': 'ASUSTeK COMPUTER INC.',
      '/sys/devices/virtual/dmi/id/board_name': 'PRIME Z270-A',
      '/sys/devices/virtual/dmi/id/product_name': 'Workstation',
      '/sys/devices/virtual/dmi/id/bios_version': '1401',
      '/sys/bus/pci/devices/0000:00:02.0/class': '0x030000',
      '/sys/bus/pci/devices/0000:00:02.0/vendor': '0x8086',
      '/sys/bus/pci/devices/0000:00:02.0/device': '0x5912',
      '/sys/bus/pci/devices/0000:00:1f.6/class': '0x020000',
      '/sys/bus/pci/devices/0000:00:1f.6/vendor': '0x8086',
      '/sys/bus/pci/devices/0000:00:1f.6/device': '0x15b8',
      '/usr/share/misc/pci.ids': [
        '8086  Intel Corporation',
        '\t5912  HD Graphics 630',
        '\t15b8  Ethernet Connection',
      ].join('\n'),
      '/sys/class/hwmon/hwmon0/name': 'coretemp',
      '/sys/class/hwmon/hwmon0/temp1_input': '45500',
      '/sys/class/hwmon/hwmon0/temp1_label': 'Package id 0',
      '/sys/class/hwmon/hwmon0/temp2_input': '999000',
      '/sys/class/hwmon/hwmon0/fan1_input': '1325',
      '/sys/class/hwmon/hwmon0/fan1_label': 'CPU Fan',
      '/sys/class/hwmon/hwmon0/fan2_input': '1000001',
      '/sys/block/nvme0n1/device/model': 'SanDisk Ultra 3D NVMe',
      '/sys/block/nvme0n1/size': '1000000',
      '/sys/block/nvme0n1/queue/rotational': '0',
    };
    const readText = vi.fn(async (path: string) => files[path]);
    const source: SystemHostSource = {
      cpuModels: () => ['Intel(R) Core(TM) i7-7700 CPU @ 3.60GHz'],
      totalMemoryBytes: () => 16 * GiB,
      freeMemoryBytes: () => 6 * GiB,
      readDirectory: vi.fn(async (path: string) => directories[path] ?? []),
      readText,
      rootFileSystemStats: vi.fn(async () => ({
        blockSize: 4_096,
        blocks: 1_000_000,
        availableBlocks: 250_000,
      })),
    };
    const reader = new NodeSystemInfoReader(source);

    const [hardware, sensors, storage] = await Promise.all([
      reader.readHardware(),
      reader.readSensors(),
      reader.readStorage(),
    ]);

    expect(hardware).toMatchObject({
      cpuModel: 'Intel(R) Core(TM) i7-7700 CPU @ 3.60GHz',
      logicalCores: 1,
      boardVendor: 'ASUSTeK COMPUTER INC.',
    });
    expect(hardware.components).toEqual([
      {
        category: 'graphics',
        name: 'Intel Corporation HD Graphics 630',
        vendorId: '0x8086',
        deviceId: '0x5912',
      },
    ]);
    expect(sensors).toEqual({
      temperatures: [{ chip: 'coretemp', label: 'Package id 0', celsius: 45.5 }],
      fans: [{ chip: 'coretemp', label: 'CPU Fan', rpm: 1_325 }],
    });
    expect(storage.disks).toEqual([
      { model: 'SanDisk Ultra 3D NVMe', sizeBytes: 512_000_000, rotational: false },
    ]);
    expect(storage.fileSystem).toEqual({
      totalBytes: 4_096_000_000,
      usedBytes: 3_072_000_000,
      availableBytes: 1_024_000_000,
    });
    const readPaths = readText.mock.calls.map(([path]) => path);
    expect(readPaths.join('\n')).not.toMatch(/serial|uuid|machine-id|network|hostname|user/i);
    expect(readPaths).not.toContain('/sys/block/loop0/device/model');
    expect(readPaths).not.toContain('/sys/block/dm-0/device/model');
  });

  it('validates sensor ranges without throwing', () => {
    expect(parseTemperatureCelsius('42000')).toBe(42);
    expect(parseTemperatureCelsius('-50001')).toBeUndefined();
    expect(parseTemperatureCelsius('201000')).toBeUndefined();
    expect(parseTemperatureCelsius('not-a-number')).toBeUndefined();
    expect(parseFanRpm('1200')).toBe(1_200);
    expect(parseFanRpm('1000001')).toBeUndefined();
    expect(parseFanRpm('-1')).toBeUndefined();
  });
});

describe('SystemInfoService', () => {
  it('collects and renders only explicitly requested sections', async () => {
    const reader = snapshotReader();
    const quota = { getReport: vi.fn(async () => quotaReport()) };
    const service = new SystemInfoService(appConfig(), quota, reader);

    const report = await service.getReport(-100, ['hardware']);

    expect(report).toContain('Hardware');
    expect(report).toContain('AMD EPYC 7B13 64-Core Processor');
    expect(report).toContain('Intel Corporation HD Graphics 630');
    expect(report).not.toContain('Sensori');
    expect(report).not.toContain('Archiviazione');
    expect(report).not.toContain('Modelli configurati');
    expect(report).not.toContain('Quote interne');
    expect(reader.readHardware).toHaveBeenCalledOnce();
    expect(reader.readSensors).not.toHaveBeenCalled();
    expect(reader.readStorage).not.toHaveBeenCalled();
    expect(quota.getReport).not.toHaveBeenCalled();
  });

  it('shows only allowlisted model identifiers and internal quota counters', async () => {
    const quota = { getReport: vi.fn(async () => quotaReport('free')) };
    const service = new SystemInfoService(appConfig(), quota, snapshotReader());

    const report = await service.report({ chatId: -100, scopes: ['models', 'quota'] });

    expect(quota.getReport).toHaveBeenCalledOnce();
    expect(report).toContain('Chat effettivo: economy-model');
    expect(report).toContain('Chat predefinito: premium-model');
    expect(report).toContain('Cortex: cortex-model');
    expect(report).toContain('Fallback libero 1: meta-llama/llama-3.1');
    expect(report).toContain('Conversazioni giornaliere: 5/12 (7 residue)');
    expect(report).toContain('Media giornalieri: 4/3 (0 residue)');
    expect(report).toContain('limiti interni del bot');
    expect(report).not.toContain('private.example');
    expect(report).not.toContain('fallback.example');
    expect(report).not.toContain('super-secret-key');
    expect(report).not.toContain('provider-secret-name');
    expect(report).not.toContain('secret-day-key');
    expect(report).not.toContain('-100');
  });

  it('reports a private operator session accurately without reading group quota', async () => {
    const quota = { getReport: vi.fn(async () => quotaReport('free')) };
    const service = new SystemInfoService(appConfig(), quota, snapshotReader());

    const report = await service.report({
      chatId: 7,
      scopes: ['models', 'quota'],
      operatorSession: true,
    });

    expect(quota.getReport).not.toHaveBeenCalled();
    expect(report).toContain('Chat effettivo: premium-model');
    expect(report).toContain('Sessione operatore privata');
    expect(report).toContain('bypass delle quote gruppo');
  });

  it('redacts adversarial identities, network data, paths and unique identifiers', async () => {
    const reader: SystemInfoReader = {
      readHardware: vi.fn(async () => ({
        cpuModel: 'CPU owned by @alice',
        logicalCores: 4,
        totalMemoryBytes: 8 * GiB,
        freeMemoryBytes: 2 * GiB,
        boardVendor: '192.168.1.5',
        boardName: 'alice.private.example',
        productName: 'aa:bb:cc:dd:ee:ff',
        biosVersion: '550e8400-e29b-41d4-a716-446655440000',
        components: [{ category: 'graphics', name: '/home/alice/gpu' }],
      })),
      readSensors: vi.fn(async () => ({
        temperatures: [{ chip: '@alice', label: '/home/alice/sensor', celsius: 40 }],
        fans: [],
      })),
      readStorage: vi.fn(async () => ({
        disks: [
          {
            model: 'https://storage.private.example/@alice',
            sizeBytes: 128 * GiB,
            rotational: false,
          },
        ],
      })),
    };
    const quota = { getReport: vi.fn(async () => quotaReport()) };
    const service = new SystemInfoService(appConfig(), quota, reader);
    const scopes: SystemInfoScope[] = [
      'hardware',
      'sensors',
      'storage',
      'models',
      'quota',
      'identity',
      'privacy',
    ];

    const report = await service.report({ chatId: -100, scopes });

    for (const secret of [
      '@alice',
      '192.168.1.5',
      'alice.private.example',
      'aa:bb:cc:dd:ee:ff',
      '550e8400-e29b-41d4-a716-446655440000',
      '/home/alice',
      'storage.private.example',
      'super-secret-key',
    ]) {
      expect(report).not.toContain(secret);
    }
    expect(report).toContain('omessi deliberatamente');
    expect(report.length).toBeLessThanOrEqual(3_900);
  });

  it('never exposes raw reader or quota errors', async () => {
    const reader: SystemInfoReader = {
      readHardware: vi.fn(async () => {
        throw new Error('failed reading /home/alice/private-host');
      }),
      readSensors: vi.fn(async () => {
        throw new Error('sensor at 10.0.0.8');
      }),
      readStorage: vi.fn(async () => {
        throw new Error('disk serial 550e8400-e29b-41d4-a716-446655440000');
      }),
    };
    const quota = {
      getReport: vi.fn(async (): Promise<GroupQuotaReport> => {
        throw new Error('provider private.example rejected super-secret-key');
      }),
    };
    const service = new SystemInfoService(appConfig(), quota, reader);

    const report = await service.report({
      chatId: -100,
      scopes: ['hardware', 'sensors', 'storage', 'models', 'quota'],
    });

    expect(report).toContain('non disponibile');
    expect(report).not.toMatch(/alice|10\.0\.0\.8|550e8400|private\.example|super-secret-key/);
  });
});
