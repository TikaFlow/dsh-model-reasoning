import { readFile, writeFile } from 'node:fs/promises'
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

/** 命名空间描述符：value 为当前解析值，user 为原始用户 section，revision 供写回时做并发冲突校验 */
interface SettingsDescriptor {
    ns: string
    revision: number
    value: unknown
    /** 原始用户 section（detach 拷贝，字段仅含用户写入项）；无用户 section 时为 undefined */
    user?: unknown
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
// 异步拉取最新数据的延迟：避免与首轮缓存填充的读取/写入冲突
const REFRESH_DELAY_MS = 5_000
// 并发冲突后的填充重试上限：每次重读重算，仍冲突则放弃，交由后续事件再触发
const FILL_MAX_ATTEMPTS = 2
// 是否允许在已有推理级别时以最新数据为准更新档位；默认 false（无配置项 = false），后续改为读取配置
const ALLOW_LEVEL_UPDATE = 1 === 2 as unknown

// models.dev 处理后缓存文件：基于本模块自身路径定位，构建时由 public/ 复制到产物目录；网络拉取成功时覆盖
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

/** 一条模型的推理能力信息（来自 models.dev 条目解析的中间形态） */
interface ReasoningEntry {
    reasoning: boolean
    toggle: boolean
    efforts: string[]
}

/** 缓存中的一条模型推理信息：已拍平，仅保留填充所需的 provider/id/efforts */
interface CacheEntry {
    provider: string
    id: string
    /** 可选推理级别，'none' 表示可关闭推理；已过滤 harness 不支持的取值并统一拼写 */
    efforts: string[]
}

/** 拍平缓存：一个大数组，每条为 provider/id/efforts */
type Catalog = CacheEntry[]

/** 按 provider 分组的内存索引（构建一次，供 lookup 复用） */
interface ProviderGroup {
    ids: string[]
    entries: CacheEntry[]
}

/** 目录及其预构建的 provider->条目 分组索引 */
interface IndexedCatalog {
    catalog: Catalog
    groups: Map<string, ProviderGroup>
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
 * 将 models.dev 原始 JSON 拍平为缓存数组：仅保留有可用推理级别的模型，丢弃非推理
 * 模型与无级别模型（无推理信息即不填充）；efforts 过滤为 harness 支持的取值并统一
 * 'off' 拼写为 'none'（可关闭标记），toggle 且无关闭标记时补 'none'。
 */
function buildCatalog(api: Record<string, unknown> | undefined): Catalog {
    const catalog: Catalog = []
    for (const [provider, block] of Object.entries(api ?? {})) {
        if (block == null || typeof block !== 'object') continue
        const models = (block as { models?: unknown }).models
        if (models == null || typeof models !== 'object') continue
        for (const [id, entry] of Object.entries(models as Record<string, unknown>)) {
            const parsed = fromApiEntry(entry)
            if (!parsed || !parsed.reasoning) continue
            const efforts = [
                ...new Set(
                    parsed.efforts
                        .map((effort) => (effort === 'off' ? 'none' : effort))
                        .filter((effort) => effort === 'none' || LEVELS.has(effort)),
                ),
            ]
            if (parsed.toggle && !efforts.includes('none')) efforts.unshift('none')
            // 仅有 none（或为空）的模型无法提供推理等级，丢弃
            if (!efforts.some((effort) => effort !== 'none')) continue
            catalog.push({ provider, id, efforts })
        }
    }
    return catalog
}

/** 将拍平缓存数组构建为带 provider 分组索引的目录 */
function indexFromArray(catalog: Catalog): IndexedCatalog {
    const groups = new Map<string, ProviderGroup>()
    for (const entry of catalog) {
        let group = groups.get(entry.provider)
        if (!group) groups.set(entry.provider, (group = { ids: [], entries: [] }))
        group.ids.push(entry.id)
        group.entries.push(entry)
    }
    return { catalog, groups }
}

/**
 * 将缓存条目转换为 reasoningEfforts 映射（key = 可选等级，value = 实际发送的拼写；
 * 仅 off 允许空值）。缓存已过滤非推理模型并规范 efforts，返回 undefined 仅为防御。
 */
function toReasoningEfforts(entry: CacheEntry | undefined): Record<string, string | null> | undefined {
    if (!entry) return
    const mapped: Record<string, string | null> = {}
    for (const effort of entry.efforts) {
        const level = effort === 'none' ? 'off' : effort
        mapped[level] = level === 'off' ? null : level
    }
    const keys = Object.keys(mapped)
    if (keys.length === 0) return
    if (keys.length === 1 && keys[0] === 'off') return
    return mapped
}

/** 是否为一个普通数据对象（非数组、非 null、非类实例） */
function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const proto: unknown = Object.getPrototypeOf(value)
    return proto === Object.prototype || proto === null
}

/** JSON 兼容数据的深相等（忽略键顺序），供更新档位时比较，避免键序触发无谓写回 */
function deepEqualJson(a: unknown, b: unknown): boolean {
    if (a === b) return true
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
        return a.every((entry, i) => deepEqualJson(entry, b[i]))
    }
    const left = a as Record<string, unknown>
    const right = b as Record<string, unknown>
    const keys = Object.keys(left)
    if (keys.length !== Object.keys(right).length) return false
    return keys.every((key) => key in right && deepEqualJson(left[key], right[key]))
}

