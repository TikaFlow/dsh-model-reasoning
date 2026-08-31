import { readFile, writeFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { API_URL, CACHE_FILE, FETCH_MS, LEVELS, MAX_ATTEMPTS, PLUGIN_NAME, RETRY_DELAY_MS } from './constants'
import type { CacheEntry, Catalog, IndexedCatalog, ModelEntry, ProviderGroup } from './types'
import { isPlainObject } from './types'

/** 目录尚未可用时的空兜底 */
const EMPTY_INDEX: IndexedCatalog = { catalog: [], groups: new Map() }

// 内存索引：缓存加载或网络拉取成功后整体替换
let indexedCache: IndexedCatalog | undefined

/** 当前目录（未初始化时返回空兜底） */
export function getCatalog(): IndexedCatalog {
    return indexedCache ?? EMPTY_INDEX
}

/** 整体替换内存索引 */
export function setCatalog(indexed: IndexedCatalog): void {
    indexedCache = indexed
}

/** 解析 models.dev 单条模型数据为推理、容量与模态结果；无有效信息返回 undefined */
function fromApiEntry(entry: unknown): ModelEntry | undefined {
    if (!isPlainObject(entry)) return
    const { reasoning, reasoning_options: rawOptions, limit, modalities } = entry as {
        reasoning?: boolean
        reasoning_options?: unknown
        limit?: unknown
        modalities?: unknown
    }
    const options = Array.isArray(rawOptions) ? rawOptions : []
    const efforts: string[] = []
    let toggle = false
    for (const option of options) {
        if (!isPlainObject(option)) continue
        const { type, values } = option as { type?: unknown; values?: unknown }
        if (type === 'toggle') toggle = true
        if (type === 'effort' && Array.isArray(values)) {
            for (const value of values) {
                if (typeof value === 'string' && value) efforts.push(value)
            }
        }
    }
    // 容量字段（limit.context / limit.output）
    const limitRecord = isPlainObject(limit) ? limit : undefined
    const contextWindow = typeof limitRecord?.context === 'number' ? limitRecord.context : undefined
    const maxTokens = typeof limitRecord?.output === 'number' ? limitRecord.output : undefined
    // 图片模态（modalities.input 含 'image'）：仅记录支持图片的模型（置 true）；
    // 不含 image、无数组或空数组均省略（不缓存 false，控制体积）；pdf/video/audio 等其他值忽略
    const rawInput = isPlainObject(modalities) && Array.isArray(modalities.input) ? modalities.input : undefined
    const image = rawInput && rawInput.includes('image')
    // 有推理级别、容量或图片支持才算有效数据
    const hasReasoning = reasoning === true && (toggle || efforts.length > 0)
    const hasContext = contextWindow !== undefined || maxTokens !== undefined
    if (!hasReasoning && !hasContext && !image) return
    return { reasoning: hasReasoning, toggle, efforts, contextWindow, maxTokens, image }
}

/**
 * 将 models.dev 原始 JSON 拍平为缓存数组：仅保留有可用推理级别、容量或支持图片的模型；
 * efforts 过滤为 harness 支持的取值并统一 'off' 拼写为 'none'，toggle 且无关闭标记时补 'none'。
 */
export function buildCatalog(api: Record<string, unknown> | undefined): Catalog {
    const catalog: Catalog = []
    for (const [provider, block] of Object.entries(api ?? {})) {
        if (!isPlainObject(block)) continue
        const models = (block as { models?: unknown }).models
        if (!isPlainObject(models)) continue
        for (const [id, entry] of Object.entries(models as Record<string, unknown>)) {
            const parsed = fromApiEntry(entry)
            if (!parsed) continue
            const efforts = [
                ...new Set(
                    parsed.efforts
                        .map((effort) => (effort === 'off' ? 'none' : effort))
                        .filter((effort) => effort === 'none' || LEVELS.has(effort)),
                ),
            ]
            if (parsed.toggle && !efforts.includes('none')) efforts.unshift('none')
            const hasUsableReasoning = parsed.reasoning && efforts.some((effort) => effort !== 'none')
            // 仅有 none 的推理能力（无可选档位）不视为推理数据，但容量或图片支持仍可入库
            if (!hasUsableReasoning && parsed.contextWindow === undefined && parsed.maxTokens === undefined && !parsed.image) continue
            const result: CacheEntry = { provider, id, efforts: hasUsableReasoning ? efforts : [] }
            if (parsed.contextWindow !== undefined) result.contextWindow = parsed.contextWindow
            if (parsed.maxTokens !== undefined) result.maxTokens = parsed.maxTokens
            if (parsed.image) result.image = parsed.image
            catalog.push(result)
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

/** 从缓存文件异步加载目录：解析结果非空数组才算可用 */
export async function readCache(): Promise<IndexedCatalog | undefined> {
    try {
        const parsed = JSON.parse(await readFile(CACHE_FILE, 'utf8')) as unknown
        if (!Array.isArray(parsed) || parsed.length === 0) return
        return indexFromArray(parsed as CacheEntry[])
    } catch {
        return
    }
}

/** 拉取 models.dev 最新数据：数据非空才返回并覆盖缓存；内容无变化跳过写入。失败抛出由调用方记录日志 */
export async function fetchLatest(ctx: Context): Promise<IndexedCatalog> {
    const res = await fetch(API_URL, {
        signal: AbortSignal.timeout(FETCH_MS),
        headers: { 'User-Agent': PLUGIN_NAME },
    })
    if (!res.ok) throw new Error(`${API_URL} -> ${res.status}`)
    const api = (await res.json()) as Record<string, unknown>
    const catalog = buildCatalog(api)
    // 空数据拒绝覆盖，避免坏响应破坏现有目录
    if (catalog.length === 0) throw new Error(`${API_URL} 返回的数据未包含可用的模型信息`)
    const indexed = indexFromArray(catalog)
    const serialized = JSON.stringify(catalog)
    if (!indexedCache || serialized !== JSON.stringify(indexedCache.catalog)) {
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                await writeFile(CACHE_FILE, serialized)
                break
            } catch (error) {
                // 每次失败都记录，便于判断是一次成功还是重试后才成功
                ctx.logger.warn(
                    `${PLUGIN_NAME}: 写入缓存失败（第 ${attempt}/${MAX_ATTEMPTS} 次）：${error instanceof Error ? error.message : String(error)}`,
                )
                if (attempt < MAX_ATTEMPTS) {
                    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS))
                }
            }
        }
    }
    return indexed
}
