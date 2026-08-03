import { readdir, readFile, statfs } from 'node:fs/promises';
import { cpus, freemem, totalmem } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../config/index.js';
import type { QuotaPlanId } from '../quota/plans.js';
import type { GroupQuotaReport, GroupQuotaService } from './groupQuota.js';

export const SYSTEM_INFO_SCOPES = [
  'hardware',
  'sensors',
  'storage',
  'models',
  'quota',
  'identity',
  'privacy',
] as const;

export type SystemInfoScope = (typeof SYSTEM_INFO_SCOPES)[number];

export interface SystemInfoRequestClassification {
  explicit: boolean;
  scopes: SystemInfoScope[];
}

export interface HardwareComponent {
  category: 'graphics' | 'storage' | 'multimedia';
  name?: string;
  vendorId?: string;
  deviceId?: string;
}

export interface HardwareSnapshot {
  cpuModel?: string;
  logicalCores?: number;
  totalMemoryBytes?: number;
  freeMemoryBytes?: number;
  boardVendor?: string;
  boardName?: string;
  productName?: string;
  biosVersion?: string;
  components: HardwareComponent[];
}

export interface TemperatureReading {
  chip?: string;
  label?: string;
  celsius: number;
}

export interface FanReading {
  chip?: string;
  label?: string;
  rpm: number;
}

export interface SensorSnapshot {
  temperatures: TemperatureReading[];
  fans: FanReading[];
}

export interface DiskSnapshot {
  model?: string;
  sizeBytes?: number;
  rotational?: boolean;
}

export interface FileSystemSnapshot {
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
}

export interface StorageSnapshot {
  disks: DiskSnapshot[];
  fileSystem?: FileSystemSnapshot;
}

/**
 * This deliberately narrow interface is the security boundary around host inspection. It has no
 * methods for network interfaces, host/user identity, environment variables, processes or generic
 * command execution.
 */
export interface SystemInfoReader {
  readHardware(): Promise<HardwareSnapshot>;
  readSensors(): Promise<SensorSnapshot>;
  readStorage(): Promise<StorageSnapshot>;
}

export interface RootFileSystemStats {
  blockSize: number;
  blocks: number;
  availableBlocks: number;
}

/** Injectable low-level source used by NodeSystemInfoReader and fixture-backed tests. */
export interface SystemHostSource {
  cpuModels(): readonly string[];
  totalMemoryBytes(): number;
  freeMemoryBytes(): number;
  readDirectory(path: string): Promise<readonly string[]>;
  readText(path: string): Promise<string | undefined>;
  rootFileSystemStats(): Promise<RootFileSystemStats | undefined>;
}

export interface SystemInfoReportRequest {
  chatId: number;
  scopes: readonly SystemInfoScope[];
  /** Bot-admin private sessions use the primary route and do not consume group-plan quota. */
  operatorSession?: boolean;
}

type QuotaReporter = Pick<GroupQuotaService, 'getReport'>;

const SYS_BLOCK = '/sys/block';
const SYS_HWMON = '/sys/class/hwmon';
const SYS_PCI = '/sys/bus/pci/devices';
const SYS_DMI = '/sys/devices/virtual/dmi/id';
const PCI_IDS_DATABASE = '/usr/share/misc/pci.ids';
const MAX_REPORT_CHARS = 3_900;
const SAFE_SEGMENT = /^[a-zA-Z0-9._:-]+$/;
const PCI_ID = /^0x[0-9a-f]{4}$/i;
const VALID_SCOPES = new Set<string>(SYSTEM_INFO_SCOPES);

