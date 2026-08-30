import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

/** 插件名，同时用作日志前缀 */
export const PLUGIN_NAME = 'dsh-model-reasoning'

/** 读取/写入目标命名空间 */
export const NS = settingsNamespace('llm-pi-ai')
/** 自有配置命名空间，由 installSettingsSection 注册到 settings */
export const MY_NS = settingsNamespace('model-reasoning')

export const API_URL = 'https://models.dev/api.json'
export const FETCH_MS = 10_000
/** 拉取、缓存写入与填充冲突共用的总尝试次数；固定重试间隔用于拉取与缓存写入 */
export const MAX_ATTEMPTS = 3
export const RETRY_DELAY_MS = 5_000

/** 缓存文件：基于模块路径定位，构建时复制；网络拉取成功后覆盖 */
export const CACHE_FILE = join(dirname(fileURLToPath(import.meta.url)), 'public', 'models-cache.json')

/** 推理级别取值，与 harness 的 ModelThinkingLevel 一致 */
export const LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

/** 模型名前缀 -> 官方提供商，用于跨提供商匹配同源模型 */
export const HINTS: ReadonlyArray<readonly [string, string]> = [
    ['deepseek', 'deepseek'],
    ['claude', 'anthropic'],
    ['kimi', 'moonshotai'],
    ['grok', 'xai'],
    ['gpt', 'openai'],
]
