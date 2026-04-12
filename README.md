# Aesyiu

Stateless, high-concurrency AI agent framework with middleware, tool execution, and pluggable LLM providers.

## Agent Skills

Agent Skills are local skill packages with a `SKILL.md` entry file. `SKILL.md` must start with YAML frontmatter that includes at least `name` and `description`.

Example layout:

```text
my-skill/
  SKILL.md
  scripts/
  references/
  assets/
```

Example `SKILL.md`:

```md
---
name: writer
description: Writing style guide for product docs
tags:
  - docs
  - tone
---

# Writer Skill

Use concise language and lead with the outcome.
```

Usage:

```ts
import { AgentContext, AesyiuEngine, loadSkills } from 'aesyiu';

const skills = await loadSkills('./skills');
const engine = new AesyiuEngine().registerSkills(skills);

const ctx = new AgentContext({
  provider,
});

await engine.run({ role: 'user', content: 'Help me write release notes' }, ctx);
```

When skills are registered:
- the runtime injects a system message listing each skill's `name` and `description`
- the model is told to call `loadskill` when a listed skill is relevant
- `loadskill` returns the selected skill's full frontmatter metadata, Markdown body, and resource paths
