import type { Context } from '@deepseek-ai/cordis'
import { deepEqualJson } from '@deepseek-ai/dsh-settings'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { getCatalog } from './catalog'
import { lookup, toReasoningEfforts } from './lookup'
import { API_NS, MAX_ATTEMPTS, PLUGIN_NAME } from './constants'
import { getConfig } from './config'
import { isPlainObject } from './types'

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

/** 判断错误是否为并发写入冲突（settings 命名空间在读写之间被改动） */
function isSettingsConflict(error: unknown): boolean {
    return (error as { code?: unknown })?.code === 'SETTINGS_CONFLICT'
}

/**
 * 遍历配置的模型写回变更：缺失推理级别/容量且有数据则填充，开启 allowUpdate 则同步最新值，
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
                // 推理级别
                const reasoningFillable = autoRules.reasoning
                    && reasoningEfforts === undefined && !!efforts
                const reasoningUpdatable = allowRules.reasoning
                    && !deepEqualJson(reasoningEfforts, efforts)
                    && isPlainObject(efforts)
                const ctxW = entry?.contextWindow
                const maxT = entry?.maxTokens
                const contextFillable = autoRules.context
                    && contextWindow === undefined && typeof ctxW === 'number'
                const contextUpdatable = allowRules.context
                    && ctxW !== contextWindow
                    && typeof ctxW === 'number'
                const maxTokensFillable = autoRules.context
                    && maxTokens === undefined && typeof maxT === 'number'
                const maxTokensUpdatable = allowRules.context
                    && maxT !== maxTokens
                    && typeof maxT === 'number'
                if (cleaned === record && !reasoningFillable && !reasoningUpdatable
                    && !contextFillable && !contextUpdatable && !maxTokensFillable && !maxTokensUpdatable) continue
                changes++
                next ??= models.slice()
                const patched = { ...cleaned }
                if (reasoningFillable || reasoningUpdatable) patched.reasoningEfforts = efforts
                if (contextFillable || contextUpdatable) patched.contextWindow = ctxW
                if (maxTokensFillable || maxTokensUpdatable) patched.maxTokens = maxT
                next[i] = patched
            }
            if (next) {
                ops.push({ op: 'set', path: ['providers', providerId, 'models'], value: next })
            }
        }
        if (ops.length === 0) return
        try {
            await ctx.settings.mutate(API_NS, ops, descriptor.revision)
            ctx.logger.info(`${PLUGIN_NAME}: 已变更 ${changes} 个模型（补充/同步推理级别、容量字段、清理空字段）`)
            return
        } catch (error) {
            if (isSettingsConflict(error) && attempt < MAX_ATTEMPTS) continue
            ctx.logger.warn(`${PLUGIN_NAME}: ${error instanceof Error ? error.message : String(error)}`)
            return
        }
    }
}
