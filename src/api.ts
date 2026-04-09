import { AgentEngine, AgentConfig, AgentRunResult, AgentDeps } from './core/agent.js';
import { ChannelPipeline, PipelineDeps } from './core/pipeline.js';
import { MiddlewareFunc, IChannelContext, IUnifiedMessage, IOutboundPayload } from './core/types.js';
import { ToolRegistry } from './tools/registry.js';
import { ITool, ToolDefinition, ToolExecuteContext } from './tools/types.js';
import { LLMConfig } from './llm/factory.js';
import { LLMProviderType } from './llm/types.js';
import type { ILogger } from './contracts/logger.js';
import { createNoOpLogger } from './observability/logger.js';
import { mapProviderType } from './utils/llm-utils.js';
import type { IRoleManager } from './contracts/role-manager.js';
import type { IPluginHookDispatcher } from './contracts/plugin-hook-dispatcher.js';
import type { ISystemPromptBuilder } from './contracts/system-prompt-builder.js';
import type { MemoryConfig } from './memory/types.js';

export interface ProviderConfig {
  type: LLMProviderType | 'openai_chat' | 'openai_completion' | 'anthropic';
  model: string;
  apiKey?: string;
  baseUrl?: string;
  timeout?: number;
}

export interface SkillDefinition {
  name: string;
  description: string;
  instructions: string;
}

export class Agent {
  private engine: AgentEngine | null = null;
  private pipeline: ChannelPipeline;
  private toolRegistry: ToolRegistry;
  private registeredTools: ITool[] = [];
  private config: Partial<AgentConfig> = {};
  private deps: AgentDeps = {};
  private pipelineDeps: PipelineDeps = {};
  private chatId: string;
  private logger: ILogger;

  constructor(chatId?: string, logger?: ILogger) {
    this.chatId = chatId ?? `agent-${Date.now()}`;
    this.logger = logger ?? createNoOpLogger();
    this.toolRegistry = new ToolRegistry(this.logger);
    this.pipeline = new ChannelPipeline({ logger: this.logger });
  }

  setProvider(provider: ProviderConfig): Agent {
    const llmConfig: LLMConfig = {
      provider: this.resolveProviderType(provider.type),
      model: provider.model,
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
      timeout: provider.timeout,
    };
    this.config.llm = llmConfig;
    return this;
  }

  setSystemPrompt(prompt: string): Agent {
    this.config.systemPrompt = prompt;
    return this;
  }

  setMaxSteps(steps: number): Agent {
    this.config.maxSteps = steps;
    return this;
  }

  setMemoryConfig(memoryConfig: Partial<MemoryConfig>): Agent {
    this.config.memoryConfig = memoryConfig;
    return this;
  }

  setRoleManager(roleManager: IRoleManager): Agent {
    this.deps.roleManager = roleManager;
    return this;
  }

  setPluginHookDispatcher(dispatcher: IPluginHookDispatcher): Agent {
    this.deps.pluginHookDispatcher = dispatcher;
    this.pipelineDeps.pluginHookDispatcher = dispatcher;
    this.pipeline = new ChannelPipeline(this.pipelineDeps);
    return this;
  }

  setSystemPromptBuilder(builder: ISystemPromptBuilder): Agent {
    this.deps.systemPromptBuilder = builder;
    return this;
  }

  setLogger(logger: ILogger): Agent {
    this.logger = logger;
    return this;
  }

  registerTool(tool: ITool): Agent {
    this.toolRegistry.register(tool);
    this.registeredTools.push(tool);
    return this;
  }

  use(middleware: MiddlewareFunc): Agent {
    this.pipeline.use(middleware);
    return this;
  }

  loadSkill(skill: SkillDefinition): Agent {
    if (this.config.systemPrompt) {
      this.config.systemPrompt += `\n\n--- Skill: ${skill.name} ---\n${skill.instructions}`;
    } else {
      this.config.systemPrompt = `--- Skill: ${skill.name} ---\n${skill.instructions}`;
    }
    return this;
  }

