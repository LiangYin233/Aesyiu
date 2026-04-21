<h1 align="center">Aesyiu</h1>

<p align="center"><strong>Aesyiu — As you wish</strong></p>

<p align="center">
  <img src="https://img.shields.io/npm/v/aesyiu" alt="npm version" />
  <img src="https://img.shields.io/badge/License-MIT-green" alt="MIT License" />
  <img src="https://img.shields.io/badge/Node-%3E=20-339933" alt="Node 20+" />
  <img src="https://img.shields.io/badge/Skills-Support-7C3AED" alt="Skill System" />
  <img src="https://img.shields.io/badge/MCP-Support-0A7EA4" alt="MCP Ready" />
</p>

<p align="center">无状态、高并发的 TypeScript AI Agent 框架。洋葱模型中间件、动态 LLM 切换、流式 / AbortSignal、Skill 系统、MCP 集成。</p>

## 特性

- **统一 ReAct 循环** — `engine.run()` 阻塞返回；`engine.runStream()` 产出增量事件，共享同一套 middleware / memory 逻辑
- **三层 middleware**
  - `use(mw)` 洋葱模型，包裹整个 `run`
  - `useLLM(mw)` 拦截每次 LLM 调用（retry / timeout / logging）
  - `useTool(mw)` 拦截每次工具调用（可改写 `args`）
- **内建 middleware** — `loggingMiddleware` / `retryMiddleware` / `timeoutMiddleware`（基于 `AbortSignal.any` 真正传递取消）
- **AbortSignal** — `RunOptions.signal` 贯穿到 provider SDK；超时 / 用户中止即时退出
- **Skill + MCP** — 文件系统加载 Skill，stdio MCP 服务器注册 / 卸载 / 状态查询
- **动态模型** — provider 可注册多 model；`generate(ModelDefinition | string, ...)` 按需切换
- **类型严格** — `Tool<TArgs, TResult>` 泛型、`AgentContext<TState>` 泛型、`ToolParameters = ZodType | JSONSchema` 可判别
- **资源管理** — `Symbol.asyncDispose` 原生支持 `await using`

## 环境要求

- Node.js **≥ 20**（用到 `AbortSignal.any` / `node:timers/promises`）
- TypeScript **≥ 5.6** 使用方（如需 `await using` 语法）

## 安装

```bash
npm install aesyiu
```

## 快速开始

```typescript
import {
  AesyiuEngine,
  AgentContext,
  createLLMProvider,
  getDefaultModels,
} from 'aesyiu';

const provider = createLLMProvider({
  type: 'anthropic',
  config: { apiKey: process.env.ANTHROPIC_API_KEY! },
  models: getDefaultModels('anthropic'),
});

const ctx = new AgentContext({ provider, modelId: 'claude-sonnet-4-6' });
const engine = new AesyiuEngine({ maxSteps: 10 });

const result = await engine.run(
  { role: 'user', content: '你好' },
  ctx,
);

if (result.status === 'error') {
  console.error(result.error?.source, result.error?.message);
} else {
  console.log(result.visibleMessages.at(-1)?.content);
}
```

## 核心概念

### Provider

```typescript
import {
  createLLMProvider,
  getDefaultModel,
  getDefaultModels,
} from 'aesyiu';

// Anthropic Claude — 包含 Opus 4.7 / Sonnet 4.6 / Haiku 4.5
const claude = createLLMProvider({
  type: 'anthropic',
  config: { apiKey },
  models: getDefaultModels('anthropic'),
});

// OpenAI Responses API（新接口，支持 reasoning）
const oa = createLLMProvider({
  type: 'openai-responses',
  config: { apiKey },
  models: getDefaultModels('openai-responses'),
});

// OpenAI Chat Completions（经典接口）
const oac = createLLMProvider({
  type: 'openai-completion',
  config: { apiKey },
  models: getDefaultModels('openai-completion'),
});

// 精确拿一个内建模型定义
const sonnet = getDefaultModel('anthropic', 'claude-sonnet-4-6');
```

**动态注册 model / 传 inline definition**：

```typescript
provider.registerModel({
  id: 'custom-model-id',
  contextWindow: 200000,
  maxOutputTokens: 8192,
});

// 或者不走 supportedModels，直接传 ModelDefinition 给 generate
await provider.generate(
  { id: 'custom-id', contextWindow: 128000, maxOutputTokens: 4096 },
  messages,
);
```

