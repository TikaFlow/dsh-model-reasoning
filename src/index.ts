import { readFileSync, statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-model-reasoning'
export const inject = ['settings']

// dsh-settings 服务与 settings/updated 事件的本地类型声明，避免为类型引入额外依赖
declare module '@deepseek-ai/cordis' {
    interface Context {
        settings: SettingsService
    }
    interface Events {
        'settings/updated'(ns: string, next: unknown, prev: unknown, source: unknown): void
    }
}

interface SettingsService {
    describe(): SettingsDescriptor[]
    mutate(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>
}

/** 命名空间描述符：value 为当前解析值，revision 供写回时做并发冲突校验 */
interface SettingsDescriptor {
    ns: string
    revision: number
    value: unknown
}

interface SettingsPathOp {
    op: 'set'
    path: readonly string[]
    value: unknown
}

// LLM 提供商配置所在命名空间（由 harness 的 llm-pi-ai 插件注册）
const NS = 'llm-pi-ai'
const API_URL = 'https://models.dev/api.json'
const FETCH_MS = 10_000
// 缓存文件视为可用的最小大小（构建保留的缓存通常远超此值）
const CACHE_MIN_BYTES = 10 * 1024
// 异步拉取最新数据的延迟：避免与首轮缓存填充的读取/写入冲突
const REFRESH_DELAY_MS = 5_000
// 并发冲突后的填充重试上限：每次重读重算，仍冲突则放弃，交由后续事件再触发
const FILL_MAX_ATTEMPTS = 2

// models.dev 缓存文件：基于本模块自身路径定位，构建时由 public/ 复制到产物目录；网络拉取成功时覆盖
const cacheFile = join(dirname(fileURLToPath(import.meta.url)), 'public', 'models-cache.json')

// 推理级别取值（与 harness 的 ModelThinkingLevel 一致）
const LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

// 常见模型名与官方提供商之间的提示映射，用于命中官方目录中的同源模型
const HINTS: ReadonlyArray<readonly [string, string]> = [
    ['deepseek', 'deepseek'],
    ['claude', 'anthropic'],
    ['kimi', 'moonshotai'],
    ['grok', 'xai'],
    ['gpt', 'openai'],
]

/** 一条模型的推理能力信息（来自 models.dev 条目或本地缓存） */
interface ReasoningEntry {
    reasoning: boolean
    toggle: boolean
    efforts: string[]
}

/** provider/model-id -> 条目 的扁平目录 */
type Catalog = Record<string, ReasoningEntry>

/** 目录及其预构建的 provider->模型id 分组索引（一次性构建，供 lookup 复用） */
interface IndexedCatalog {
    catalog: Catalog
    groups: Map<string, string[]>
}

/** 归一化模型 id：去掉供应商后缀、版本日期等噪音，仅保留语义主体 */
function stem(id: string): string {
    return id
        .toLowerCase()
        .replace(/-openai-compact$/, '')
        .replace(/-latest$/, '')
        .replace(/-\d{8}$/, '')
        .split('-')
        .filter((part) => !/^\d{4,}$/.test(part))
        .join('-')
}

/** 将本地模型 id 与目录中的某个模型 id 匹配（精确、词干、前缀三级） */
function matchId(localId: string, ids: readonly string[]): string | undefined {
    const normalized = localId
        .toLowerCase()
        .replace(/-openai-compact$/, '')
        .replace(/-latest$/, '')
    if (ids.includes(normalized)) return normalized
    if (!normalized.includes('-') && !normalized.includes('.')) return
    const localStem = stem(normalized)
    const stemHits = ids.filter((id) => stem(id) === localStem)
    if (stemHits.length === 1) return stemHits[0]
    if (stemHits.includes(normalized)) return normalized
    const prefix = ids.filter((id) => id.startsWith(`${normalized}-`) || id.startsWith(`${normalized}.`))
    if (prefix.length === 1) return prefix[0]
}

/** 由模型名提示其官方提供商 */
function hintedProvider(id: string): string | undefined {
    const bare = id.slice(id.lastIndexOf('/') + 1).toLowerCase()
    return HINTS.find(([prefix]) => bare === prefix || bare.startsWith(`${prefix}-`) || bare.startsWith(`${prefix}.`))?.[1]
}

/** 将 models.dev 中的单条模型条目解析为推理能力信息 */
function fromApiEntry(entry: unknown): ReasoningEntry | undefined {
    if (entry == null || typeof entry !== 'object') return
    const { reasoning, reasoning_options: rawOptions } = entry as {
        reasoning?: boolean
        reasoning_options?: unknown
    }
    const options = Array.isArray(rawOptions) ? rawOptions : []
    const efforts: string[] = []
    let toggle = false
    for (const option of options) {
        if (option == null || typeof option !== 'object') continue
        const { type, values } = option as { type?: unknown; values?: unknown }
        if (type === 'toggle') toggle = true
        if (type === 'effort' && Array.isArray(values)) {
            for (const value of values) {
                if (typeof value === 'string' && value) efforts.push(value)
            }
        }
    }
    if (reasoning === false && efforts.length === 0 && !toggle) {
        return { reasoning: false, toggle: false, efforts: [] }
    }
    if (reasoning !== false && (toggle || efforts.length > 0 || reasoning === true)) {
        return { reasoning: true, toggle, efforts }
    }
}

/**
 * 将条目转换为 reasoningEfforts 映射（key = 可选等级，value = 实际发送的拼写；
 * 仅 off 允许空值）。返回 false 表示模型不支持推理，undefined 表示无可用信息。
 */
function toReasoningEfforts(
    entry: ReasoningEntry | undefined,
): Record<string, string | null> | false | undefined {
    if (!entry) return
    if (!entry.reasoning) return false
    const efforts = [...entry.efforts]
    if (entry.toggle && !efforts.includes('none') && !efforts.includes('off')) efforts.unshift('none')
    if (efforts.length === 0) return
    const mapped: Record<string, string | null> = {}
    for (const effort of efforts) {
        const level = effort === 'none' ? 'off' : effort
        if (!LEVELS.has(level)) continue
        mapped[level] = level === 'off' ? null : level
    }
    const keys = Object.keys(mapped)
    if (keys.length === 0) return
    if (keys.length === 1 && keys[0] === 'off') return
    return mapped
}

/** 将 models.dev 原始 JSON 索引为扁平目录，并预构建 provider->模型id 分组索引 */
function indexApiJson(api: Record<string, unknown> | undefined): IndexedCatalog {
    const catalog: Catalog = {}
    const groups = new Map<string, string[]>()
    for (const [provider, block] of Object.entries(api ?? {})) {
        if (block == null || typeof block !== 'object') continue
        const models = (block as { models?: unknown }).models
        if (models == null || typeof models !== 'object') continue
        const ids: string[] = []
        for (const [id, entry] of Object.entries(models as Record<string, unknown>)) {
            const parsed = fromApiEntry(entry)
            if (parsed) {
                catalog[`${provider}/${id}`] = parsed
                ids.push(id)
            }
        }
        if (ids.length > 0) groups.set(provider, ids)
    }
    return { catalog, groups }
}

/** 在索引目录中查找模型条目：先按提示提供商，再按全部提供商依次匹配（分组索引由 indexApiJson 一次性构建） */
function lookup(indexed: IndexedCatalog, modelId: string): ReasoningEntry | undefined {
    const { catalog, groups } = indexed
    const bare = modelId.slice(modelId.lastIndexOf('/') + 1)
    const hinted = hintedProvider(bare)
    const tryProvider = (provider: string) => {
        const ids = groups.get(provider)
        if (!ids) return
        const hit = matchId(bare, ids)
        return hit ? catalog[`${provider}/${hit}`] : undefined
    }
    if (hinted) {
        const official = tryProvider(hinted)
        if (official) return official
    }
    for (const provider of groups.keys()) {
        if (provider === hinted) continue
        const hit = tryProvider(provider)
        if (hit) return hit
    }
}

// 常驻空索引：目录尚未可用时的兜底（行为与空目录一致）
const EMPTY_INDEX: IndexedCatalog = { catalog: {}, groups: new Map() }

// 内存索引：进入插件时优先由缓存加载，异步拉取成功后替换为最新索引
let indexedCache: IndexedCatalog | undefined

/** 从缓存文件加载目录索引：存在、大小 >= 10KB 且解析成功才算可用（避免写入中途截断误判），否则返回 undefined */
function readCache(): IndexedCatalog | undefined {
    try {
        if (statSync(cacheFile).size < CACHE_MIN_BYTES) return
        const cached = JSON.parse(readFileSync(cacheFile, 'utf8')) as Record<string, unknown>
        return indexApiJson(cached)
    } catch {
        return
    }
}

/** 拉取 models.dev 最新数据：成功则覆盖缓存文件并返回目录索引，失败抛出错误（由调用方记录日志） */
async function fetchLatest(): Promise<IndexedCatalog> {
    const res = await fetch(API_URL, {
        signal: AbortSignal.timeout(FETCH_MS),
        headers: { 'User-Agent': 'dsh-model-reasoning' },
    })
    if (!res.ok) throw new Error(`${API_URL} -> ${res.status}`)
    const api = (await res.json()) as Record<string, unknown>
    // 网络获取成功：异步覆盖缓存，避免同步写大文件阻塞事件循环（只读环境写失败则忽略，不影响本次运行）
    await writeFile(cacheFile, JSON.stringify(api)).catch(() => {
        // 缓存写入是可选的
    })
    return indexApiJson(api)
}

/** 判断错误是否为并发写入冲突（settings 命名空间在读写之间被改动） */
function isSettingsConflict(error: unknown): boolean {
    return (error as { code?: unknown } | null)?.code === 'SETTINGS_CONFLICT'
}

/**
 * 遍历配置的模型，判断并填充推理级别，将有变更的模型以定向 op 写回设置。
 * 定向 op 只写单个模型的 reasoningEfforts 字段，避免整段覆写 models 数组冲掉并发改动；
 * 写回时携带描述符 revision，冲突则重读重算，超过上限放弃。
 */
async function fill(ctx: Context): Promise<void> {
    for (let attempt = 0; attempt <= FILL_MAX_ATTEMPTS; attempt++) {
        const descriptor = ctx.settings.describe().find((d) => d.ns === NS)
        if (!descriptor) return
        const providers = (descriptor.value as { providers?: Record<string, unknown> } | undefined)?.providers
        if (providers == null || typeof providers !== 'object') return
        // 使用当前内存索引（无可用数据时为空索引）
        const indexed = indexedCache ?? EMPTY_INDEX
        const ops: SettingsPathOp[] = []
        let filled = 0
        for (const [providerId, provider] of Object.entries(providers)) {
            if (provider == null || typeof provider !== 'object') continue
            const models = (provider as { models?: unknown }).models
            if (!Array.isArray(models)) continue
            for (let i = 0; i < models.length; i++) {
                const model = models[i]
                if (model == null || typeof model !== 'object') continue
                const { id, reasoningEfforts } = model as { id?: unknown; reasoningEfforts?: unknown }
                // 已有推理级别或缺少 id 的模型保持原样
                if (id == null || reasoningEfforts !== undefined) continue
                const efforts = toReasoningEfforts(lookup(indexed, String(id)))
                if (efforts === undefined) continue
                filled++
                ops.push({
                    op: 'set',
                    path: ['providers', providerId, 'models', String(i), 'reasoningEfforts'],
                    value: efforts,
                })
            }
        }
        if (ops.length === 0) return
        try {
            await ctx.settings.mutate(NS, ops, descriptor.revision)
            ctx.logger?.info?.(`${name}: 已为 ${filled} 个模型填充推理级别`)
            return
        } catch (error) {
            // 并发冲突：重读重算一轮；仍冲突则抛出，由 runFill 记录日志
            if (isSettingsConflict(error) && attempt < FILL_MAX_ATTEMPTS) continue
            throw error
        }
    }
}

/** 执行一轮填充并统一记录失败日志 */
function runFill(ctx: Context): void {
    fill(ctx).catch((error) => {
        ctx.logger?.warn?.(`${name}: ${error instanceof Error ? error.message : String(error)}`)
    })
}

/**
 * 异步拉取最新数据：成功后更新内存索引并再次填充，失败记录日志（继续使用现有索引）。
 * isDisposed 由 effect 生命周期提供：插件卸载后刷新结果不再触碰已卸载的上下文。
 */
function refresh(ctx: Context, isDisposed: () => boolean): void {
    fetchLatest()
        .then((indexed) => {
            if (isDisposed()) return
            indexedCache = indexed
            runFill(ctx)
        })
        .catch((error) => {
            if (isDisposed()) return
            ctx.logger?.warn?.(
                `${name}: 拉取 models.dev 最新数据失败，继续使用现有目录（${error instanceof Error ? error.message : String(error)}）`,
            )
        })
}

export function apply(ctx: Context) {
    // 模型配置更新遍历填充
    ctx.on('settings/updated', (ns) => {
        if (ns !== NS) return
        runFill(ctx)
    })
    // 进入插件：缓存可用则立即用缓存填充
    const cached = readCache()
    if (cached) {
        indexedCache = cached
        runFill(ctx)
    }
    // 刷新统一由 effect 管理：卸载时清除定时器并置位，在途刷新结果不再触碰已卸载的上下文。
    // 缓存可用时延迟拉取避免与首轮填充冲突；缓存不可用（构建已保留缓存，理论不会发生）则立即拉取
    ctx.effect(() => {
        let disposed = false
        const timer = setTimeout(() => refresh(ctx, () => disposed), cached ? REFRESH_DELAY_MS : 0)
        return () => {
            disposed = true
            clearTimeout(timer)
        }
    })
}
