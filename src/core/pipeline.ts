import { randomUUID } from 'crypto';
import { IUnifiedMessage, IChannelContext, IOutboundMessage, IOutboundPayload, MiddlewareFunc } from './types.js';
import type { ILogger } from '../contracts/logger.js';
import { createNoOpLogger } from '../observability/logger.js';

export interface PipelineDeps {
  logger?: ILogger;
}

export class ChannelPipeline {
  private middlewares: MiddlewareFunc[] = [];
  private deps: PipelineDeps;
  private logger: ILogger;

  constructor(deps: PipelineDeps = {}) {
    this.deps = deps;
    this.logger = deps.logger ?? createNoOpLogger();
  }

  use(middleware: MiddlewareFunc): void {
    this.middlewares.push(middleware);
    this.logger.debug(`Middleware registered (total: ${this.middlewares.length})`);
  }

  async handleInbound(message: IUnifiedMessage): Promise<IChannelContext> {
    return this.handleInboundWithSend(message, undefined);
  }

  async handleInboundWithSend(
    message: IUnifiedMessage,
    sendFn?: (_payload: IOutboundPayload) => Promise<void>
  ): Promise<IChannelContext> {
    const traceId = randomUUID();
    const startTime = Date.now();

    this.logger.info(
      { traceId, chatId: message.chatId, text: message.text },
      `Received inbound message, dispatching to middleware chain`
    );

    const ctx: IChannelContext = {
      traceId,
      inbound: message,
      outbound: {
        text: '',
        mediaFiles: [],
      } as IOutboundMessage,
      createdAt: Date.now(),
      sendFn,
    };

    if (this.middlewares.length === 0) {
      this.logger.warn('Warning: No middleware registered, returning empty response');
      return ctx;
    }

    let index = 0;

    const next: () => Promise<void> = async () => {
      if (index < this.middlewares.length) {
        const currentMiddleware = this.middlewares[index++];
        this.logger.debug(
          { traceId, middlewareIndex: index - 1 },
          `Executing middleware ${index}/${this.middlewares.length}`
        );
        await currentMiddleware(ctx, next);
      } else {
        this.logger.debug({ traceId }, 'Middleware chain completed');
      }
    };

    try {
      await next();

      if (sendFn && ctx.outbound?.text) {
        await sendFn({
          text: ctx.outbound.text,
          mediaFiles: ctx.outbound.mediaFiles,
        });
        this.logger.debug({ traceId, chatId: ctx.inbound.chatId }, 'Response sent via sendFn');
      }

      const duration = Date.now() - startTime;
      const outboundText = ctx.outbound?.text ?? '';
      this.logger.info(
        { traceId, chatId: ctx.inbound.chatId, duration, outboundLength: outboundText.length },
        'Message processing completed, returning response'
      );
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(
        { traceId, chatId: ctx.inbound.chatId, duration, error: errorMessage },
        'Error during message processing'
      );
      if (!ctx.outbound) {
        ctx.outbound = { text: '', mediaFiles: [] };
      }
      ctx.outbound.text = 'Internal system error, please try again later';
      ctx.outbound.error = errorMessage;

      if (sendFn && ctx.outbound?.text) {
        await sendFn({
          text: ctx.outbound.text,
          mediaFiles: ctx.outbound.mediaFiles ?? [],
        });
      }
    }

    return ctx;
  }
}