const SCOPE_PATTERNS: Record<SystemInfoScope, readonly RegExp[]> = {
  hardware: [
    /\b(?:cpu|processor(?:e|i)?|ram|memoria|memory|hardware|component(?:e|i|s)?|gpu)\b/,
    /\b(?:scheda madre|motherboard|mainboard)\b/,
  ],
  sensors: [
    /\b(?:temperatur(?:a|e)|temperature|temp|sensori?|sensors?|termic[oa]|thermal)\b/,
    /\b(?:ventol(?:a|e)|fans?|rpm)\b/,
  ],
  storage: [/\b(?:dischi?|disks?|storage|spazio|filesystem|archiviazione|ssd|hdd|nvme)\b/],
  models: [
    /\b(?:llm|modello linguistico|modelli linguistici|language models?)\b/,
    /\b(?:vision model|chat model|modello (?:chat|ai|visione))\b/,
    /\b(?:tuoi modelli|your models)\b/,
    /\b(?:modelli?|models?)\b.{0,40}\b(?:llm|ai|configurat\w*|disponibil\w*|available|hai|usi|usa|attiv\w*)\b/,
  ],
  quota: [
    /\b(?:quota|quote|limiti?|limits?|budget|token|tokens|residuo|residua|remaining|usage|consumo)\b/,
  ],
  identity: [
    /\b(?:ip|hostname|host name|username|nome utente|utente di sistema|domain|dominio|dns|mac address)\b/,
    /\b(?:uuid|seriale|serial number|machine[ -]?id|mountpoint|mount point|percorso di sistema)\b/,
  ],
  privacy: [
    /\b(?:privacy|dati sensibili|sensitive data|segreti|secrets|cosa (?:nascondi|ometti))\b/,
  ],
};

const REQUEST_PATTERN =
  /\b(?:mostra(?:mi)?|dimmi|dammi|elenca|controlla|verifica|ispeziona|fammi|genera|riporta|show|tell|give|list|check|inspect|report|display|what|which|how many|how much|qual|quale|quali|quanto|quanta|quanti|quante|che|che cosa)\b/;
const TARGET_PATTERN =
  /\b(?:bot|goonerbot|gooneurobot|server|macchina|sistema|system|host|nodo|node|computer|pc|tu|te|tuo|tua|tuoi|tue|hai|usi|your)\b/;
const GENERIC_REPORT_PATTERN =
  /\b(?:informazioni di sistema|info(?:rmazioni)? sul sistema|report (?:di|del) sistema|system info|system report|stato del sistema|diagnostica del sistema)\b/;
const TERSE_SYSTEM_INFO_PATTERN =
  /^(?:(?:goonerbot|gooneurobot|bot)[,:]?\s+)?(?:(?:temp(?:eratura|erature)?|cpu|ram|gpu|hardware|sensori?|sensors?|ventole?|fans?|rpm|dischi?|disks?|storage|quota|quote|llm)(?:\s+(?:temp(?:eratura|erature)?|cpu|ram|gpu|hardware|sensori?|sensors?|ventole?|fans?|rpm|dischi?|disks?|storage|quota|quote|llm|modelli?|models?)){0,3})\??$/;

/**
 * Pure, deterministic gate for natural-language system inspection. Addressing the bot is required;
 * merely discussing CPUs, temperatures or LLMs never enables the capability.
 */
export function classifyExplicitSystemInfoRequest(
  text: string,
  addressed: boolean,
): SystemInfoRequestClassification {
  if (!addressed || typeof text !== 'string') return { explicit: false, scopes: [] };
  const normalized = normalizeForMatching(text);
  if (!normalized) return { explicit: false, scopes: [] };
  const terseRequest = TERSE_SYSTEM_INFO_PATTERN.test(normalized);
  if (!REQUEST_PATTERN.test(normalized) && !terseRequest) return { explicit: false, scopes: [] };

  const scopes = SYSTEM_INFO_SCOPES.filter((scope) =>
    SCOPE_PATTERNS[scope].some((pattern) => pattern.test(normalized)),
  );
  const genericReport = GENERIC_REPORT_PATTERN.test(normalized);
  if (genericReport && scopes.length === 0) {
    scopes.push('hardware', 'sensors', 'storage', 'models', 'quota');
  }
  const safeOnlyRequest = scopes.includes('identity') || scopes.includes('privacy');
  if (
    scopes.length === 0 ||
    (!TARGET_PATTERN.test(normalized) && !safeOnlyRequest && !terseRequest)
  ) {
    return { explicit: false, scopes: [] };
  }
  return { explicit: true, scopes };
}