### Context

```typescript
// 基本用法
const ctx = new AgentContext({ provider, modelId: 'gpt-4o' });

// 带类型化 state（泛型）
interface MyState { chatId: string; traceId: string }
const ctx = new AgentContext<MyState>({
  provider,
  initialState: { chatId: 'c-1', traceId: 't-1' },
});
ctx.state.chatId;  // 有类型

// 动态切换 LLM
ctx.switchLLM(anotherProvider, 'claude-haiku-4-5-20251001');

// 消息读取（返回 readonly，不可外部改写）
const all: readonly Message[] = ctx.messages;
const visible = ctx.getVisibleMessages();  // 过滤内部 prompt
```

### Engine

```typescript
const engine = new AesyiuEngine({
  maxSteps: 10,
  compatibilityMode: false,   // 多个 system message 合并成一条（第三方兼容 provider）
  memoryConfig: {             // 上下文压缩阈值
    compressThresholdRatio: 0.8,
    retainLatestMessages: 5,
  },
});
```

### EngineResult

```typescript
interface EngineResult {
  status: 'completed' | 'max_steps_reached' | 'error';
  messages: Message[];         // 完整历史，含内部 prompt
  visibleMessages: Message[];  // 对外消息，过滤 _meta.internal
  usage: TokenUsage;
  error?: {
    message: string;
    source: 'provider' | 'memory' | 'tool' | 'engine' | 'aborted' | 'unknown';
    cause?: string;  // stack or String(original)
  };
}
```

## 工具

### `defineTool`（推荐）

```typescript
import { defineTool } from 'aesyiu';
import { z } from 'zod';

const calculator = defineTool({
  name: 'calculator',
  description: '计算数学表达式',
  parameters: z.object({ expr: z.string() }),   // Zod 自动校验
  async execute({ expr }) {                      // args 已经是 { expr: string }
    return Function('"use strict";return (' + expr + ')')();
  },
});

engine.registerTool(calculator);
```

### Zod vs JSONSchema

`Tool.parameters` 接受 `ZodType | JSONSchema`：
- **Zod**：运行时自动 `safeParse` 校验，失败返回错误信封
- **JSONSchema**：透传给 provider，**不做运行时校验**（ToolExecutor 会 `console.warn` 一次）

### 过滤运行时工具

```typescript
await engine.run(input, ctx, {
  tools: ['calculator', 'search'],  // 仅启用这些
});
```

## 中间件

三类中间件职责明确：

### 1. User middleware — `use(mw)`

包裹整个 `run()`，适合鉴权 / 计时 / 全局日志：

```typescript
engine.use(async (ctx, next) => {
  console.time('run');
  await next();
  console.timeEnd('run');
});
```

### 2. LLM middleware — `useLLM(mw)`

拦截每次 LLM 调用（包含 memory summarize），支持修改 options、重试、超时：

```typescript
import { loggingMiddleware, retryMiddleware, timeoutMiddleware } from 'aesyiu';

engine
  .useLLM(loggingMiddleware({ label: 'main' }))
  .useLLM(retryMiddleware({ maxRetries: 3, initialDelayMs: 500 }))
  .useLLM(timeoutMiddleware({ ms: 30_000 }));  // AbortSignal 真正传递到 SDK
```

自定义：

```typescript
engine.useLLM(async (ctx, next) => {
  // ctx.model / ctx.messages / ctx.tools / ctx.options / ctx.agentContext
  // 可覆盖 options：
  ctx.options = { ...ctx.options, signal: newSignal };
  return next();
});
```

### 3. Tool middleware — `useTool(mw)`

拦截每次工具调用，可改写 `args`：

```typescript
engine.useTool(async (ctx, next) => {
  // 注入 tenant 上下文
  ctx.args = { ...(ctx.args as object), tenantId: 'abc' };
  const raw = await next();    // raw 是 tool.execute 的原值
  return raw;
});
```

## 流式运行（`runStream`）

```typescript
for await (const event of engine.runStream(input, ctx, { signal })) {
  switch (event.type) {
    case 'text_delta':
      process.stdout.write(event.delta);  // 增量字符
      break;
    case 'tool_call':
      console.log('\n[tool]', event.toolCall.name);
      break;
    case 'tool_result':
      // event.message 是工具结果消息
      break;
    case 'step_end':
      console.log('\n--- step', event.step);
      break;
  }
}
// 生成器 return 值就是最终 EngineResult
```

