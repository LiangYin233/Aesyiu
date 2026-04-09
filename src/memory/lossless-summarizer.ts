import { StandardMessage, MessageRole, LLMProviderType } from '../llm/types.js';
import { MessageZone, CompressionResult, MemoryConfig } from './types.js';
import { TokenBudgetCalculator } from './token-budget-calculator.js';
import { UnifiedLLMClient } from '../llm/unified-client.js';
import { createNoOpLogger } from '../observability/logger.js';
import type { ILogger } from '../contracts/logger.js';
import { mapProviderType } from '../utils/llm-utils.js';
import { MessageFactory } from '../core/message-factory.js';
import { RoleUtils } from '../core/role-utils.js';

export interface LosslessSummarizerDependencies {
  logger?: ILogger;
}

export class LosslessSummarizer {
  private config: MemoryConfig;
  private calculator: TokenBudgetCalculator;
  private summarizerClient: UnifiedLLMClient | null = null;
  private logger: ILogger;

  constructor(config: MemoryConfig, calculator: TokenBudgetCalculator, deps?: LosslessSummarizerDependencies) {
    this.config = config;
    this.calculator = calculator;
    this.logger = deps?.logger ?? createNoOpLogger();
  }

  private getSummarizerClient(): UnifiedLLMClient | null {
    if (!this.config.compressionApiKey) {
      return null;
    }

    if (!this.summarizerClient) {
      const llmProviderType = mapProviderType(this.config.compressionProvider);
      this.summarizerClient = new UnifiedLLMClient({
        provider: llmProviderType,
        model: this.config.compressionModel,
        apiKey: this.config.compressionApiKey,
        baseUrl: this.config.compressionBaseUrl,
      });
    }

    return this.summarizerClient;
  }

  updateConfig(config: Partial<MemoryConfig>): void {
    this.config = { ...this.config, ...config };
    if (this.summarizerClient) {
      this.summarizerClient.destroy();
      this.summarizerClient = null;
    }
  }

  sieveMessages(messages: StandardMessage[]): MessageZone[] {
    const zones: MessageZone[] = [];
    
    let currentSacred: StandardMessage[] = [];
    let currentCompressible: StandardMessage[] = [];
    let lastUserIndex = -1;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      if (msg.role === MessageRole.System && i === 0) {
        currentSacred.push(msg);
        continue;
      }

      if (msg.role === MessageRole.User) {
        if (currentCompressible.length > 0) {
          zones.push({ zone: 'compressible', messages: [...currentCompressible] });
          currentCompressible = [];
        }
        
        if (lastUserIndex >= 0 && currentSacred.length > 0) {
          zones.push({ zone: 'sacred', messages: [...currentSacred] });
          currentSacred = [];
        }
        
        currentSacred.push(msg);
        lastUserIndex = i;
      } else {
        currentCompressible.push(msg);
      }
    }

    if (currentSacred.length > 0) {
      zones.push({ zone: 'sacred', messages: currentSacred });
    }
    if (currentCompressible.length > 0) {
      zones.push({ zone: 'compressible', messages: currentCompressible });
    }

