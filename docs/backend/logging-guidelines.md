# Logging Guidelines

> Log levels, format, and what to log in this project.

---

## Overview

This project does **not** use a structured logging library (no Winston, Pino, etc.). Logging is minimal and purpose-driven:
- `console.warn` for non-fatal issues that the operator should know about
- `console.log` only inside the default logging middleware
- Tools and the engine itself do not log normal operations

Users can inject custom logging via the **logging middleware** (`loggingMiddleware`).

---

## Log Levels

| Level | When to Use | Example |
|-------|-------------|---------|
| `warn` | Non-fatal degradation, recovery attempts | Memory compression failed; keeping history |
| `log` | Request/response telemetry (via middleware) | LLM call timing, token usage |
| (none) | Normal operations | Do NOT log every tool call or message by default |

### `console.warn` Example
From `src/memory/index.ts`:
```typescript
} catch (error) {
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    throw error;
  }
  if (isProgrammingError(error)) {
    throw error;
  }
  console.warn('[aesyiu] memory compression failed; keeping existing history', error);
}
```

### `console.log` Example
From `src/middleware/index.ts` (default log function):
```typescript
const log = options?.log ?? ((event) => console.log('[aesyiu:llm]', event));
```

---

## Structured Logging via Middleware

The built-in `loggingMiddleware` emits structured events instead of ad-hoc `console.log` calls.

```typescript
// src/middleware/index.ts
export type LoggingEvent =
  | { phase: 'request'; label: string; model: string; messageCount: number; toolCount: number }
  | { phase: 'response'; label: string; model: string; promptTokens: number; completionTokens: number; durationMs: number }
  | { phase: 'error'; label: string; model: string; error: unknown; durationMs: number };
```

Usage:
```typescript
import { loggingMiddleware } from 'aesyiu';

engine.useLLM(loggingMiddleware({
  log: (event) => myLogger.info(event),
  label: 'production',
}));
```

---

## What to Log

- **LLM requests/responses**: token counts, duration, model ID (via middleware)
- **Retry events**: when `retryMiddleware` retries, it does not log — the caller should wrap with logging middleware
- **Memory compression failures**: `console.warn` with the error object
- **Schema validation warnings**: `console.warn` in `ToolRegistry.register` when a tool uses JSON schema instead of Zod

---

## What NOT to Log

- **API keys or credentials** — never log `ProviderConfig.apiKey`
- **Message content** at `log` level — may contain user PII; use middleware opt-in only
- **Internal state dumps** — do not log full `AgentContext` objects
- **Every step** — the engine does not log step transitions; use the stream consumer to observe them

---

## Anti-patterns

- **Do NOT** add `console.log` for debugging and leave it in production code
- **Do NOT** introduce a heavy logging dependency into the core library — keep it zero-dependency
- **Do NOT** log inside hot loops (e.g., per-token streaming) — middleware handles batch telemetry
- **Do NOT** use `console.error` — the project does not use this level; errors are either thrown or returned as results
