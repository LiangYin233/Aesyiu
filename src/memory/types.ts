import { StandardMessage } from '../llm/types.js';

export enum CompressionPhase {
  Idle = 'idle',
  Monitoring = 'monitoring',
  SieveProcess = 'sieve_process',
  LLMDrivenSummarization = 'llm_driven_summarization',
  Reassembly = 'reassembly'
}


export interface MemoryConfig {
  /**
   * Fallback maximum context tokens.
   * Used when no runtime model context window is set via `setRuntimeContextWindow()`.
   * When a runtime context window is set, compression thresholds are computed against it instead.
   */
  maxContextTokens: number;
  compressionThreshold: number;
  compressionProvider: string;
  compressionModel: string;
  compressionApiKey?: string;
  compressionBaseUrl?: string;
}

export interface TokenBudget {
  currentTokens: number;
  maxTokens: number;
  usagePercentage: number;
  needsCompression: boolean;
}

export interface MessageZone {
  zone: 'sacred' | 'compressible';
  messages: StandardMessage[];
}

export interface CompressionResult {
  originalTokens: number;
  compressedTokens: number;
  compressionRatio: number;
  originalMessages: StandardMessage[];
  compressedMessages: StandardMessage[];
  summaryMessage?: StandardMessage;
  timestamp: Date;
}

export interface TruncationResult {
  originalLength: number;
  truncatedLength: number;
  preservedHead: string;
  preservedTail: string;
  warningMessage: string;
  wasTruncated: boolean;
}

export interface MemoryStats {
  totalMessages: number;
  totalTokens: number;
  sacredMessages: number;
  compressibleMessages: number;
  compressionCount: number;
  lastCompressionTime?: Date;
  currentPhase: CompressionPhase;
}

export interface MemoryEvent {
  type: 'message_added' | 'compressed' | 'truncated' | 'reset';
  timestamp: Date;
  details: {
    messageCount?: number;
    tokenCount?: number;
    compressionRatio?: number;
    truncationDetails?: TruncationResult;
  };
}

export interface MemorySnapshot {
  version: number;
  stateKey: string;
  messages: StandardMessage[];
  stats: MemoryStats;
  config?: MemoryConfig;
}

export const MEMORY_SNAPSHOT_VERSION = 1;

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  maxContextTokens: 128000,
  compressionThreshold: 0.75,
  compressionProvider: 'openai',
  compressionModel: 'qwen3.5-plus',
};

export function createMemoryConfig(partial?: Partial<MemoryConfig>): MemoryConfig {
  return {
    ...DEFAULT_MEMORY_CONFIG,
    ...partial,
  };
}
