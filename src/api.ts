import { AgentEngine, AgentConfig, AgentRunInput, AgentRunResult, AgentDeps } from './core/agent.js';
import { ChannelPipeline } from './core/pipeline.js';
import { MiddlewareFunc } from './core/types.js';
import { ToolRegistry } from './tools/registry.js';
import type { ITool } from './tools/types.js';
import type { ILogger } from './contracts/logger.js';
import { createNoOpLogger } from './observability/logger.js';
import type { ISystemPromptBuilder } from './contracts/system-prompt-builder.js';
import type { MemoryConfig } from './memory/types.js';
import { TurnEngine, type TurnEngineConfig } from './core/turn-engine.js';
import { type Provider, type Model, DefaultRuntimeProviderState } from './providers/index.js';

export interface SkillDefinition {
  name: string;
  description: string;
  instructions: string;
}

export class Agent {
  private engine: AgentEngine | null = null;
  private pipeline: ChannelPipeline;
  private toolRegistry: ToolRegistry;
  private config: Partial<AgentConfig> = {};
  private deps: AgentDeps = {};
  private defaultStateKey: string;
  private logger: ILogger;

  constructor(stateKey?: string, logger?: ILogger) {
    this.defaultStateKey = stateKey ?? `agent-${Date.now()}`;
    this.logger = logger ?? createNoOpLogger();
    this.toolRegistry = new ToolRegistry(this.logger);
    this.pipeline = new ChannelPipeline({ logger: this.logger });
  }

  setProvider(provider: Provider, modelId?: string): Agent {
    this.config.provider = provider;
    if (modelId) {
      this.config.initialModelId = modelId;
    }
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
    if (this.engine) {
      this.engine.getToolRegistry().register(tool);
    }
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

  async run(input: string | AgentRunInput): Promise<AgentRunResult> {
    const engine = this.getEngine();
    return engine.run(input);
  }

  switchProvider(provider: Provider): void {
    if (this.engine) {
      this.engine.switchProvider(provider);
    }
  }

  switchModel(modelId: string): void {
    if (this.engine) {
      this.engine.switchModel(modelId);
    }
  }

  getCurrentProvider(): Provider {
    if (!this.engine) {
      throw new Error('Agent not built yet. Call build() first.');
    }
    return this.engine.getCurrentProvider();
  }

  getCurrentModel(): Model {
    if (!this.engine) {
      throw new Error('Agent not built yet. Call build() first.');
    }
    return this.engine.getCurrentModel();
  }

  unregisterTool(toolName: string): boolean {
    if (this.engine) {
      return this.engine.unregisterTool(toolName);
    }
    return this.toolRegistry.unregister(toolName);
  }

  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }

  getPipeline(): ChannelPipeline {
    return this.pipeline;
  }

  getEngine(): AgentEngine {
    if (!this.engine) {
      if (!this.config.provider) {
        throw new Error('Provider not configured. Call setProvider() first.');
      }

      const agentConfig: AgentConfig = {
        provider: this.config.provider,
        initialModelId: this.config.initialModelId,
        maxSteps: this.config.maxSteps,
        systemPrompt: this.config.systemPrompt,
        tools: Array.from(this.toolRegistry.getTools()),
        memoryConfig: this.config.memoryConfig,
      };

      this.engine = new AgentEngine(this.defaultStateKey, agentConfig, {
        ...this.deps,
        logger: this.logger,
      });
    }
    return this.engine;
  }
}

export class AgentBuilder {
  private agent: Agent;

  constructor(stateKey?: string, logger?: ILogger) {
    this.agent = new Agent(stateKey, logger);
  }

  setProvider(provider: Provider, modelId?: string): AgentBuilder {
    this.agent.setProvider(provider, modelId);
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

export function createAgent(provider: Provider, initialModelId?: string): AgentBuilder {
  return new AgentBuilder().setProvider(provider, initialModelId);
}

export function createTurnEngine(config: TurnEngineConfig): TurnEngine {
  return new TurnEngine(config);
}