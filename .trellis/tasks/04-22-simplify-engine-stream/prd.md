# Simplify Engine Stream Control Flow

## Problem Statement

The `execution-loop.ts` and `stream.ts` modules contain **significant code duplication** and **over-designed async flow control** that makes the engine hard to maintain and extend.

### Specific Issues

1. **80% Logic Duplication in `streamLLMStep()`**
   - The "no middleware" branch and "middleware" branch both:
     - Create `content`, `toolCalls`, `usage` variables
     - Iterate the provider stream with `for await`
     - Handle 4 identical event types (`response_started`, `text`, `tool_calls`, `usage`)
     - Assemble the same `Message` object at the end
   - Only difference: direct `yield` vs `queue.push()` then consume

2. **`EventQueue` is Over-Engineered**
   - 39 lines of manual async iterator state management
   - Used only to bridge middleware-wrapped promises with the outer generator
   - Can be replaced with a simpler generator-wrapper pattern

3. **Mixed Responsibilities**
   - `ExecutionLoop` handles: step looping, stream parsing, middleware adaptation, error classification
   - `stream.ts` reimplements a similar EventQueue pattern for user middleware

## Goals

1. **Eliminate duplication**: Extract shared stream consumption logic into a single function
2. **Remove `EventQueue`**: Replace with simpler async generator composition
3. **Reduce code size**: Target 40-50% reduction in `execution-loop.ts` + `stream.ts`
4. **Preserve behavior**: All existing stream events, middleware hooks, abort handling remain identical

## Non-Goals

- Do NOT change public API (`AesyiuEngine`, middleware interfaces, `RunStreamEvent` types)
- Do NOT change provider implementations
- Do NOT change tool execution logic
- Do NOT add new features

## Proposed Changes

### Change 1: Extract `consumeLLMStream()`

Create a standalone function that converts a provider `AsyncIterable<StreamEvent>` into `{ message, usage }` while optionally yielding `RunStreamEvent` text deltas.

**Location**: `src/engine/stream-consumer.ts` (new file)

### Change 2: Simplify `streamLLMStep()`

After extraction, `streamLLMStep()` should:
1. Call `executeWithLLMMiddleware()` to get the stream (handles middleware wrapping)
2. `yield*` from `consumeLLMStream()` to handle all stream parsing

This removes the two duplicate `for await` loops.

### Change 3: Remove `EventQueue`

Replace the queue-based event bridging with a simpler pattern:
- For LLM middleware: middleware wraps the `generateStream` call, not the generator consumption
- For user middleware: if middleware only needs to intercept the final `EngineResult`, we can wrap the core runner without needing a separate event queue

**Decision**: Keep `EventQueue` removal as a follow-up if the stream extraction alone achieves the primary goal. The initial PR should focus on deduplication.

### Change 4: Remove `response_started` Event Handling

The `response_started` event from providers is set but never used meaningfully in the engine. It only sets `middlewareContext.responseStarted = true`. If no middleware relies on this flag for critical behavior, we can simplify the switch statement.

**Verification needed**: Check if `retryMiddleware` or any custom middleware uses `ctx.responseStarted`.

From code review: `retryMiddleware` DOES use it:
```typescript
if (ctx.streamOutput && ctx.responseStarted) {
  throw error; // don't retry after stream started
}
```
So `response_started` must be preserved.

## Implementation Plan

### Phase 1: Extract `consumeLLMStream()`
- [ ] Create `src/engine/stream-consumer.ts`
- [ ] Move shared stream parsing logic from both branches of `streamLLMStep()`
- [ ] Update `execution-loop.ts` to import and use `consumeLLMStream()`
- [ ] Run lint + typecheck

### Phase 2: Unify `streamLLMStep()` branches
- [ ] Rewrite `streamLLMStep()` to:
  - Create combined abort signal
  - Call `executeWithLLMMiddleware()` to get stream
  - `yield*` from `consumeLLMStream()`
- [ ] Remove the duplicate inline stream parsing
- [ ] Run lint + typecheck

### Phase 3: Evaluate `EventQueue` removal
- [ ] Assess if `EventQueue` can be removed after Phase 2
- [ ] If yes, implement in follow-up commit
- [ ] If no, document why it remains necessary

## Acceptance Criteria

- [ ] `execution-loop.ts` line count reduced by ~40% (target: <180 lines from 297)
- [ ] `npm run lint` passes
- [ ] `npm run typecheck` passes
- [ ] No public API changes
- [ ] All middleware behavior preserved (logging, retry, timeout)
- [ ] AbortSignal propagation unchanged
- [ ] Stream events (`step_start`, `text_delta`, `assistant_message`, `tool_call`, `tool_result`, `step_end`) emitted in identical order

## Risks

| Risk | Mitigation |
|------|-----------|
| Middleware break | Preserve exact `LLMMiddlewareContext` shape and timing |
| Stream event ordering change | Add explicit ordering comments/tests |
| AbortSignal timing change | Ensure `internalAbort` is created and aborted in the same scope |
| Type inference regression | Use explicit return types on extracted functions |

## Follow-up Work

- Evaluate removing `EventQueue` from `stream.ts`
- Add unit tests for `consumeLLMStream()`
- Consider further simplifying `getErrorSource()` logic