/**
 * 返回剔除空 input/compat 后的模型副本；无空字段时返回原对象（惰性，供 fill 写回复用）。
 * 旧版插件从 descriptor.value 读模型并整段写回，而 value 已被 schemastery 物化默认值：
 * 缺失的 input 变成 []、compat 变成 {}，于是这些空字段落进了用户的设置文档。两者在 harness
 * 语义上等同缺失（空 input 被当作未声明、空 compat 读不到任何开关），删除无损，故可安全清理。
 * 填充改为读 user 后不再产生此类空字段，因此清理幂等：遗留字段清一次后不会重现。
 */
function stripEmptyArtifacts(model: Record<string, unknown>): Record<string, unknown> {
    let next: Record<string, unknown> | undefined
    if (Array.isArray(model['input']) && model['input'].length === 0) {
        next = { ...model }
        delete next['input']
    }
    const compat = model['compat']
    if (compat != null && typeof compat === 'object' && !Array.isArray(compat) && Object.keys(compat).length === 0) {
        next ??= { ...model }
        delete next['compat']
    }
    return next ?? model
}

/**
 * 在索引目录中查找模型条目：优先按 provider+modelId 同时匹配（配置的 provider 恰为
 * 目录提供商时最精确）；失败则仅按 modelId 匹配（先提示提供商，再全部提供商）。
 */
function lookup(indexed: IndexedCatalog, providerId: string, modelId: string): CacheEntry | undefined {
    const { groups } = indexed
    const bare = modelId.slice(modelId.lastIndexOf('/') + 1)
    const matchIn = (provider: string): CacheEntry | undefined => {
        const group = groups.get(provider)
        if (!group) return
        const hit = matchId(bare, group.ids)
        return hit === undefined ? undefined : group.entries.find((entry) => entry.id === hit)
    }
    // 第一阶段：配置 provider 精确命中目录时，仅在该 provider 内匹配
    if (providerId && groups.has(providerId)) {
        const same = matchIn(providerId)
        if (same) return same
    }
    // 第二阶段：仅按 modelId 全局匹配（先提示提供商，再全部提供商）
    const hinted = hintedProvider(bare)
    if (hinted) {
        const official = matchIn(hinted)
        if (official) return official
    }
    for (const provider of groups.keys()) {
        if (provider === providerId || provider === hinted) continue
        const hit = matchIn(provider)
        if (hit) return hit
    }
}

// 常驻空索引：目录尚未可用时的兜底（行为与空目录一致）
const EMPTY_INDEX: IndexedCatalog = { catalog: [], groups: new Map() }

// 内存索引：进入插件时优先由缓存加载，异步拉取成功后替换为最新索引
let indexedCache: IndexedCatalog | undefined

/** 从缓存文件异步加载目录：解析结果为非空数组才算可用（旧格式或坏数据一律失效），否则返回 undefined */
async function readCache(): Promise<IndexedCatalog | undefined> {
    try {
        const parsed = JSON.parse(await readFile(cacheFile, 'utf8')) as unknown
        if (!Array.isArray(parsed) || parsed.length === 0) return
        return indexFromArray(parsed as CacheEntry[])
    } catch {
        return
    }
}

/**
 * 拉取 models.dev 最新数据：解析拍平后仅当数据有效（非空）才返回并覆盖缓存；
 * 内容无变化时跳过写入，避免每次刷新重写相同数据。失败或数据无效抛出错误
 * （由调用方记录日志），继续使用现有目录。
 */
async function fetchLatest(): Promise<IndexedCatalog> {
    const res = await fetch(API_URL, {
        signal: AbortSignal.timeout(FETCH_MS),
        headers: { 'User-Agent': 'dsh-model-reasoning' },
    })
    if (!res.ok) throw new Error(`${API_URL} -> ${res.status}`)
    const api = (await res.json()) as Record<string, unknown>
    const catalog = buildCatalog(api)
    // 写入保护：数据解析不出可用模型时拒绝空数据，保留现有缓存与内存索引（避免坏响应覆盖好数据）
    if (catalog.length === 0) throw new Error(`${API_URL} 返回的数据未包含可用的模型推理信息`)
    const indexed = indexFromArray(catalog)
    // 内容无变化则跳过重写缓存；异步写避免阻塞事件循环（只读环境写失败则忽略，不影响本次运行）
    const serialized = JSON.stringify(catalog)
    if (indexedCache === undefined || serialized !== JSON.stringify(indexedCache.catalog)) {
        await writeFile(cacheFile, serialized).catch(() => {
            // 缓存写入是可选的
        })
    }
    return indexed
}

