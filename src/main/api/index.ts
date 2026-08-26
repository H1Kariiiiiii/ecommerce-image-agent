import { VolcanoCvProvider } from './volcanoCv'
import { OpenAiCompatProvider } from './openaiCompat'
import { DashScopeProvider } from './dashscope'
import type { ApiProvider, ProviderConfig } from '../../shared/types'

export function createProvider(config: ProviderConfig): ApiProvider {
  switch (config.type) {
    case 'volcano-cv':
      return new VolcanoCvProvider(config)
    case 'openai-compatible':
      return new OpenAiCompatProvider(config)
    case 'dashscope':
      return new DashScopeProvider(config)
    default:
      throw new Error(`未知的 provider 类型：${String((config as { type?: unknown }).type)}`)
  }
}
