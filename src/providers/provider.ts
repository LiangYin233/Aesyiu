import { ProviderType, type Model, type Provider } from './types.js';

export function model(
  id: string,
  contextWindow: number,
  extraBody?: Record<string, unknown>
): Model {
  return { id, contextWindow, extraBody };
}

export function provider(
  id: string,
  type: ProviderType,
  apiKey: string,
  models: Model[],
  baseUrl?: string,
  timeout?: number,
  extra?: Record<string, unknown>
): Provider {
  if (!models || models.length === 0) {
    throw new Error('Provider must have at least one model');
  }
  return { id, type, apiKey, models, baseUrl, timeout, extra };
}