/** 判断错误是否为并发写入冲突（settings 命名空间在读写之间被改动） */
function isSettingsConflict(error: unknown): boolean {
    return (error as { code?: unknown } | null)?.code === 'SETTINGS_CONFLICT'
}

/**
 * 遍历配置的模型并写回变更：缺失推理级别且数据有档位则填充，已开启允许更新则同步到最新
 * 数据，并顺带剔除旧版遗留的空 input/compat。读取 descriptor.user（原始字段，不含 value
 * 物化的空默认值），整段写回 models 数组（路径 op 不支持数组下标中继）。reasoningEfforts:false
 * 永远不更新，数据无档位时不删除已有配置。并发冲突重读重算，超过上限放弃。开启允许更新后
 * 数据即为准，任何手动档位在下次 settings 变更后都可能被回滚。
 */
async function update(ctx: Context): Promise<void> {
    let lastError: unknown
    for (let attempt = 0; attempt <= FILL_MAX_ATTEMPTS; attempt++) {
        // 冲突重试时重读，获取最新 revision 以做并发冲突校验
        const descriptor = ctx.settings.describe().find((d) => d.ns === NS)
        if (!descriptor) return
        const providers = (descriptor.user as { providers?: Record<string, unknown> } | undefined)?.providers
        if (providers == null || typeof providers !== 'object') return
        const allowUpdate = ALLOW_LEVEL_UPDATE
        const indexed = indexedCache ?? EMPTY_INDEX
        const ops: SettingsPathOp[] = []
        let changes = 0
        for (const [providerId, provider] of Object.entries(providers)) {
            if (provider == null || typeof provider !== 'object') continue
            const models = (provider as { models?: unknown }).models
            if (!Array.isArray(models)) continue
            let next: Record<string, unknown>[] | undefined
            for (let i = 0; i < models.length; i++) {
                const model = models[i]
                if (model == null || typeof model !== 'object') continue
                const record = model as Record<string, unknown>
                const { id, reasoningEfforts } = record as { id?: unknown; reasoningEfforts?: unknown }
                if (id == null) continue
                const cleaned = stripEmptyArtifacts(record)
                const efforts = toReasoningEfforts(lookup(indexed, providerId, String(id)))
                const fillable = reasoningEfforts === undefined && efforts !== undefined
                const updatable = allowUpdate
                    && efforts !== undefined
                    && isPlainObject(reasoningEfforts)
                    && !deepEqualJson(reasoningEfforts, efforts)
                if (cleaned === record && !fillable && !updatable) continue
                changes++
                if (next === undefined) next = models.slice()
                next[i] = (fillable || updatable) ? { ...cleaned, reasoningEfforts: efforts } : cleaned
            }
            if (next !== undefined) {
                ops.push({ op: 'set', path: ['providers', providerId, 'models'], value: next })
            }
        }
        if (ops.length === 0) return
        try {
            await ctx.settings.mutate(NS, ops, descriptor.revision)
            ctx.logger?.info?.(`${name}: 已变更 ${changes} 个模型（补充/同步推理级别、清理空字段）`)
            return
        } catch (error) {
            const conflict = isSettingsConflict(error) && attempt < FILL_MAX_ATTEMPTS
            if (conflict) continue
            ctx.logger?.warn?.(`${name}: ${error instanceof Error ? error.message : String(error)}`)
            return
        }
    }
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
            update(ctx)
        })
        .catch((error) => {
            if (isDisposed()) return
            ctx.logger?.warn?.(
                `${name}: 拉取 models.dev 最新数据失败，继续使用现有目录（${error instanceof Error ? error.message : String(error)}）`,
            )
        })
}

export function apply(ctx: Context) {
    // 模型配置更新触发更新
    ctx.on('settings/updated', (ns) => {
        if (ns !== NS) return
        update(ctx)
    })
    // 首轮缓存读取与异步刷新统一由 effect 管理：卸载时置位并清除定时器，在途读取/刷新
    // 结果不再触碰已卸载的上下文。缓存可用则立即用缓存填充，再延迟拉取避免与首轮填充
    // 冲突；缓存不可用（构建已保留缓存，理论不会发生）则读完缓存后立即拉取
    ctx.effect(() => {
        let disposed = false
        let timer: ReturnType<typeof setTimeout> | undefined
        void readCache().then((cached) => {
            if (disposed) return
            if (cached) {
                indexedCache = cached
                update(ctx)
            }
            timer = setTimeout(() => refresh(ctx, () => disposed), cached ? REFRESH_DELAY_MS : 0)
        })
        return () => {
            disposed = true
            if (timer !== undefined) clearTimeout(timer)
        }
    })
}