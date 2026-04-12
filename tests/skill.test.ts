import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLoadSkillTool, loadSkill, loadSkills, renderSkillsPrompt } from '../src/skill/index.js';

const tempDirectories: string[] = [];

async function createTempDirectory(): Promise<string> {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'aesyiu-skill-'));
  tempDirectories.push(tempDirectory);
  return tempDirectory;
}

async function writeSkill(rootPath: string, directoryName: string, contents: string): Promise<string> {
  const skillDirectory = path.join(rootPath, directoryName);
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(path.join(skillDirectory, 'SKILL.md'), contents, 'utf8');
  return skillDirectory;
}

afterEach(async () => {
  while (tempDirectories.length > 0) {
    await rm(tempDirectories.pop()!, { recursive: true, force: true });
  }
});

describe('skill loading', () => {
  it('loads a single skill with frontmatter and optional resource directories', async () => {
    const tempRoot = await createTempDirectory();
    const skillDirectory = await writeSkill(tempRoot, 'writer', `---
name: writer
description: Writing style guide
tags:
  - docs
  - tone
---
# Writer Skill

Use concise language.
`);

    await mkdir(path.join(skillDirectory, 'scripts'));
    await mkdir(path.join(skillDirectory, 'references'));

    const skill = await loadSkill(skillDirectory);

    expect(skill.name).toBe('writer');
    expect(skill.description).toBe('Writing style guide');
    expect(skill.metadata.tags).toEqual(['docs', 'tone']);
    expect(skill.content).toContain('# Writer Skill');
    expect(skill.resourcePaths.scripts).toBeDefined();
    expect(skill.resourcePaths.references).toBeDefined();
    expect(skill.resourcePaths.assets).toBeUndefined();
  });

  it('discovers multiple skills from a root directory', async () => {
    const tempRoot = await createTempDirectory();
    await writeSkill(tempRoot, 'beta', `---
name: beta
description: Beta skill
---
Beta body
`);
    await writeSkill(tempRoot, 'alpha', `---
name: alpha
description: Alpha skill
---
Alpha body
`);
    await mkdir(path.join(tempRoot, 'not-a-skill'));

    const skills = await loadSkills(tempRoot);

    expect(skills.map((skill) => skill.name)).toEqual(['alpha', 'beta']);
  });

  it('rejects skill files without frontmatter', async () => {
    const tempRoot = await createTempDirectory();
    const skillDirectory = await writeSkill(tempRoot, 'broken', '# Missing frontmatter');

    await expect(loadSkill(skillDirectory)).rejects.toThrow('missing required YAML frontmatter');
  });

  it('rejects skill files with invalid frontmatter syntax', async () => {
    const tempRoot = await createTempDirectory();
    const skillDirectory = await writeSkill(tempRoot, 'broken', `---
name invalid
description: Broken skill
---
Oops
`);

    await expect(loadSkill(skillDirectory)).rejects.toThrow('Invalid YAML frontmatter syntax');
  });

  it('requires name and description in frontmatter', async () => {
    const tempRoot = await createTempDirectory();
    const skillDirectory = await writeSkill(tempRoot, 'broken', `---
name: missing-description
---
Oops
`);

    await expect(loadSkill(skillDirectory)).rejects.toThrow('must include a non-empty "description"');
  });
});

describe('skill prompt and tool helpers', () => {
  it('renders a prompt using only name and description', async () => {
    const tempRoot = await createTempDirectory();
    const skillDirectory = await writeSkill(tempRoot, 'writer', `---
name: writer
description: Writing style guide
---
Full secret body
`);
    const skill = await loadSkill(skillDirectory);

    const prompt = renderSkillsPrompt([skill]);

    expect(prompt).toContain('writer: Writing style guide');
    expect(prompt).not.toContain('Full secret body');
    expect(prompt).toContain('loadskill');
  });

  it('returns full skill data from loadskill', async () => {
    const tempRoot = await createTempDirectory();
    const skillDirectory = await writeSkill(tempRoot, 'writer', `---
name: writer
description: Writing style guide
category: editorial
---
Full skill body
`);
    const skill = await loadSkill(skillDirectory);
    const tool = createLoadSkillTool([skill]);

    const result = await tool.execute({ name: 'writer' }, {});

    expect(result.name).toBe('writer');
    expect(result.metadata.category).toBe('editorial');
    expect(result.content).toContain('Full skill body');
  });

  it('returns an error for unknown skill names', async () => {
    const tempRoot = await createTempDirectory();
    const skillDirectory = await writeSkill(tempRoot, 'writer', `---
name: writer
description: Writing style guide
---
Full skill body
`);
    const skill = await loadSkill(skillDirectory);
    const tool = createLoadSkillTool([skill]);

    await expect(tool.execute({ name: 'missing' }, {})).rejects.toThrow('Skill "missing" not found');
  });
});