/** Host reader backed only by an allowlist of Node OS counters and fixed sysfs files. */
export class NodeSystemInfoReader implements SystemInfoReader {
  constructor(private readonly source: SystemHostSource = nodeHostSource) {}

  async readHardware(): Promise<HardwareSnapshot> {
    const cpuModels = safeSync(() => this.source.cpuModels(), [] as readonly string[]);
    const [boardVendor, boardName, productName, biosVersion, components] = await Promise.all([
      this.source.readText(join(SYS_DMI, 'board_vendor')),
      this.source.readText(join(SYS_DMI, 'board_name')),
      this.source.readText(join(SYS_DMI, 'product_name')),
      this.source.readText(join(SYS_DMI, 'bios_version')),
      this.readComponents(),
    ]);
    return {
      cpuModel: cpuModels.find((model) => model.trim().length > 0)?.trim(),
      logicalCores: cpuModels.length,
      totalMemoryBytes: validNonNegative(safeSync(() => this.source.totalMemoryBytes(), 0)),
      freeMemoryBytes: validNonNegative(safeSync(() => this.source.freeMemoryBytes(), 0)),
      boardVendor,
      boardName,
      productName,
      biosVersion,
      components,
    };
  }

  async readSensors(): Promise<SensorSnapshot> {
    const temperatures: TemperatureReading[] = [];
    const fans: FanReading[] = [];
    const chips = await safeDirectory(this.source, SYS_HWMON);

    for (const chipDir of chips.filter(isSafeSegment).sort()) {
      const chipPath = join(SYS_HWMON, chipDir);
      const [chip, files] = await Promise.all([
        this.source.readText(join(chipPath, 'name')),
        safeDirectory(this.source, chipPath),
      ]);
      for (const file of [...files].sort()) {
        const temperatureMatch = /^temp(\d+)_input$/.exec(file);
        if (temperatureMatch?.[1]) {
          const [raw, label] = await Promise.all([
            this.source.readText(join(chipPath, file)),
            this.source.readText(join(chipPath, `temp${temperatureMatch[1]}_label`)),
          ]);
          const celsius = parseTemperatureCelsius(raw);
          if (celsius !== undefined) temperatures.push({ chip, label, celsius });
          continue;
        }
        const fanMatch = /^fan(\d+)_input$/.exec(file);
        if (!fanMatch?.[1]) continue;
        const [raw, label] = await Promise.all([
          this.source.readText(join(chipPath, file)),
          this.source.readText(join(chipPath, `fan${fanMatch[1]}_label`)),
        ]);
        const rpm = parseFanRpm(raw);
        if (rpm !== undefined) fans.push({ chip, label, rpm });
      }
    }

    return {
      temperatures: temperatures.sort(compareSensorReadings),
      fans: fans.sort(compareSensorReadings),
    };
  }

  async readStorage(): Promise<StorageSnapshot> {
    const devices = (await safeDirectory(this.source, SYS_BLOCK))
      .filter(isSafeSegment)
      .filter((name) => !/^(?:loop|ram|zram|dm-)/.test(name))
      .sort();
    const disks = (
      await Promise.all(
        devices.map(async (device): Promise<DiskSnapshot | undefined> => {
          const base = join(SYS_BLOCK, device);
          const [model, sectors, rotational] = await Promise.all([
            this.source.readText(join(base, 'device/model')),
            this.source.readText(join(base, 'size')),
            this.source.readText(join(base, 'queue/rotational')),
          ]);
          const sizeBytes = sectorsToBytes(sectors);
          if (!model && sizeBytes === undefined) return undefined;
          return {
            model,
            sizeBytes,
            rotational: rotational === '0' ? false : rotational === '1' ? true : undefined,
          };
        }),
      )
    )
      .filter((disk): disk is DiskSnapshot => disk !== undefined)
      .sort((a, b) =>
        `${a.model ?? ''}:${a.sizeBytes ?? 0}`.localeCompare(
          `${b.model ?? ''}:${b.sizeBytes ?? 0}`,
        ),
      );

    const stats = await this.source.rootFileSystemStats();
    return {
      disks,
      fileSystem: fileSystemFromStats(stats),
    };
  }

