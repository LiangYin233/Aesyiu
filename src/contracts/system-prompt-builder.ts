export interface PromptBuildContext {
  chatId: string;
  toolDescriptions?: string;
  skillInstructions?: string;
  sessionMemory?: string;
}

export interface ISystemPromptBuilder {
  buildSystemPrompt(params: { roleId: string; chatId: string; toolDescriptions?: string; skillInstructions?: string; sessionMemory?: string }): string;
}
