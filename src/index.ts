import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-model-reasoning'
export const inject = ['settings']

// 读取/写入目标命名空间
const NS = settingsNamespace('llm-pi-ai')
// 自有配置命名空间，由 installSettingsSection 注册到 settings
const MY_NS = settingsNamespace('model-reasoning')
const API_URL = 'https://models.dev/api.json'
const FETCH_MS = 10_000
// 拉取、缓存写入与填充冲突共用的总尝试次数；固定重试间隔用于拉取与缓存写入
const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 5_000

// 自有配置：allowUpdate 开启后以最新数据为准更新已有档位
interface MyConfig {
    allowUpdate: boolean
}
const MyConfigSchema: z<MyConfig> = z.object({
    allowUpdate: z.boolean().default(false),
})
// 生效配置源：installSettingsSection 挂载后指向 settings scope，否则回退默认
let configSource: () => MyConfig = () => ({ allowUpdate: false })

// 缓存文件：基于模块路径定位，构建时复制；网络拉取成功后覆盖
const cacheFile = join(dirname(fileURLToPath(import.meta.url)), 'public', 'models-cache.json')

// 推理级别取值，与 harness 的 ModelThinkingLevel 一致
const LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

// 模型名前缀 -> 官方提供商，用于跨提供商匹配同源模型
const HINTS: ReadonlyArray<readonly [string, string]> = [
    ['deepseek', 'deepseek'],
    ['claude', 'anthropic'],
    ['kimi', 'moonshotai'],
    ['grok', 'xai'],
    ['gpt', 'openai'],
]

/** models.dev 单条条目的推理能力解析结果 */
interface ReasoningEntry {
    reasoning: boolean
    toggle: boolean
    efforts: string[]
}

/** 缓存条目：已拍平并过滤，仅保留填充所需字段 */
interface CacheEntry {
    provider: string
    id: string
    /** 可选推理级别，'none' 表示可关闭推理 */
    efforts: string[]
}

/** 拍平缓存：每条为 provider/id/efforts */
type Catalog = CacheEntry[]

/** 按 provider 分组的内存索引，供 lookup 复用 */
interface ProviderGroup {
    ids: string[]
    entries: CacheEntry[]
}

/** 目录及其预构建的 provider 分组索引 */
interface IndexedCatalog {
    catalog: Catalog
    groups: Map<string, ProviderGroup>
}

/** 归一化模型 id：去版本日期等噪音，供 stem/matchId 复用 */
function normalizeId(id: string): string {
    return id.toLowerCase().replace(/-openai-compact$/, '').replace(/-latest$/, '')
}

/** 提取模型 id 的语义主体（去供应商后缀与版本日期） */
function stem(id: string): string {
    return normalizeId(id)
        .replace(/-\d{8}$/, '')
        .split('-')
        .filter((part) => !/^\d{4,}$/.test(part))
        .join('-')
}

/** 匹配本地模型 id 与目录 id：精确、词干、前缀三级 */
function matchId(localId: string, ids: readonly string[]): string | undefined {
    const normalized = normalizeId(localId)
    if (ids.includes(normalized)) return normalized
    if (!normalized.includes('-') && !normalized.includes('.')) return
    const localStem = stem(normalized)
    const stemHits = ids.filter((id) => stem(id) === localStem)
    if (stemHits.length === 1) return stemHits[0]
    const prefix = ids.filter((id) => id.startsWith(`${normalized}-`) || id.startsWith(`${normalized}.`))
    if (prefix.length === 1) return prefix[0]
}

function hintedProvider(id: string): string | undefined {
    const bare = id.slice(id.lastIndexOf('/') + 1).toLowerCase()
    return HINTS.find(([prefix]) => bare === prefix || bare.startsWith(`${prefix}-`) || bare.startsWith(`${prefix}.`))?.[1]
}

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
 * 将 models.dev 原始 JSON 拍平为缓存数组：仅保留有可用推理级别的模型；efforts 过滤为
 * harness 支持的取值并统一 'off' 拼写为 'none'，toggle 且无关闭标记时补 'none'。
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
            // 仅有 none 的模型无法提供推理等级
            if (!efforts.some((effort) => effort !== 'none')) continue
            catalog.push({ provider, id, efforts })
        }
    }
    return catalog
}

