import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import frontMatter from 'front-matter';
import type { FrontMatterResult } from 'front-matter';
import { z } from 'zod';
import type { Tool } from '../types/index.js';

export type SkillMetadataScalar = string | number | boolean | null;
export type SkillMetadataValue = SkillMetadataScalar | SkillMetadataScalar[];

export interface SkillMetadata {
  name: string;
  description: string;
  [key: string]: SkillMetadataValue;
}

export interface SkillResourcePaths {
  scripts?: string;
  references?: string;
  assets?: string;
}

export interface AgentSkill {
  name: string;
  description: string;
  metadata: SkillMetadata;
  content: string;
  rootPath: string;
  entryPath: string;
  resourcePaths: SkillResourcePaths;
}

const SKILL_FILE_NAME = 'SKILL.md';
const OPTIONAL_RESOURCE_DIRS = ['scripts', 'references', 'assets'] as const;
const LOAD_SKILL_TOOL_NAME = 'loadskill';

function isSkillMetadataScalar(value: unknown): value is SkillMetadataScalar {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function toSkillMetadataValue(key: string, value: unknown): SkillMetadataValue {
  if (isSkillMetadataScalar(value)) {
    return value;
  }
  if (Array.isArray(value) && value.every(isSkillMetadataScalar)) {
    return value;
  }
  throw new Error(`Skill frontmatter field "${key}" must be a scalar or scalar array in ${SKILL_FILE_NAME}`);
}

function normalizeMetadata(attributes: Record<string, unknown>): Record<string, SkillMetadataValue> {
  return Object.fromEntries(
    Object.entries(attributes).map(([key, value]) => [key, toSkillMetadataValue(key, value)]),
  );
}

function parseFrontmatterDocument(document: string): FrontMatterResult<Record<string, unknown>> {
  try {
    return frontMatter<Record<string, unknown>>(document);
  } catch {
    throw new Error(`Skill file has invalid YAML frontmatter in ${SKILL_FILE_NAME}`);
  }
}

function getRequiredMetadataString(metadata: Record<string, SkillMetadataValue>, key: 'name' | 'description'): string {
  const value = metadata[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Skill frontmatter must include a non-empty "${key}" in ${SKILL_FILE_NAME}`);
  }
  return value.trim();
}

function parseSkillDocument(rawDocument: string): { metadata: SkillMetadata; content: string } {
  const parsed = parseFrontmatterDocument(rawDocument.replace(/\r\n/g, '\n'));
  if (!parsed.frontmatter) {
    throw new Error(`Skill file is missing required YAML frontmatter in ${SKILL_FILE_NAME}`);
  }

  const metadata = normalizeMetadata(parsed.attributes);
  const name = getRequiredMetadataString(metadata, 'name');
  const description = getRequiredMetadataString(metadata, 'description');

  return {
    metadata: {
      ...metadata,
      name,
      description,
    },
    content: parsed.body.trim(),
  };
}

async function resolveSafeExistingPath(rootPath: string, candidatePath: string): Promise<string> {
  const [rootRealPath, candidateRealPath] = await Promise.all([
    realpath(rootPath),
    realpath(candidatePath),
  ]);
  const relative = path.relative(rootRealPath, candidateRealPath);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Resolved path "${candidateRealPath}" escapes skill root "${rootRealPath}"`);
  }

  return candidateRealPath;
}

async function readOptionalResourcePaths(rootPath: string): Promise<SkillResourcePaths> {
  const resourcePaths: SkillResourcePaths = {};

  for (const directoryName of OPTIONAL_RESOURCE_DIRS) {
    const candidatePath = path.join(rootPath, directoryName);
    if (!(await statIfExists(candidatePath))?.isDirectory()) {continue;}
    resourcePaths[directoryName] = await resolveSafeExistingPath(rootPath, candidatePath);
  }

  return resourcePaths;
}

function buildSkillIndex(skills: readonly AgentSkill[]): Map<string, AgentSkill> {
  const skillIndex = new Map<string, AgentSkill>();

  for (const skill of skills) {
    if (skillIndex.has(skill.name)) {
      throw new Error(`Duplicate skill name "${skill.name}" is not allowed`);
    }

    skillIndex.set(skill.name, skill);
  }

  return skillIndex;
}

function isMissingPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function statIfExists(filePath: string): Promise<Stats | undefined> {
  try {
    return await stat(filePath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  }
}

async function statOrThrow(filePath: string, notFoundMessage: string): Promise<Stats> {
  const stats = await statIfExists(filePath);
  if (!stats) {
    throw new Error(notFoundMessage);
  }
  return stats;
}

export async function loadSkill(skillPath: string): Promise<AgentSkill> {
  const resolvedRootPath = path.resolve(skillPath);
  const rootStats = await statOrThrow(resolvedRootPath, `Skill directory not found: ${resolvedRootPath}`);

  if (!rootStats.isDirectory()) {
    throw new Error(`Skill path must be a directory: ${resolvedRootPath}`);
  }

  const rootPath = await realpath(resolvedRootPath);
  const entryPath = path.join(rootPath, SKILL_FILE_NAME);
  const entryStats = await statOrThrow(entryPath, `Skill entry file not found: ${entryPath}`);

  if (!entryStats.isFile()) {
    throw new Error(`Skill entry path must be a file: ${entryPath}`);
  }

  const entryRealPath = await resolveSafeExistingPath(rootPath, entryPath);
  const rawDocument = await readFile(entryRealPath, 'utf8');
  const { metadata, content } = parseSkillDocument(rawDocument);

  return {
    name: metadata.name,
    description: metadata.description,
    metadata,
    content,
    rootPath,
    entryPath: entryRealPath,
    resourcePaths: await readOptionalResourcePaths(rootPath),
  };
}

export async function loadSkills(rootDirectoryPath: string): Promise<AgentSkill[]> {
  const resolvedRootDirectoryPath = path.resolve(rootDirectoryPath);
  const directoryStats = await statOrThrow(
    resolvedRootDirectoryPath,
    `Skills root directory not found: ${resolvedRootDirectoryPath}`,
  );

  if (!directoryStats.isDirectory()) {
    throw new Error(`Skills root path must be a directory: ${resolvedRootDirectoryPath}`);
  }

  const entries = await readdir(resolvedRootDirectoryPath, { withFileTypes: true });
  const skillDirectories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  const discoveredSkills: AgentSkill[] = [];
  for (const directoryName of skillDirectories) {
    const candidatePath = path.join(resolvedRootDirectoryPath, directoryName);
    const candidateEntryPath = path.join(candidatePath, SKILL_FILE_NAME);
    if (!(await statIfExists(candidateEntryPath))?.isFile()) {continue;}
    discoveredSkills.push(await loadSkill(candidatePath));
  }

  buildSkillIndex(discoveredSkills);
  return discoveredSkills;
}

export function renderSkillsPrompt(skills: readonly AgentSkill[]): string {
  if (skills.length === 0) {
    return '';
  }

  const listing = skills
    .map((skill) => `- ${skill.name}: ${skill.description}`)
    .join('\n');

  return [
    'Available skills:',
    listing,
    'If a task matches one of these skills, call `loadskill` with the skill name before using that skill.',
  ].join('\n');
}

export function createLoadSkillTool(skills: readonly AgentSkill[]): Tool {
  const skillIndex = buildSkillIndex(skills);

  return {
    name: LOAD_SKILL_TOOL_NAME,
    description: 'Load the full content for an available skill by name when the system prompt lists a relevant skill.',
    parameters: z.object({
      name: z.string().min(1).describe('The skill name to load.'),
    }),
    execute: async (args: unknown) => {
      const { name } = args as { name: string };
      const skill = skillIndex.get(name);

      if (!skill) {
        throw new Error(`Skill "${name}" not found`);
      }

      return {
        name: skill.name,
        metadata: skill.metadata,
        content: skill.content,
        rootPath: skill.rootPath,
        entryPath: skill.entryPath,
        resourcePaths: skill.resourcePaths,
      };
    },
  };
}