`runStream` 与 `run` 共享 LLM / Tool middleware（包括 retry / timeout），只在输出形态上不同。

## 中止（AbortSignal）

```typescript
const controller = new AbortController();
setTimeout(() => controller.abort(), 5_000);

const result = await engine.run(input, ctx, { signal: controller.signal });
// result.status === 'error' && result.error.source === 'aborted'
```

工具内、provider 内、memory summarize 都会收到 signal 并立即退出。

## Skill 系统

文件系统目录结构：

```
skills/
  code-reviewer/
    SKILL.md            # YAML frontmatter + markdown body
    scripts/            # 可选
    references/         # 可选
```

```typescript
import { loadSkills } from 'aesyiu';

const skills = await loadSkills('./skills');
engine.registerSkills(skills);

// 单次运行限定
await engine.run(input, ctx, { skills: ['code-reviewer'] });
```

Skill 注册时会自动注入 `loadskill` 工具 + 一条可见 skill prompt（标记为 `_meta.internal = true`，默认不出现在 `visibleMessages` 中）。

## MCP（Model Context Protocol）

```typescript
await engine.registerMCPServer({
  name: 'filesystem',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
});

// 运行时动态卸载
await engine.unregisterMCPServer('filesystem');

// 状态查询
const mcp = engine.getMCPManager();
mcp.listServers();        // MCPServerStatus[]
mcp.getServer('name');    // MCPServerStatus | undefined
mcp.isRegistered('name'); // boolean
```

## Prompt Sections

在 `ctx` 上注册可替换的系统提示段（框架内部 skill 也用此机制）：

```typescript
ctx.registerPromptSection('app:role', {
  content: '你是代码审查员',
  pinned: true,
});

// 再次注册同名会替换而非追加
ctx.registerPromptSection('app:role', { content: '你是安全审计员' });

// 移除
ctx.removePromptSection('app:role');
```

注册的消息带 `_meta.internal = true`，不出现在 `result.visibleMessages` 中。

## Memory（上下文压缩）

```typescript
import { MemoryManager } from 'aesyiu';

const memory = new MemoryManager({
  compressThresholdRatio: 0.75,  // 占满 75% 上下文时压缩
  retainLatestMessages: 8,       // 保留最近 8 条
});

const engine = new AesyiuEngine({ memoryManager: memory });
// 或短手
const engine = new AesyiuEngine({ memoryConfig: { retainLatestMessages: 8 } });
```

压缩过程会通过 `useLLM` middleware chain — retry / timeout 对 summarize 同样生效。

## 资源管理

```typescript
await using engine = new AesyiuEngine();
await engine.registerMCPServer(...);
// 作用域结束自动 dispose：关闭所有 MCP server

// 等价：
const engine = new AesyiuEngine();
try {
  /* ... */
} finally {
  await engine.dispose();
}
```

## 工具函数

```typescript
import { isAbortError, filterVisibleMessages } from 'aesyiu';

// 判断错误是否由 AbortSignal 触发
try {
  await engine.run(...);
} catch (err) {
  if (isAbortError(err, signal)) {
    // 用户中止 or 超时
  }
}

// 过滤 _meta.internal 的对外消息
const visible = filterVisibleMessages(ctx.messages);
```

## 类型速查

| 类型 | 说明 |
|---|---|
| `Message` | `{ role, content, tool_calls?, tool_call_id?, _meta? }` |
| `Tool<TArgs, TResult>` | 泛型工具定义 |
| `ToolParameters` | `ZodType \| JSONSchema` |
| `ToolResultEnvelope<T>` | `{ success, result?, error? }` |
| `EngineResult` | `{ status, messages, visibleMessages, usage, error? }` |
| `RunOptions` | `{ tools?, skills?, signal? }` |
| `RunStreamEvent` | `step_start \| text_delta \| assistant_message \| tool_call \| tool_result \| step_end` |
| `Middleware` | `(ctx, next) => Promise<void>` |
| `LLMMiddleware` | `(ctx, next) => Promise<{ message, usage }>` |
| `ToolMiddleware` | `(ctx, next) => Promise<unknown>` |

## License

MIT
