export const MEMORY_KINDS = [
  'recent',
  'social',
  'personal_project',
  'operational',
  'external',
  'procedural',
] as const;
export type CompanionMemoryKind = (typeof MEMORY_KINDS)[number];

/** Every field is supplied by the host. A model cannot select another person's memory. */
export interface CompanionMemoryScope {
  ownerTelegramId: number;
  chatId: number;
  telegramTopicId?: number | null;
}

export interface MemoryProvenance {
  source: 'human' | 'task';
  messageId?: number;
  taskId?: string;
  artifactIds?: string[];
  sourceAt?: Date;
  /** Stable Telegram update/operation identity, not model prose. */
  requestKey?: string;
}

export interface CompanionMemory {
  id: string;
  chatId: number;
  telegramTopicId: number | null;
  kind: CompanionMemoryKind;
  projectId?: string;
  category?: string;
  text: string;
  provenance: MemoryProvenance;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MemoryInput {
  operation: 'remember' | 'recall' | 'list' | 'correct' | 'export' | 'forget';
  text?: string;
  query?: string;
  memoryId?: string;
  projectId?: string;
  category?: string;
  kind?: CompanionMemoryKind;
  all?: boolean;
}

export interface MemoryResult {
  text: string;
  memories: CompanionMemory[];
  changed: number;
  clarification?: boolean;
  document?: { buffer: Buffer; mime: string; name: string };
}

export interface MemoryOwnerDocument {
  _id: number;
  version: number;
  memories: CompanionMemory[];
  /** Erasure fences and hashes retain no forgotten prose or document content. */
  erasedBefore?: Date;
  forgotten: Array<{ hash: string; at: Date }>;
  updatedAt: Date;
}

export interface MemoryRepository {
  get(ownerTelegramId: number): Promise<MemoryOwnerDocument | null>;
  compareAndSwap(document: MemoryOwnerDocument, expectedVersion: number): Promise<boolean>;
}
