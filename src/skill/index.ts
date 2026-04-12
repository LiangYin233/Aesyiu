import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Message, Tool } from '../types/index.js';

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

function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }

  return value;
}

function parseScalar(value: string): SkillMetadataScalar {
  const trimmed = value.trim();

  if (trimmed === 'null') {
    return null;
  }

  if (trimmed === 'true') {
    return true;
  }

  if (trimmed === 'false') {
    return false;
  }

  if (/^[+-]?\d+(?:\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }

  return stripQuotes(trimmed);
}

function parseFrontmatter(frontmatter: string): Record<string, SkillMetadataValue> {
  const parsed: Record<string, SkillMetadataValue> = {};
  const lines = frontmatter.split('\n');

  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    const trimmed = line.trim();

    if (trimmed === '' || trimmed.startsWith('#')) {
      index++;
      continue;
    }

    if (/^\s/.test(line)) {
      throw new Error(`Invalid YAML frontmatter syntax at line ${index + 1}`);
    }

    const match = line.match(/^([A-Za-z0-9_-]+):(.*)$/);
    if (!match) {
      throw new Error(`Invalid YAML frontmatter syntax at line ${index + 1}`);
    }

    const [, key, rawValue] = match;
    const value = rawValue.trim();

    if (value !== '') {
      parsed[key] = parseScalar(value);
      index++;
      continue;
    }

    const listValues: SkillMetadataScalar[] = [];
    index++;

    while (index < lines.length) {
      const listLine = lines[index];
      const listTrimmed = listLine.trim();

      if (listTrimmed === '' || listTrimmed.startsWith('#')) {
        index++;
        continue;
      }

      if (!/^\s/.test(listLine)) {
        break;
      }

      const listMatch = listLine.match(/^\s*-\s+(.*)$/);
      if (!listMatch) {
        throw new Error(`Invalid YAML frontmatter syntax at line ${index + 1}`);
      }

      listValues.push(parseScalar(listMatch[1]));
      index++;
    }

    parsed[key] = listValues;
  }

  return parsed;
}

function parseSkillDocument(rawDocument: string): { metadata: SkillMetadata; content: string } {
  const normalizedDocument = rawDocument.replace(/\r\n/g, '\n');
  const lines = normalizedDocument.split('\n');

  if (lines[0]?.trim() !== '---') {
    throw new Error(`Skill file is missing required YAML frontmatter in ${SKILL_FILE_NAME}`);
  }

  const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (closingIndex === -1) {
    throw new Error(`Skill file has invalid YAML frontmatter in ${SKILL_FILE_NAME}`);
  }

  const metadata = parseFrontmatter(lines.slice(1, closingIndex).join('\n'));
  const name = metadata.name;
  const description = metadata.description;

  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error(`Skill frontmatter must include a non-empty "name" in ${SKILL_FILE_NAME}`);
  }

  if (typeof description !== 'string' || description.trim() === '') {
    throw new Error(`Skill frontmatter must include a non-empty "description" in ${SKILL_FILE_NAME}`);
  }

  return {
    metadata: {
      ...metadata,
      name: name.trim(),
      description: description.trim(),
    },
    content: lines.slice(closingIndex + 1).join('\n').trim(),
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

    try {
      const candidateStat = await stat(candidatePath);
      if (!candidateStat.isDirectory()) {
        continue;
      }

      resourcePaths[directoryName] = await resolveSafeExistingPath(rootPath, candidatePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }

      throw error;
    }
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

export async function loadSkill(skillPath: string): Promise<AgentSkill> {
  const resolvedRootPath = path.resolve(skillPath);
  const rootStats = await stat(resolvedRootPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Skill directory not found: ${resolvedRootPath}`);
    }

    throw error;
  });

  if (!rootStats.isDirectory()) {
    throw new Error(`Skill path must be a directory: ${resolvedRootPath}`);
  }

  const rootPath = await realpath(resolvedRootPath);
  const entryPath = path.join(rootPath, SKILL_FILE_NAME);
  const entryStats = await stat(entryPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Skill entry file not found: ${entryPath}`);
    }

    throw error;
  });

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
  const directoryStats = await stat(resolvedRootDirectoryPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Skills root directory not found: ${resolvedRootDirectoryPath}`);
    }

    throw error;
  });

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

    try {
      const candidateEntryStats = await stat(candidateEntryPath);
      if (!candidateEntryStats.isFile()) {
        continue;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }

      throw error;
    }

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

export function createSkillsPromptMessage(skills: readonly AgentSkill[]): Message | null {
  const content = renderSkillsPrompt(skills);

  if (!content) {
    return null;
  }

  return {
    role: 'system',
    content,
    _meta: {
      isPinned: true,
      skillPrompt: true,
    },
  };
}

export function createLoadSkillTool(skills: readonly AgentSkill[]): Tool {
  const skillIndex = buildSkillIndex(skills);

  return {
    name: LOAD_SKILL_TOOL_NAME,
    description: 'Load the full content for an available skill by name when the system prompt lists a relevant skill.',
    parameters: z.object({
      name: z.string().min(1).describe('The skill name to load.'),
    }),
    execute: async ({ name }) => {
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
