import { MessageRole } from '../llm/types.js';

export class RoleUtils {
  private static readonly LABELS: Record<MessageRole, string> = {
    [MessageRole.System]: '[System]',
    [MessageRole.User]: '[User]',
    [MessageRole.Assistant]: '[Assistant]',
    [MessageRole.Tool]: '[Tool]',
  };

  private static readonly TOKEN_WEIGHTS: Record<MessageRole, number> = {
    [MessageRole.System]: 5,
    [MessageRole.User]: 3,
    [MessageRole.Assistant]: 3,
    [MessageRole.Tool]: 5,
  };

  static getLabel(role: MessageRole): string {
    return this.LABELS[role];
  }

  static getTokenWeight(role: MessageRole): number {
    return this.TOKEN_WEIGHTS[role];
  }
}
