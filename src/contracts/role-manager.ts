export interface IRoleManager {
  getRole(roleId: string): RoleConfig | undefined;
  getRoleConfig(roleId: string): RoleConfig;
  getDefaultRole(): RoleConfig;
  getAllRoles(): RoleConfig[];
  isInitialized(): boolean;
  initialize(): Promise<void>;
  isToolAllowed(roleId: string, toolName: string): boolean;
  getAllowedTools(roleId: string, allTools: string[]): string[];
}

export interface RoleConfig {
  name: string;
  description?: string;
  system_prompt: string;
  model: string;
  allowed_tools: string[];
  allowed_skills: string[];
  enabled: boolean;
}