/** 构建带 provider 分组索引的目录 */
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

/** 转换为 reasoningEfforts 映射：key 为可选等级，value 为实际发送拼写（仅 off 允许空值） */
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

/** 判定是否为普通数据对象（非数组、非 null、非类实例） */
function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const proto: unknown = Object.getPrototypeOf(value)
    return proto === Object.prototype || proto === null
}

/**
 * 剔除空 input/compat：旧版插件从 descriptor.value（schemastery 物化默认值）整段写回，
 * 使缺失的 input 变 []、compat 变 {} 落进用户文档；两者在 harness 语义上等同缺失，删除无损。
 * 填充改为读 user 后不再产生此类空字段，故清理幂等。
 */
function stripEmptyArtifacts(model: Record<string, unknown>): Record<string, unknown> {
    let next: Record<string, unknown> | undefined
    const input = model.input
    if (Array.isArray(input) && input.length === 0) {
        next = { ...model }
        delete next.input
    }
    const compat = model.compat
    if (compat != null && typeof compat === 'object' && !Array.isArray(compat) && Object.keys(compat).length === 0) {
        next ??= { ...model }
        delete next.compat
    }
    return next ?? model
}

/** 在目录中查找模型条目：优先按 provider+modelId，失败再仅按 modelId 全局匹配 */
function lookup(indexed: IndexedCatalog, providerId: string, modelId: string): CacheEntry | undefined {
    const { groups } = indexed
    const bare = modelId.slice(modelId.lastIndexOf('/') + 1)
    const matchIn = (provider: string): CacheEntry | undefined => {
        const group = groups.get(provider)
        if (!group) return
        const hit = matchId(bare, group.ids)
        return hit === undefined ? undefined : group.entries.find((entry) => entry.id === hit)
    }
    // 配置 provider 精确命中目录时，仅在该 provider 内匹配
    if (providerId && groups.has(providerId)) {
        const same = matchIn(providerId)
        if (same) return same
    }
    // 否则按 modelId 全局匹配：先提示提供商，再全部提供商
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

// 目录尚未可用时的空兜底
const EMPTY_INDEX: IndexedCatalog = { catalog: [], groups: new Map() }

// 内存索引：缓存加载或网络拉取成功后整体替换
let indexedCache: IndexedCatalog | undefined

/** 从缓存文件异步加载目录：解析结果非空数组才算可用 */
async function readCache(): Promise<IndexedCatalog | undefined> {
    try {
        const parsed = JSON.parse(await readFile(cacheFile, 'utf8')) as unknown
        if (!Array.isArray(parsed) || parsed.length === 0) return
        return indexFromArray(parsed as CacheEntry[])
    } catch {
        return
    }
}

/** 拉取 models.dev 最新数据：数据非空才返回并覆盖缓存；内容无变化跳过写入。失败抛出由调用方记录日志 */
async function fetchLatest(ctx: Context): Promise<IndexedCatalog> {
    const res = await fetch(API_URL, {
        signal: AbortSignal.timeout(FETCH_MS),
        headers: { 'User-Agent': 'dsh-model-reasoning' },
    })
    if (!res.ok) throw new Error(`${API_URL} -> ${res.status}`)
    const api = (await res.json()) as Record<string, unknown>
    const catalog = buildCatalog(api)
    // 空数据拒绝覆盖，避免坏响应破坏现有目录
    if (catalog.length === 0) throw new Error(`${API_URL} 返回的数据未包含可用的模型推理信息`)
    const indexed = indexFromArray(catalog)
    const serialized = JSON.stringify(catalog)
    if (indexedCache === undefined || serialized !== JSON.stringify(indexedCache.catalog)) {
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                await writeFile(cacheFile, serialized)
                break
            } catch (error) {
                // 每次失败都记录，便于判断是一次成功还是重试后才成功
                ctx.logger?.warn?.(
                    `${name}: 写入缓存失败（第 ${attempt}/${MAX_ATTEMPTS} 次）：${error instanceof Error ? error.message : String(error)}`,
                )
                if (attempt < MAX_ATTEMPTS) {
                    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS))
                }
            }
        }
    }
    return indexed
}

