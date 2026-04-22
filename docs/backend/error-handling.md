# Error Handling

> How errors are caught, logged, and returned in this project.

---

## Overview

The project uses a **layered error strategy**:
1. **Programming errors** (`AesyiuProgrammingError`) are always rethrown — they indicate bugs
2. **Abort/timeout errors** are propagated without wrapping
3. **Runtime errors** are caught and converted into structured results or safe error messages
4. **Tool execution errors** never throw — they return JSON failure messages

---

## Error Types

### `AesyiuProgrammingError`
Used for invariant violations and API misuse. These must NEVER be swallowed.

```typescript
// src/error/index.ts
export class AesyiuProgrammingError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AesyiuProgrammingError';
  }
}
```

Example usage in `src/engine/index.ts`:
```typescript
if (config?.memoryManager && config.memoryConfig) {
  throw new AesyiuProgrammingError('Provide either memoryManager or memoryConfig, not both');
}
```

### Standard `Error`
Used for runtime errors (missing tools, provider failures, etc.).

---

## Error Handling Patterns

### Pattern 1: Always Rethrow Programming Errors First
Every catch block that might intercept unknown errors must call `rethrowProgrammingError` first.

```typescript
// src/engine/execution-loop.ts
private handleStepError(ctx: AgentContext, error: unknown, signal: AbortSignal | undefined, fallbackSource: EngineErrorSource): EngineResult {
  rethrowProgrammingError(error);
  return this.createErrorResult(ctx, error, this.getErrorSource(error, signal) ?? fallbackSource);
}
```

### Pattern 2: Distinguish Abort Errors
Use `isAbortError(error, signal)` to distinguish user-initiated aborts from real failures.

```typescript
// src/tool/runner.ts
try {
  return await Promise.all(promises);
} catch (error) {
  const isExternalAbort = isAbortError(error, signal);
  toolAbort.abort();
  await Promise.allSettled(promises);
  rethrowProgrammingError(error);
  if (isExternalAbort) {
    throw error;
  }
  throw new Error(getErrorMessage(error));
}
```

### Pattern 3: Tool Errors Return, They Don't Throw
Tool execution failures are returned as structured `tool` messages so the LLM can see what went wrong.

```typescript
// src/tool/runner.ts
function toolFailureMessage(call: ToolCall, error: string): Message {
  return {
    role: 'tool',
    content: JSON.stringify({ success: false, error }),
    tool_call_id: call.id,
  };
}
```

### Pattern 4: Engine Errors Are Returned as Results
The `ExecutionLoop` returns `EngineResult` with `status: 'error'` instead of throwing.

```typescript
// src/types/index.ts
export interface EngineResult {
  status: EngineResultStatus; // 'completed' | 'max_steps_reached' | 'error'
  messages: Message[];
  usage: TokenUsage;
  error?: EngineErrorInfo;
}
```

---

## Error Source Classification

Errors are classified by source for debugging:
- `'provider'` — LLM API failure
- `'memory'` — Memory compression failure
- `'tool'` — Tool execution failure
- `'engine'` — Internal engine error
- `'aborted'` — User abort
- `'timeout'` — Timeout
- `'unknown'` — Unclassified

Example from `src/engine/execution-loop.ts`:
```typescript
private getErrorSource(error: unknown, signal?: AbortSignal): EngineErrorSource | undefined {
  if (signal?.aborted && signal.reason instanceof Error && signal.reason.name === 'TimeoutError') {return 'timeout';}
  if (signal?.aborted && error === signal.reason) {return 'aborted';}
  if (error instanceof Error && error.name === 'TimeoutError') {return 'timeout';}
  if (signal?.aborted && error instanceof Error && error.name === 'AbortError') {return 'aborted';}
  return undefined;
}
```

---

## Anti-patterns

- **Do NOT** catch `AesyiuProgrammingError` and return it as a runtime error — always rethrow
- **Do NOT** throw from tool execution — return `toolFailureMessage` instead
- **Do NOT** swallow abort errors — propagate them so callers know the run was cancelled
- **Do NOT** use `any` for error types — use `unknown` and narrow with `instanceof` or helper functions
- **Do NOT** create generic `try { ... } catch { /* ignore */ }` blocks without at least logging
