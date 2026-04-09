export interface SkillMetadata {
  name: string;
  version?: string;
  description?: string;
  author?: string;
  tags?: string[];
  dependencies?: string[];
}

export interface SkillRoute {
  name: string;
  shortDescription: string;
  source: 'system' | 'user';
  basePath: string;
  metadata?: SkillMetadata;
}

export interface ISkillManager {
  getSkill(route: string): SkillMetadata | undefined;
  getAllSkills(): SkillRoute[];
  getSkillsForRole(roleId: string): SkillRoute[];
  isInitialized(): boolean;
  initialize(): Promise<void>;
}
