import type { Context } from '@deepseek-ai/cordis'
import { deepEqualJson } from '@deepseek-ai/dsh-settings'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { getCatalog } from './catalog'
import { lookup, toReasoningEfforts } from './lookup'
import { API_NS, MAX_ATTEMPTS, PLUGIN_NAME } from './constants'
import { getConfig } from './config'
import { isCapacity, isPlainObject } from './types'

/** 剔除空 input/compat：两者在 harness 语义上等同缺失，删除无损，操作幂等 */
function stripEmptyArtifacts(model: Record<string, unknown>): Record<string, unknown> {
    let next: Record<string, unknown> | undefined
    const input = model.input
    if (Array.isArray(input) && input.length === 0) {
        next = { ...model }
        delete next.input
    }
    const compat = model.compat
    if (isPlainObject(compat) && Object.keys(compat).length === 0) {
        next ??= { ...model }
        delete next.compat
    }
    return next ?? model
}

/** 缓存图片信息转换为写回的 input 模态数组：仅支持图片时填 ['text','image']，无数据或纯文本不填（未声明即按纯文本处理） */
function toInputValue(image: boolean | undefined): string[] | undefined {
    return image ? ['text', 'image'] : undefined
}

/** 判断错误是否为并发写入冲突（settings 命名空间在读写之间被改动） */
function isSettingsConflict(error: unknown): boolean {
    return (error as { code?: unknown })?.code === 'SETTINGS_CONFLICT'
}

/**
 * 遍历配置的模型写回变更：缺失推理级别/容量/图片模态且有数据则填充，开启 allowUpdate 则同步最新值，
 * 并剔除空 input/compat。读 descriptor.user（原始字段）整段写回 models（路径 op
 * 不支持数组下标中继）；数据无档位不删除已有配置。
 */
export async function fix(ctx: Context): Promise<void> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        // 冲突重试时重读，获取最新 revision
        const descriptor = ctx.settings.describe().find((d) => d.ns === API_NS)
        if (!descriptor) return
        const providers = (descriptor.user as { providers?: Record<string, unknown> } | undefined)?.providers
        if (!isPlainObject(providers)) return
        const cfg = getConfig()
        const allowRules = cfg.allowUpdate
        const autoRules = cfg.autoFill
        const indexed = getCatalog()
        const ops: SettingsPathOp[] = []
        let changes = 0
        for (const [providerId, provider] of Object.entries(providers)) {
            if (!isPlainObject(provider)) continue
            const models = (provider as { models?: unknown }).models
            if (!Array.isArray(models)) continue
            let next: Record<string, unknown>[] | undefined
            for (let i = 0; i < models.length; i++) {
                const model = models[i]
                if (!isPlainObject(model)) continue
                const record = model as Record<string, unknown>
                const { id, reasoningEfforts, contextWindow, maxTokens } = record as {
                    id?: unknown
                    reasoningEfforts?: unknown
                    contextWindow?: unknown
                    maxTokens?: unknown
                }
                if (id == null) continue
                const cleaned = stripEmptyArtifacts(record)
                const entry = lookup(indexed, providerId, String(id))
                const efforts = toReasoningEfforts(entry)
                // 图片模态以剔除空数组后的值为准（harness 语义：空数组 = 未声明）
                const input = cleaned.input
                const inputValue = toInputValue(entry?.image)
                // 推理级别
                const reasoningFillable = autoRules.reasoning
                    && reasoningEfforts === undefined && !!efforts
                const reasoningUpdatable = allowRules.reasoning
                    && !deepEqualJson(reasoningEfforts, efforts)
                    && isPlainObject(efforts)
                // 容量新值须为正整数且非哨兵（存量旧缓存可能仍带 0/99999999，写 0 会被 schema 拒绝并连累整批）
                const ctxW = entry?.contextWindow
                const maxT = entry?.maxTokens
                const contextFillable = autoRules.context
                    && contextWindow === undefined && isCapacity(ctxW)
                const contextUpdatable = allowRules.context
                    && ctxW !== contextWindow
                    && isCapacity(ctxW)
                const maxTokensFillable = autoRules.context
                    && maxTokens === undefined && isCapacity(maxT)
                const maxTokensUpdatable = allowRules.context
                    && maxT !== maxTokens
                    && isCapacity(maxT)
                const imageFillable = autoRules.image
                    && input === undefined && !!inputValue
                const imageUpdatable = allowRules.image
                    && !!inputValue
                    && !deepEqualJson(input, inputValue)
                if (cleaned === record && !reasoningFillable && !reasoningUpdatable
                    && !contextFillable && !contextUpdatable && !maxTokensFillable && !maxTokensUpdatable
                    && !imageFillable && !imageUpdatable) continue
                changes++
                next ??= models.slice()
                const patched = { ...cleaned }
                if (reasoningFillable || reasoningUpdatable) patched.reasoningEfforts = efforts
                if (contextFillable || contextUpdatable) patched.contextWindow = ctxW
                if (maxTokensFillable || maxTokensUpdatable) patched.maxTokens = maxT
                if (imageFillable || imageUpdatable) patched.input = inputValue
                next[i] = patched
            }
            if (next) {
                ops.push({ op: 'set', path: ['providers', providerId, 'models'], value: next })
            }
        }
        if (ops.length === 0) return
        try {
            await ctx.settings.mutate(API_NS, ops, descriptor.revision)
            ctx.logger.info(`${PLUGIN_NAME}: 已变更 ${changes} 个模型（补充/同步推理级别、容量字段、图片模态、清理空字段）`)
            return
        } catch (error) {
            if (isSettingsConflict(error) && attempt < MAX_ATTEMPTS) continue
            ctx.logger.warn(`${PLUGIN_NAME}: ${error instanceof Error ? error.message : String(error)}`)
            return
        }
    }
}