/** 判断错误是否为并发写入冲突（settings 命名空间在读写之间被改动） */
function isSettingsConflict(error: unknown): boolean {
    return (error as { code?: unknown } | null)?.code === 'SETTINGS_CONFLICT'
}

/**
 * 遍历配置的模型写回变更：缺失推理级别且有档位则填充，开启 allowUpdate 则同步最新档位，
 * 并剔除旧版遗留的空 input/compat。读 descriptor.user（原始字段）整段写回 models（路径 op
 * 不支持数组下标中继）；reasoningEfforts:false 永不更新，数据无档位不删除已有配置。
 */
async function update(ctx: Context): Promise<void> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        // 冲突重试时重读，获取最新 revision
        const descriptor = ctx.settings.describe().find((d) => d.ns === NS)
        if (!descriptor) return
        const providers = (descriptor.user as { providers?: Record<string, unknown> } | undefined)?.providers
        if (providers == null || typeof providers !== 'object') return
        const allowUpdate = configSource().allowUpdate
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
            const conflict = isSettingsConflict(error) && attempt < MAX_ATTEMPTS
            if (conflict) continue
            ctx.logger?.warn?.(`${name}: ${error instanceof Error ? error.message : String(error)}`)
            return
        }
    }
}

/** 异步拉取最新数据：成功后更新索引并再次填充；isDisposed 避免结果触碰已卸载上下文 */
function refresh(ctx: Context, isDisposed: () => boolean, retryCount = MAX_ATTEMPTS): void {
    fetchLatest(ctx)
        .then((indexed) => {
            if (isDisposed()) return
            indexedCache = indexed
            update(ctx)
        })
        .catch((error) => {
            if (isDisposed()) return
            // 每次失败都记录，便于判断是一次成功还是重试后才成功
            const attempt = MAX_ATTEMPTS - retryCount + 1
            ctx.logger?.warn?.(
                `${name}: 拉取 models.dev 最新数据失败（第 ${attempt}/${MAX_ATTEMPTS} 次）：${error instanceof Error ? error.message : String(error)}`,
            )
            // 剩余重试次数不足则放弃，交由后续事件或重启再触发
            if (--retryCount <= 0) return
            setTimeout(() => {
                if (isDisposed()) return
                refresh(ctx, isDisposed, retryCount)
            }, RETRY_DELAY_MS)
        })
}

export function apply(ctx: Context) {
    // 注册自有配置命名空间：setSource 交由 configSource 读取，onChange 响应配置变更
    installSettingsSection(ctx, MY_NS, MyConfigSchema, { allowUpdate: false }, {
        setSource: (current) => { configSource = current },
        // 关闭状态无需写回，仅开启时同步已有档位
        onChange: () => {
            if (configSource().allowUpdate) update(ctx)
        },
    })
    // llm-pi-ai 模型配置变更后重新填充
    ctx.on('settings/updated', (ns) => {
        if (ns !== NS) return
        update(ctx)
    })
    // 首轮缓存读取与异步刷新由 effect 管理：卸载时置位，在途结果不再触碰已卸载上下文
    ctx.effect(() => {
        let disposed = false
        void readCache().then((cached) => {
            if (disposed) return
            if (cached) {
                indexedCache = cached
                // 首轮填充完成后才拉取最新数据，避免两次写入并发冲突
                update(ctx).then(() => {
                    if (disposed) return
                    refresh(ctx, () => disposed)
                })
            } else {
                // 缓存不可用，直接拉取最新数据
                refresh(ctx, () => disposed)
            }
        })
        return () => {
            disposed = true
        }
    })
}