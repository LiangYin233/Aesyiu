# Aesyiu

无状态、高并发的 AI Agent 框架，支持洋葱模型中间件、动态 LLM 切换、Skill 系统和 MCP 集成。

## 安装

```bash
npm install aesyiu
```

## 快速开始

```typescript
import { 
  AesyiuEngine, 
  AgentContext, 
  OpenAIResponsesProvider, 
  OPENAI_RESPONSES_MODELS 
} from 'aesyiu';

const provider = new OpenAIResponsesProvider(
  { apiKey: process.env.OPENAI_API_KEY! },
  OPENAI_RESPONSES_MODELS
);

const ctx = new AgentContext({ provider, modelId: 'gpt-4o-mini' });
const engine = new AesyiuEngine();

const result = await engine.run(
  { role: 'user', content: '你好！' },
  ctx
);

if (result.status === 'error') {
  console.error(result.error?.source, result.error?.message);
} else {
  console.log(result.messages.at(-1)?.content);
}
```

## 核心概念

### Provider

内置三种 LLM 提供商：

```typescript
// OpenAI Responses API
const openai = new OpenAIResponsesProvider(
  { apiKey },
  OPENAI_RESPONSES_MODELS
);

// OpenAI Chat Completion API
const completion = new OpenAICompletionProvider(
  { apiKey },
  OPENAI_COMPLETION_MODELS
);

// Anthropic Claude
const claude = new AnthropicProvider(
  { apiKey },
  ANTHROPIC_MODELS
);
```

### Context

管理对话上下文和模型切换：

```typescript
const ctx = new AgentContext({ provider, modelId: 'gpt-4o' });

// 动态切换模型
ctx.switchLLM(otherProvider, 'claude-3-5-sonnet');

// 添加系统消息
ctx.addMessage({ role: 'system', content: '你是助手' });

// 获取消息列表
const messages = ctx.getMessages();
```

### Engine

执行引擎，支持工具注册：

```typescript
const engine = new AesyiuEngine({ maxSteps: 10 });

// 注册工具
engine.registerTool({
  name: 'calculator',
  description: '计算数学表达式',
  parameters: {
    type: 'object',
    properties: { expr: { type: 'string' } },
    required: ['expr']
  },
  async execute({ expr }) {
    return eval(expr);
  }
});

// 运行
const result = await engine.run(input, ctx);
// result.status: 'completed' | 'max_steps_reached' | 'error'
// result.messages: 完整对话历史
// result.usage: Token 使用量
// result.error?: 失败时的结构化诊断信息
```

## 进阶用法

### 中间件

洋葱模型中间件，支持 pre/post 处理：

```typescript
engine.use(async (ctx, next) => {
  console.log('执行前消息数:', ctx.getMessages().length);
  await next();
  console.log('执行后消息数:', ctx.getMessages().length);
});
```

### Skill 系统

加载并使用：

```typescript
import { loadSkills } from 'aesyiu';

const skills = await loadSkills('./skills');
engine.registerSkills(skills);

// 单次运行限定技能
await engine.run(input, ctx, { skills: ['code-reviewer'] });
```

## 类型速查

| 类型 | 说明 |
|-----|------|
| `Message` | `{ role, content, tool_calls?, tool_call_id? }` |
| `Tool` | `{ name, description, parameters, execute }` |
| `EngineResult` | `{ status, messages, usage, error? }` |
| `Middleware` | `(ctx, next) => Promise<void>` |