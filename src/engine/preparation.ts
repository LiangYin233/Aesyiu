import type { AgentContext } from '../context/index.js';
import { renderSkillsPrompt, type AgentSkill } from '../skill/index.js';
import type { Message, Tool } from '../types/index.js';
import type { RunOptions } from './types.js';

const SKILL_PROMPT_SECTION = 'aesyiu:skills';

function resolveRunTools(globalTools: ReadonlyMap<string, Tool>, options?: RunOptions): Map<string, Tool> {
  if (!options?.tools) {
    return new Map(globalTools);
  }

  const availableTools = new Map<string, Tool>();
  for (const toolName of options.tools) {
    const tool = globalTools.get(toolName);
    if (!tool) {
      throw new Error(`Tool "${toolName}" is not registered`);
    }
    availableTools.set(toolName, tool);
  }
  return availableTools;
}

function resolveRunSkills(registeredSkills: readonly AgentSkill[], options?: RunOptions): AgentSkill[] {
  if (!options?.skills) {
    return [...registeredSkills];
  }

  const skillIndex = new Map(registeredSkills.map((skill) => [skill.name, skill]));
  return options.skills.map((skillName) => {
    const skill = skillIndex.get(skillName);
    if (!skill) {
      throw new Error(`Skill "${skillName}" is not registered`);
    }
    return skill;
  });
}

function injectSkillPrompt(ctx: AgentContext, skills: readonly AgentSkill[]): void {
  const content = renderSkillsPrompt(skills);
  if (!content) {
    ctx.removeSystemPrompt(SKILL_PROMPT_SECTION);
    return;
  }

  ctx.setSystemPrompt(SKILL_PROMPT_SECTION, content);
}

export function prepareRun(
  input: Message,
  ctx: AgentContext,
  options: RunOptions | undefined,
  globalTools: ReadonlyMap<string, Tool>,
  registeredSkills: readonly AgentSkill[],
): { availableTools: Map<string, Tool>; signal: AbortSignal | undefined } {
  const availableTools = resolveRunTools(globalTools, options);
  injectSkillPrompt(ctx, resolveRunSkills(registeredSkills, options));
  ctx.addMessage(input);
  return { availableTools, signal: options?.signal };
}

export function prepareOutboundMessages(messages: Message[], compatibilityMode: boolean): Message[] {
  if (!compatibilityMode) {
    return messages;
  }

  const grouped = Object.groupBy(messages, (message) =>
    message.role === 'system' ? 'system' : 'other',
  ) as { system?: Message[]; other?: Message[] };
  const systemMessages = grouped.system ?? [];
  if (systemMessages.length <= 1) {
    return messages;
  }

  return [{
    role: 'system',
    content: systemMessages.map((message) => message.content ?? '').join('\n\n'),
  }, ...(grouped.other ?? [])];
}
