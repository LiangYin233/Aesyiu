# Quality Guidelines

> Code review standards, testing requirements, and forbidden patterns.

---

## Overview

This project enforces quality through **strict TypeScript**, **ESLint with custom rules**, and **architectural patterns** (onion middleware, provider abstraction). There is **no test suite currently** — correctness is validated via lint and type-check.

---

## Linting & Type Checking

Run before committing:
```bash
npm run lint      # ESLint on src/**/*.ts
npm run typecheck # tsc --noEmit
```

### ESLint Configuration (`eslint.config.cjs`)
Key rules enforced:
- `curly: ['error', 'all']` — **all control statements must use braces**
- `eqeqeq: ['error', 'always']` — **strict equality only**
- `semi: ['error', 'always']` — semicolons required
- `@typescript-eslint/consistent-type-imports` — use `import type` for types
- `@typescript-eslint/no-floating-promises` — unhandled promises are errors
- `@typescript-eslint/only-throw-error` — only throw Error instances
- `n/no-unsupported-features/es-builtins` — enforces Node >= 22 compatibility

### Naming Convention Rules
- `camelCase` for variables, functions, parameters
- `PascalCase` for types, classes, interfaces
- `UPPER_CASE` allowed for `const` variables
- Leading underscore allowed for private members and unused parameters

---

## Forbidden Patterns

### 1. Using `any` instead of `unknown`
**Forbidden**:
```typescript
const params: Record<string, any> = { ... };
```
**Required**:
```typescript
const params: Record<string, unknown> = { ... };
// Cast through `unknown` when needed for SDK compatibility
merged as unknown as Anthropic.MessageCreateParamsNonStreaming
```
*Rationale*: `strict: true` is enabled; `any` bypasses the type system.

### 2. Missing Braces on Control Statements
**Forbidden**:
```typescript
if (x) return;
```
**Required**:
```typescript
if (x) { return; }
```
*Rationale*: `curly: all` ESLint rule prevents dangling-statement bugs.

### 3. Floating Promises
**Forbidden**:
```typescript
someAsyncFunction(); // unhandled
```
**Required**:
```typescript
await someAsyncFunction();
// or
void someAsyncFunction(); // explicitly fire-and-forget
```
*Rationale*: `@typescript-eslint/no-floating-promises` catches unhandled rejections.

### 4. Mixing Type and Value Imports
**Forbidden**:
```typescript
import { Message, AgentContext } from './types.js';
// if Message is only used as a type
```
**Required**:
```typescript
import type { Message } from './types.js';
import { AgentContext } from './types.js';
```
*Rationale*: `@typescript-eslint/consistent-type-imports` keeps imports clean and tree-shakeable.

### 5. Swallowing Programming Errors
**Forbidden**:
```typescript
try { ... } catch (error) {
  return { status: 'error', error };
}
```
**Required**:
```typescript
try { ... } catch (error) {
  rethrowProgrammingError(error);
  return { status: 'error', error };
}
```
*Rationale*: `AesyiuProgrammingError` indicates a bug; it must never be masked as a runtime error.

### 6. Using `var`
**Forbidden**: `var` declarations.
**Required**: `const` (preferred) or `let`.

### 7. Node < 22 APIs
**Forbidden**: APIs not available in Node 22 (e.g., old timers without `node:` prefix where applicable).
**Required**: Use modern APIs like `AbortSignal.any`, `Object.groupBy`, `node:timers/promises`.

---

## Required Patterns

### 1. Explicit Access Modifiers
Always declare `public` or `private` on class members.
```typescript
export class AesyiuEngine {
  private toolRegistry = new ToolRegistry();
  public registerTool(tool: Tool): this { ... }
}
```

### 2. AbortSignal for Cancellation
All async operations that can be long-running must accept and respect `AbortSignal`.
```typescript
public async generateStream(
  model: ModelDefinition | string,
  messages: Message[],
  tools?: Tool[],
  options?: GenerateOptions,
): AsyncGenerator<StreamEvent, void> {
  // respect options?.signal
}
```

### 3. Builder Pattern for Engine Configuration
`AesyiuEngine` methods return `this` for chaining.
```typescript
engine
  .registerTool(myTool)
  .useLLM(loggingMiddleware())
  .use(retryMiddleware());
```

### 4. Symbol.asyncDispose
Disposable resources implement `[Symbol.asyncDispose]`.
```typescript
public async [Symbol.asyncDispose](): Promise<void> {
  await this.dispose();
}
```

---

## Testing Requirements

**Current state**: No test framework is configured. `package.json` does not have a `test` script.

If adding tests in the future:
- Use **Vitest** or **Node.js native test runner** (aligns with Node >= 22)
- Place tests alongside source files or in a `tests/` directory
- Test middleware chains, provider adapters, and tool registry edge cases

---

## Code Review Checklist

- [ ] `npm run lint` passes with zero errors
- [ ] `npm run typecheck` passes with zero errors
- [ ] All new catch blocks call `rethrowProgrammingError(error)` first
- [ ] `import type` used for type-only imports
- [ ] `unknown` used instead of `any`
- [ ] Braces on all control statements (`if`, `while`, `for`)
- [ ] `AbortSignal` propagated through new async operations
- [ ] No `console.log` left in library code (middleware defaults are OK)
- [ ] Public API changes reflected in `src/index.ts`

---

## Common Mistakes

1. **Forgetting `rethrowProgrammingError`** in a new catch block — always add it
2. **Using `any` for SDK params** — use `Record<string, unknown>` + `as unknown as` cast
3. **Not returning `this` from builder methods** on `AesyiuEngine`
4. **Forgetting to add exports to `src/index.ts`** — the public API is explicitly curated
5. **Missing `node:` prefix on built-in imports** — e.g., `import { readFileSync } from 'node:fs'`
