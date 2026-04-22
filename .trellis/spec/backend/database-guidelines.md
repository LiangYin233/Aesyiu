# Database Guidelines

> Database patterns and conventions for this project.

---

## Overview

**This project does not use a database.**

`aesyiu` is a stateless AI Agent framework library. All state is held in memory via `AgentContext` (message history, session state, token usage). There are no persistence layers, ORMs, or database queries.

If you add persistence in the future, create this file with actual conventions.

---

## Current State Management

State is ephemeral and stored in `AgentContext`:
- `messages`: conversation history
- `state`: user-defined key-value state
- `sessionUsage`: accumulated token usage

Example from `src/context/index.ts`:

```typescript
export class AgentContext {
  private _messages: Message[] = [];
  public state: Record<string, unknown>;
  public sessionUsage: TokenUsage;
  // ...
}
```

---

## Anti-patterns

- **Do NOT** introduce a database dependency into the core library without a clear abstraction
- **Do NOT** persist API keys or credentials — they flow through `ProviderConfig` and are never stored
- **Do NOT** make `AgentContext` serialize to disk by default; statelessness is a design goal