  private async readComponents(): Promise<HardwareComponent[]> {
    const devices = (await safeDirectory(this.source, SYS_PCI)).filter(isSafeSegment).sort();
    const [components, pciIdsDatabase] = await Promise.all([
      Promise.all(
        devices.map(async (device): Promise<HardwareComponent | undefined> => {
          const base = join(SYS_PCI, device);
          const [classCode, vendorId, deviceId] = await Promise.all([
            this.source.readText(join(base, 'class')),
            this.source.readText(join(base, 'vendor')),
            this.source.readText(join(base, 'device')),
          ]);
          const category = pciCategory(classCode);
          if (!category) return undefined;
          return {
            category,
            vendorId: normalizePciId(vendorId),
            deviceId: normalizePciId(deviceId),
          };
        }),
      ),
      this.source.readText(PCI_IDS_DATABASE),
    ]);
    return components
      .filter((component): component is HardwareComponent => component !== undefined)
      .map((component) => ({
        ...component,
        name: resolvePciComponentName(pciIdsDatabase, component.vendorId, component.deviceId),
      }))
      .sort((a, b) =>
        `${a.category}:${a.name ?? ''}:${a.vendorId ?? ''}:${a.deviceId ?? ''}`.localeCompare(
          `${b.category}:${b.name ?? ''}:${b.vendorId ?? ''}:${b.deviceId ?? ''}`,
        ),
      );
  }
}

/**
 * Deterministic report builder. It never calls an LLM and never serializes AppConfig or raw host
 * errors; only explicitly selected fields reach the renderer.
 */
export class SystemInfoService {
  constructor(
    private readonly config: AppConfig,
    private readonly quota: QuotaReporter,
    private readonly reader: SystemInfoReader = new NodeSystemInfoReader(),
  ) {}

  async report(input: SystemInfoReportRequest): Promise<string> {
    const scopes = normalizeScopes(input.scopes);
    if (scopes.length === 0) return 'Nessuna sezione di sistema richiesta.';

    const needsQuota = scopes.includes('models') || scopes.includes('quota');
    const quotaReportPromise =
      needsQuota && !input.operatorSession && Number.isSafeInteger(input.chatId)
        ? this.quota.getReport(input.chatId).catch(() => undefined)
        : Promise.resolve(undefined);
    const hardwarePromise = scopes.includes('hardware')
      ? this.reader.readHardware().catch(() => emptyHardware())
      : Promise.resolve(undefined);
    const sensorsPromise = scopes.includes('sensors')
      ? this.reader.readSensors().catch(() => emptySensors())
      : Promise.resolve(undefined);
    const storagePromise = scopes.includes('storage')
      ? this.reader.readStorage().catch(() => emptyStorage())
      : Promise.resolve(undefined);

    const [quotaReport, hardware, sensors, storage] = await Promise.all([
      quotaReportPromise,
      hardwarePromise,
      sensorsPromise,
      storagePromise,
    ]);
    const sections: string[][] = [];
    for (const scope of scopes) {
      switch (scope) {
        case 'hardware':
          sections.push(renderHardware(hardware ?? emptyHardware()));
          break;
        case 'sensors':
          sections.push(renderSensors(sensors ?? emptySensors()));
          break;
        case 'storage':
          sections.push(renderStorage(storage ?? emptyStorage()));
          break;
        case 'models':
          sections.push(renderModels(this.config, quotaReport, input.operatorSession === true));
          break;
        case 'quota':
          sections.push(renderQuota(quotaReport, input.operatorSession === true));
          break;
        case 'identity':
          sections.push([
            'Identità',
            '• Dati identificativi della macchina e dell’utente: omessi deliberatamente.',
          ]);
          break;
        case 'privacy':
          sections.push([
            'Privacy',
            '• Il report non raccoglie né mostra dati di rete, identità, percorsi, identificatori hardware univoci o segreti di configurazione.',
          ]);
          break;
      }
    }
    return fitReport(sections);
  }