    return zones;
  }

  async summarize(zones: MessageZone[]): Promise<CompressionResult> {
    const originalTokens = this.calculator.calculateTotalTokens(
      zones.flatMap(z => z.messages)
    );

    const sacredMessages = zones
      .filter(z => z.zone === 'sacred')
      .flatMap(z => z.messages);
    
    const compressibleMessages = zones
      .filter(z => z.zone === 'compressible')
      .flatMap(z => z.messages);

    if (compressibleMessages.length === 0) {
      return {
        originalTokens,
        compressedTokens: originalTokens,
        compressionRatio: 1,
        originalMessages: zones.flatMap(z => z.messages),
        compressedMessages: zones.flatMap(z => z.messages),
        timestamp: new Date(),
      };
    }

    this.logger.info(
      { 
        compressibleCount: compressibleMessages.length,
        originalTokens,
        provider: this.config.compressionProvider,
        model: this.config.compressionModel,
      },
      '开始 LLM 驱动的无损压缩'
    );

    const summaryContent = await this.generateSummary(compressibleMessages);
    
    const summaryMessage: StandardMessage = {
      ...MessageFactory.createSystemMessage(`(系统内部摘要：${summaryContent})`),
      name: 'system_summary',
    };

    const compressedMessages: StandardMessage[] = [
      ...sacredMessages,
      summaryMessage,
    ];

    const compressedTokens = this.calculator.calculateTotalTokens(compressedMessages);

    const compressionRatio = originalTokens > 0 
      ? compressedTokens / originalTokens 
      : 1;

    this.logger.info(
      {
        originalTokens,
        compressedTokens,
        compressionRatio: `${(compressionRatio * 100).toFixed(2)}%`,
        summaryLength: summaryContent.length,
      },
      'LLM 驱动的无损压缩完成'
    );

    return {
      originalTokens,
      compressedTokens,
      compressionRatio,
      originalMessages: zones.flatMap(z => z.messages),
      compressedMessages,
      summaryMessage,
      timestamp: new Date(),
    };
  }

  private async generateSummary(messages: StandardMessage[]): Promise<string> {
    const conversationText = messages
      .map(msg => this.formatMessage(msg))
      .join('\n\n');

    const summarizationPrompt = `你是一个客观的系统记录员。请将以下 Agent 的执行过程与工具返回结果，浓缩为精简的步骤摘要。

你必须：
- 保留核心事实结论
- 保留关键数据
- 剔除大段的原始代码、JSON 结构和冗余的思考过程
- 用简洁的语言概括每一步的操作和结果

以下是待压缩的内容：

${conversationText}

请直接输出摘要，不要添加任何解释或前缀。`;

    try {
      const response = await this.callSummarizerModel(summarizationPrompt);
      return response;
    } catch (error) {
      this.logger.error({ error: error as unknown }, 'LLM 压缩失败，使用备用方案');
      return this.fallbackSummary(messages);
    }
  }

  private async callSummarizerModel(prompt: string): Promise<string> {
    const client = this.getSummarizerClient();

    if (!client) {
      throw new Error('compressionApiKey is required for LLM-driven compression');
    }

    const response = await client.generate({
      messages: [MessageFactory.createUserMessage(prompt)],
      systemPrompt: '你是一个客观的系统记录员。请将以下 Agent 的执行过程与工具返回结果，浓缩为精简的步骤摘要。',
      tools: [],
    });

    return response.text;
  }

  private fallbackSummary(messages: StandardMessage[]): string {
    const steps: string[] = [];
    let currentStep = '';

    for (const msg of messages) {
      if (msg.role === MessageRole.Assistant) {
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          const toolNames = msg.toolCalls.map((tc: { name: string }) => tc.name).join(', ');
          currentStep = `调用工具: ${toolNames}`;
        } else if (msg.content) {
          const preview = msg.content.substring(0, 100);
          currentStep = `推理: ${preview}${msg.content.length > 100 ? '...' : ''}`;
        }
      } else if (msg.role === MessageRole.Tool && currentStep) {
        const resultPreview = msg.content.substring(0, 50);
        steps.push(`${currentStep}，结果: ${resultPreview}${msg.content.length > 50 ? '...' : ''}`);
        currentStep = '';
      }
    }

    if (steps.length === 0) {
      return `执行了 ${messages.length} 条消息交互`;
    }

    return steps.slice(-5).join('；') + (steps.length > 5 ? `...（共 ${steps.length} 步）` : '');
  }

  private formatMessage(msg: StandardMessage): string {
    const roleLabel = RoleUtils.getLabel(msg.role);

    let content = msg.content;
    
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      content += '\n工具调用: ' + JSON.stringify(msg.toolCalls);
    }

    return `${roleLabel} ${content}`;
  }

  reassemble(zones: MessageZone[], compressionResult: CompressionResult): StandardMessage[] {
    const result: StandardMessage[] = [];
    
    for (const zone of zones) {
      if (zone.zone === 'sacred') {
        result.push(...zone.messages);
      } else if (zone.zone === 'compressible' && compressionResult.summaryMessage) {
        result.push(compressionResult.summaryMessage);
      }
    }

    return result;
  }
}