  async run(input: string): Promise<AgentRunResult> {
    const engine = this.getEngine();
    return engine.run(input);
  }

  updateModel(model: string): void {
    if (this.engine) {
      this.engine.updateModel(model);
    }
    if (this.config.llm) {
      this.config.llm.model = model;
    }
  }

  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }

  getPipeline(): ChannelPipeline {
    return this.pipeline;
  }

  getEngine(): AgentEngine {
    if (!this.engine) {
      if (!this.config.llm) {
        throw new Error('Provider not configured. Call setProvider() first.');
      }

      const agentConfig: AgentConfig = {
        llm: this.config.llm,
        maxSteps: this.config.maxSteps,
        systemPrompt: this.config.systemPrompt,
        tools: this.config.tools,
        memoryConfig: this.config.memoryConfig,
      };

      this.engine = new AgentEngine(this.chatId, agentConfig, {
        ...this.deps,
        logger: this.logger,
      });

      for (const tool of this.registeredTools) {
        this.engine.getToolRegistry().register(tool);
      }
    }
    return this.engine;
  }

  private resolveProviderType(type: ProviderConfig['type']): LLMProviderType {
    if (typeof type === 'string') {
      return mapProviderType(type);
    }
    return type;
  }
}

export class AgentBuilder {
  private agent: Agent;

  constructor() {
    this.agent = new Agent();
  }

  setProvider(provider: ProviderConfig): AgentBuilder {
    this.agent.setProvider(provider);
    return this;
  }

  setSystemPrompt(prompt: string): AgentBuilder {
    this.agent.setSystemPrompt(prompt);
    return this;
  }

  setMaxSteps(steps: number): AgentBuilder {
    this.agent.setMaxSteps(steps);
    return this;
  }

  setMemoryConfig(memoryConfig: Partial<MemoryConfig>): AgentBuilder {
    this.agent.setMemoryConfig(memoryConfig);
    return this;
  }

  setRoleManager(roleManager: IRoleManager): AgentBuilder {
    this.agent.setRoleManager(roleManager);
    return this;
  }

  setPluginHookDispatcher(dispatcher: IPluginHookDispatcher): AgentBuilder {
    this.agent.setPluginHookDispatcher(dispatcher);
    return this;
  }

  setSystemPromptBuilder(builder: ISystemPromptBuilder): AgentBuilder {
    this.agent.setSystemPromptBuilder(builder);
    return this;
  }

  setLogger(logger: ILogger): AgentBuilder {
    this.agent.setLogger(logger);
    return this;
  }

  registerTool(tool: ITool): AgentBuilder {
    this.agent.registerTool(tool);
    return this;
  }

  use(middleware: MiddlewareFunc): AgentBuilder {
    this.agent.use(middleware);
    return this;
  }

  loadSkill(skill: SkillDefinition): AgentBuilder {
    this.agent.loadSkill(skill);
    return this;
  }

  build(): Agent {
    return this.agent;
  }
}

export function createAgent(config?: {
  chatId?: string;
  provider?: ProviderConfig;
  systemPrompt?: string;
  maxSteps?: number;
  memoryConfig?: Partial<MemoryConfig>;
  logger?: ILogger;
  roleManager?: IRoleManager;
  pluginHookDispatcher?: IPluginHookDispatcher;
  systemPromptBuilder?: ISystemPromptBuilder;
}): AgentBuilder {
  const builder = new AgentBuilder();

  if (config) {
    if (config.provider) builder.setProvider(config.provider);
    if (config.systemPrompt) builder.setSystemPrompt(config.systemPrompt);
    if (config.maxSteps) builder.setMaxSteps(config.maxSteps);
    if (config.memoryConfig) builder.setMemoryConfig(config.memoryConfig);
    if (config.logger) builder.setLogger(config.logger);
    if (config.roleManager) builder.setRoleManager(config.roleManager);
    if (config.pluginHookDispatcher) builder.setPluginHookDispatcher(config.pluginHookDispatcher);
    if (config.systemPromptBuilder) builder.setSystemPromptBuilder(config.systemPromptBuilder);
  }

  return builder;
}