  getReport(chatId: number, scopes: readonly SystemInfoScope[]): Promise<string> {
    return this.report({ chatId, scopes });
  }
}

export function parseTemperatureCelsius(raw: string | undefined): number | undefined {
  if (!raw || !/^-?\d+(?:\.\d+)?$/.test(raw.trim())) return undefined;
  const value = Number(raw.trim()) / 1_000;
  return Number.isFinite(value) && value >= -50 && value <= 200 ? value : undefined;
}

export function parseFanRpm(raw: string | undefined): number | undefined {
  if (!raw || !/^\d+(?:\.\d+)?$/.test(raw.trim())) return undefined;
  const value = Number(raw.trim());
  return Number.isFinite(value) && value >= 0 && value <= 1_000_000 ? Math.round(value) : undefined;
}

function normalizeForMatching(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeScopes(scopes: readonly unknown[]): SystemInfoScope[] {
  const requested = new Set(
    scopes.filter((scope): scope is SystemInfoScope =>
      typeof scope === 'string' ? VALID_SCOPES.has(scope) : false,
    ),
  );
  return SYSTEM_INFO_SCOPES.filter((scope) => requested.has(scope));
}

function renderHardware(snapshot: HardwareSnapshot): string[] {
  const cpuModel = safeDisplayText(snapshot.cpuModel) ?? 'non disponibile';
  const cores = validPositiveInteger(snapshot.logicalCores);
  const total = validNonNegative(snapshot.totalMemoryBytes);
  const free = Math.min(validNonNegative(snapshot.freeMemoryBytes), total || Number.MAX_VALUE);
  const board = uniqueSafeValues([snapshot.boardVendor, snapshot.boardName, snapshot.productName]);
  const bios = safeDisplayText(snapshot.biosVersion);
  const lines = [
    'Hardware',
    `• CPU: ${cpuModel}`,
    `• Core logici: ${cores || 'non disponibili'}`,
    `• RAM: ${total > 0 ? `${formatBytes(total)} totali, ${formatBytes(free)} disponibili` : 'non disponibile'}`,
    `• Scheda/sistema: ${board.length > 0 ? board.join(' · ') : 'non disponibile'}`,
    `• BIOS: ${bios ?? 'non disponibile'}`,
  ];
  const components = snapshot.components.slice(0, 8).map(renderComponent);
  lines.push(
    components.length > 0
      ? `• Componenti consentiti: ${components.join('; ')}`
      : '• Componenti consentiti: non disponibili',
  );
  return lines;
}

function renderComponent(component: HardwareComponent): string {
  const labels: Record<HardwareComponent['category'], string> = {
    graphics: 'grafica',
    storage: 'archiviazione',
    multimedia: 'multimedia',
  };
  const ids = [normalizePciId(component.vendorId), normalizePciId(component.deviceId)].filter(
    (value): value is string => Boolean(value),
  );
  const name = safeDisplayText(component.name);
  if (name) return `${labels[component.category]}: ${name}`;
  return ids.length > 0
    ? `${labels[component.category]} (${ids.join('/')})`
    : labels[component.category];
}

function renderSensors(snapshot: SensorSnapshot): string[] {
  const lines = ['Sensori'];
  const temperatures = snapshot.temperatures
    .filter((reading) => reading.celsius >= -50 && reading.celsius <= 200)
    .slice(0, 12)
    .map(
      (reading) => `${sensorName(reading.chip, reading.label)} ${reading.celsius.toFixed(1)} °C`,
    );
  const fans = snapshot.fans
    .filter((reading) => reading.rpm >= 0 && reading.rpm <= 1_000_000)
    .slice(0, 8)
    .map((reading) => `${sensorName(reading.chip, reading.label)} ${Math.round(reading.rpm)} RPM`);
  lines.push(
    temperatures.length > 0
      ? `• Temperature: ${temperatures.join('; ')}`
      : '• Temperature: non disponibili',
  );
  lines.push(fans.length > 0 ? `• Ventole: ${fans.join('; ')}` : '• Ventole: non disponibili');
  return lines;
}

function renderStorage(snapshot: StorageSnapshot): string[] {
  const lines = ['Archiviazione'];
  const disks = snapshot.disks.slice(0, 8).map((disk) => {
    const model = safeDisplayText(disk.model) ?? 'modello non disponibile';
    const size = validNonNegative(disk.sizeBytes);
    const media =
      disk.rotational === true
        ? 'rotazionale'
        : disk.rotational === false
          ? 'SSD/non rotazionale'
          : 'tipo non disponibile';
    return `${model}, ${size > 0 ? formatBytes(size) : 'dimensione non disponibile'}, ${media}`;
  });
  lines.push(
    disks.length > 0 ? `• Unità fisiche: ${disks.join('; ')}` : '• Unità fisiche: non disponibili',
  );
  const fileSystem = snapshot.fileSystem;
  if (!fileSystem) {
    lines.push('• Filesystem principale: non disponibile');
  } else {
    const total = validNonNegative(fileSystem.totalBytes);
    const used = Math.min(validNonNegative(fileSystem.usedBytes), total || Number.MAX_VALUE);
    const available = Math.min(
      validNonNegative(fileSystem.availableBytes),
      total || Number.MAX_VALUE,
    );
    lines.push(
      total > 0
        ? `• Filesystem principale: ${formatBytes(used)} usati su ${formatBytes(total)}, ${formatBytes(available)} disponibili`
        : '• Filesystem principale: non disponibile',
    );
  }
  return lines;
}

function renderModels(
  config: AppConfig,
  report: GroupQuotaReport | undefined,
  operatorSession: boolean,
): string[] {
  const planId = operatorSession ? 'pro' : safePlanId(report?.plan.id);
  const effective =
    planId === 'free' ? config.env?.FREE_LLM_MODEL : planId ? config.llm?.model : undefined;
  const models: Array<[string, string | undefined]> = [
    ['Chat effettivo', effective],
    ['Chat predefinito', config.llm?.model],
    ['Chat piano free', config.env?.FREE_LLM_MODEL],
    ['Visione', config.llm?.visionModel],
    ['NSFW', config.llm?.nsfwModel],
    ['Fallback', config.llm?.fallback?.model],
    ['Mining', config.miningLlm?.model],
    ['Embedding', config.embeddings?.model],
    ['Scene', config.brain?.sceneModel],
    ['Cortex', config.brain?.cortex?.model],
    ['Evaluator', config.brain?.evaluatorModel],
    ['Planner', config.brain?.plannerModel],
    ['Reply', config.brain?.replyModel],
    ['Ranker', config.brain?.rankerModel],
  ];
  for (const [index, fallback] of (config.llm?.freeFallbacks ?? []).slice(0, 3).entries()) {
    models.push([`Fallback libero ${index + 1}`, fallback.model]);
  }
  const safeModels = models
    .map(([role, model]) => [role, safeDisplayText(model)] as const)
    .filter((entry): entry is readonly [string, string] => Boolean(entry[1]));
  const lines = ['Modelli configurati'];
  if (operatorSession)
    lines.push('• Sessione operatore privata: route primaria, bypass quote gruppo.');
  else if (planId) lines.push(`• Piano applicato: ${planId}`);
  lines.push(
    ...(safeModels.length > 0
      ? safeModels.map(([role, model]) => `• ${role}: ${model}`)
      : ['• Nessun identificatore di modello disponibile.']),
  );
  return lines;
}

function renderQuota(report: GroupQuotaReport | undefined, operatorSession: boolean): string[] {
  if (operatorSession) {
    return [
      'Quote interne del bot',
      '• Sessione operatore privata: bypass delle quote gruppo; nessun contatore viene consumato da questo report.',
    ];
  }
  if (!report) return ['Quote interne del bot', '• Dati quota non disponibili.'];
  const { plan, daily, hourly } = report;
  const lines = ['Quote interne del bot', `• Piano: ${safePlanId(plan.id) ?? 'non disponibile'}`];
  lines.push(
    quotaLine('Conversazioni giornaliere', daily.conversations, plan.conversationDaily),
    quotaLine('Conversazioni orarie', hourly.conversations, plan.conversationHourly),
    quotaLine('Risposte passive orarie', hourly.passiveReplies, plan.passiveHourly),
    quotaLine('Token LLM giornalieri', daily.llmTokens, plan.llmTokensDaily),
    quotaLine('Ricerche web giornaliere', daily.webSearches, plan.webSearchDaily),
    quotaLine('Scansioni pagina giornaliere', daily.pageScans, plan.pageScanDaily),
    quotaLine('News giornaliere', daily.news, plan.newsDaily),
    quotaLine('Immagini giornaliere', daily.images, plan.imagesDaily),
    quotaLine('Media giornalieri', daily.media, plan.mediaDaily),
    quotaBytesLine('Dati media giornalieri', daily.mediaBytes, plan.mediaBytesDaily),
  );
  lines.push('• Sono limiti interni del bot; non vengono interrogati provider esterni.');
  return lines;
}

function quotaLine(label: string, usedValue: number, limitValue: number): string {
  const used = validNonNegativeInteger(usedValue);
  const limit = validNonNegativeInteger(limitValue);
  const remaining = Math.max(0, limit - used);
  return `• ${label}: ${formatInteger(used)}/${formatInteger(limit)} (${formatInteger(remaining)} residue)`;
}

function quotaBytesLine(label: string, usedValue: number, limitValue: number): string {
  const used = validNonNegative(usedValue);
  const limit = validNonNegative(limitValue);
  const remaining = Math.max(0, limit - used);
  return `• ${label}: ${formatBytes(used)}/${formatBytes(limit)} (${formatBytes(remaining)} residui)`;
}

function sensorName(chip: string | undefined, label: string | undefined): string {
  const values = uniqueSafeValues([chip, label]);
  return values.length > 0 ? `${values.join(' / ')}:` : 'sensore:';
}

function uniqueSafeValues(values: readonly (string | undefined)[]): string[] {
  return [
    ...new Set(values.map(safeDisplayText).filter((value): value is string => Boolean(value))),
  ];
}

/** Reject a whole display value if it resembles an identity, network datum, path or secret. */
function safeDisplayText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = [...value]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code === 127 ? ' ' : character;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return undefined;
  const forbidden = [
    /https?:\/\//i,
    /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
    /\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/i,
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i,
    /(?:^|\s)@[a-z0-9_]{2,}/i,
    /\b(?:serial|seriale|uuid|machine[ -]?id|hostname|username)\b/i,
    /(?:^|\s)(?:\/(?:home|root|users|etc|var|mnt|media|run|proc|sys|dev)\/)/i,
    /\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z]{2,})+\b/i,
  ];
  if (forbidden.some((pattern) => pattern.test(normalized))) return undefined;
  return normalized.slice(0, 96);
}

