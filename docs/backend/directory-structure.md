# Directory Structure

> How backend code is organized in this project.

---

## Overview

This is a **pure Node.js library** (no frontend). All source code lives under `src/` and is compiled to `dist/` via `tsc`. The project follows a **module-per-domain** layout with each domain exposing its public API through an `index.ts` barrel file.

---

## Directory Layout

```
src/
├── index.ts              # Public API exports (barrel)
├── types/
│   └── index.ts          # Core shared types (Message, Tool, TokenUsage, etc.)
├── context/
│   └── index.ts          # AgentContext: message history, state, LLM switching
├── engine/
│   ├── index.ts          # AesyiuEngine, public middleware types
│   ├── execution-loop.ts # Step-by-step agent execution loop
│   ├── stream.ts         # Middleware-wrapped stream runner
│   ├── event-queue.ts    # Async event queue for stream bridging
│   ├── preparation.ts    # Run preparation (tool/skill resolution, compatibility mode)
│   ├── types.ts          # Engine-specific types (Middleware, LLMMiddleware, etc.)
│   └── utils.ts          # Engine utilities (chainMiddleware, combineAbortSignals, etc.)
├── provider/
│   ├── index.ts          # LLMProvider abstract base class
│   ├── factory/
│   │   └── index.ts      # Factory: createLLMProvider, getDefaultModels
│   ├── anthropic/
│   │   └── index.ts      # Anthropic SDK provider
│   ├── openai-completion/
│   │   └── index.ts      # OpenAI Chat Completions provider
│   └── openai-responses/
│       └── index.ts      # OpenAI Responses API provider
├── tool/
│   ├── registry.ts       # ToolRegistry (global + MCP tool management)
│   ├── runner.ts         # runToolCalls: parallel tool execution
│   └── schema.ts         # Zod/JSON Schema validation utilities
├── mcp/
│   └── index.ts          # MCPManager: MCP server lifecycle
├── memory/
│   └── index.ts          # MemoryManager: token estimation, conversation compression
├── skill/
│   └── index.ts          # Skill loading from SKILL.md (front-matter)
├── middleware/
│   └── index.ts          # Built-in middleware: logging, retry, timeout
└── error/
    └── index.ts          # AesyiuProgrammingError, isProgrammingError
```

---

## Module Organization

### Barrel Files (`index.ts`)
Every module has an `index.ts` that acts as the public API boundary:
- Re-exports types with `export type`
- Re-exports classes/functions with `export`
- Example: `src/engine/index.ts` exports `AesyiuEngine` and all middleware types

### Adding a New Provider
1. Create `src/provider/<name>/index.ts`
2. Extend `LLMProvider` from `src/provider/index.ts`
3. Export model definitions as a const array
4. Register in `src/provider/factory/index.ts` under `PROVIDERS` record

### Adding a New Middleware
1. Define the middleware function in `src/middleware/index.ts` or a new file
2. Export the factory function and its options interface
3. Re-export from `src/index.ts`

---

## Naming Conventions

| Pattern | Convention | Example |
|---------|------------|---------|
| Files | `kebab-case.ts` | `execution-loop.ts`, `event-queue.ts` |
| Barrel files | `index.ts` | Every module root |
| Classes | `PascalCase` | `AesyiuEngine`, `ExecutionLoop` |
| Types/Interfaces | `PascalCase` | `LLMMiddleware`, `AgentContextConfig` |
| Functions | `camelCase` | `chainMiddleware`, `combineAbortSignals` |
| Constants | `UPPER_SNAKE_CASE` or `camelCase` | `ANTHROPIC_MODELS`, `SKILL_PROMPT_SECTION` |
| Private members | `camelCase` with `private` modifier | `private toolRegistry` |
| Parameters | `camelCase` with leading underscore allowed | `_ctx`, `options` |

---

## Examples

### Well-organized module: `src/engine/`
- `index.ts` is the public API (exports `AesyiuEngine`, middleware types)
- Internal implementation lives in sibling files (`execution-loop.ts`, `stream.ts`, `utils.ts`)
- Types co-located in `types.ts`

### Well-organized module: `src/provider/`
- Abstract base in `provider/index.ts`
- Each provider in its own directory (`anthropic/`, `openai-completion/`)
- Factory centralizes instantiation logic in `provider/factory/index.ts`

---

## Anti-patterns

- **Do NOT** put implementation directly in `src/index.ts` — use barrel exports only
- **Do NOT** create deep directory nesting (max 3 levels under `src/`)
- **Do NOT** mix public and internal types in the same file without a barrel to separate concerns