function fitReport(sections: readonly string[][]): string {
  const lines = sections.flatMap((section, index) => (index === 0 ? section : ['', ...section]));
  const full = lines.join('\n');
  if (full.length <= MAX_REPORT_CHARS) return full;
  const suffix = '\n… output abbreviato.';
  const accepted: string[] = [];
  for (const line of lines) {
    const candidate = [...accepted, line].join('\n');
    if (candidate.length + suffix.length > MAX_REPORT_CHARS) break;
    accepted.push(line);
  }
  return `${accepted.join('\n')}${suffix}`;
}

function formatBytes(bytes: number): string {
  const value = validNonNegative(bytes);
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GiB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${Math.round(value)} B`;
}

function formatInteger(value: number): string {
  return Math.trunc(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function safePlanId(value: QuotaPlanId | undefined): QuotaPlanId | undefined {
  return value === 'free' || value === 'plus' || value === 'pro' ? value : undefined;
}

function validNonNegative(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function validNonNegativeInteger(value: number | undefined): number {
  return Math.floor(validNonNegative(value));
}

function validPositiveInteger(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? (value as number) : 0;
}

function normalizePciId(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && PCI_ID.test(normalized) ? normalized : undefined;
}

function pciCategory(value: string | undefined): HardwareComponent['category'] | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || !/^0x[0-9a-f]{6}$/.test(normalized)) return undefined;
  switch (normalized.slice(2, 4)) {
    case '01':
      return 'storage';
    case '03':
      return 'graphics';
    case '04':
      return 'multimedia';
    default:
      return undefined;
  }
}

function resolvePciComponentName(
  database: string | undefined,
  vendorId: string | undefined,
  deviceId: string | undefined,
): string | undefined {
  if (!database || !vendorId || !deviceId) return undefined;
  const wantedVendor = vendorId.slice(2).toLowerCase();
  const wantedDevice = deviceId.slice(2).toLowerCase();
  let currentVendor: string | undefined;
  let currentVendorName: string | undefined;
  for (const line of database.slice(0, 8_000_000).split(/\r?\n/)) {
    const vendor = /^([0-9a-f]{4})\s{2,}(.+)$/i.exec(line);
    if (vendor?.[1] && vendor[2]) {
      currentVendor = vendor[1].toLowerCase();
      currentVendorName = currentVendor === wantedVendor ? vendor[2].trim() : undefined;
      continue;
    }
    if (currentVendor !== wantedVendor || !currentVendorName) continue;
    const device = /^\t([0-9a-f]{4})\s{2,}(.+)$/i.exec(line);
    if (device?.[1]?.toLowerCase() !== wantedDevice || !device[2]) continue;
    return `${currentVendorName} ${device[2].trim()}`;
  }
  return undefined;
}

function sectorsToBytes(raw: string | undefined): number | undefined {
  if (!raw || !/^\d+$/.test(raw.trim())) return undefined;
  try {
    const value = BigInt(raw.trim()) * 512n;
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
    return Number(value);
  } catch {
    return undefined;
  }
}

function fileSystemFromStats(
  stats: RootFileSystemStats | undefined,
): FileSystemSnapshot | undefined {
  if (!stats) return undefined;
  const blockSize = validNonNegativeInteger(stats.blockSize);
  const blocks = validNonNegativeInteger(stats.blocks);
  const availableBlocks = Math.min(validNonNegativeInteger(stats.availableBlocks), blocks);
  const totalBytes = blockSize * blocks;
  const availableBytes = blockSize * availableBlocks;
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) return undefined;
  return { totalBytes, usedBytes: totalBytes - availableBytes, availableBytes };
}

function isSafeSegment(value: string): boolean {
  return SAFE_SEGMENT.test(value) && value !== '.' && value !== '..';
}

async function safeDirectory(source: SystemHostSource, path: string): Promise<readonly string[]> {
  try {
    return await source.readDirectory(path);
  } catch {
    return [];
  }
}

function safeSync<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

function compareSensorReadings(
  a: TemperatureReading | FanReading,
  b: TemperatureReading | FanReading,
): number {
  return `${a.chip ?? ''}:${a.label ?? ''}`.localeCompare(`${b.chip ?? ''}:${b.label ?? ''}`);
}

function emptyHardware(): HardwareSnapshot {
  return { components: [] };
}

function emptySensors(): SensorSnapshot {
  return { temperatures: [], fans: [] };
}

function emptyStorage(): StorageSnapshot {
  return { disks: [] };
}

const nodeHostSource: SystemHostSource = {
  cpuModels: () => cpus().map((cpu) => cpu.model),
  totalMemoryBytes: () => totalmem(),
  freeMemoryBytes: () => freemem(),
  async readDirectory(path) {
    try {
      return await readdir(path);
    } catch {
      return [];
    }
  },
  async readText(path) {
    try {
      return (await readFile(path, 'utf8')).trim();
    } catch {
      return undefined;
    }
  },
  async rootFileSystemStats() {
    try {
      const stats = await statfs('/');
      return {
        blockSize: stats.bsize,
        blocks: stats.blocks,
        availableBlocks: stats.bavail,
      };
    } catch {
      return undefined;
    }
  },
};
