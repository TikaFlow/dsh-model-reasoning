import type { Context } from '@deepseek-ai/cordis'
import { deepEqualJson } from '@deepseek-ai/dsh-settings'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { getCatalog } from './catalog'
import { lookup, toReasoningEfforts } from './lookup'
import { MAX_ATTEMPTS, NS, PLUGIN_NAME } from './constants'
import { getConfig } from './config'
import type { FieldRules, FieldSwitch } from './types'

/** 解析字段开关为统一规则对象，bool 统一开关，对象按字段分别控制 */
function resolveRules(cfg: FieldSwitch): FieldRules {
    if (typeof cfg === 'boolean') return { reasoning: cfg, context: cfg }
    return cfg
}

/** 判定是否为普通数据对象（非数组、非 null、非类实例） */
function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || value === null || Array.isArray(value)) return false
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

/** 判断错误是否为并发写入冲突（settings 命名空间在读写之间被改动） */
function isSettingsConflict(error: unknown): boolean {
    return (error as { code?: unknown } | null)?.code === 'SETTINGS_CONFLICT'
}

/**
 * 遍历配置的模型写回变更：缺失推理级别/容量且有数据则填充，开启 allowUpdate 则同步最新值，
 * 并剔除旧版遗留的空 input/compat。读 descriptor.user（原始字段）整段写回 models（路径 op
 * 不支持数组下标中继）；数据无档位不删除已有配置。
 */
export async function update(ctx: Context): Promise<void> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        // 冲突重试时重读，获取最新 revision
        const descriptor = ctx.settings.describe().find((d) => d.ns === NS)
        if (!descriptor) return
        const providers = (descriptor.user as { providers?: Record<string, unknown> } | undefined)?.providers
        if (providers == null || typeof providers !== 'object') return
        const cfg = getConfig()
        const allowRules = resolveRules(cfg.allowUpdate)
        const autoRules = resolveRules(cfg.autoFill)
        const indexed = getCatalog()
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
                    && reasoningEfforts === undefined && efforts !== undefined
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
                if (next === undefined) next = models.slice()
                const patched = { ...cleaned }
                if (reasoningFillable || reasoningUpdatable) patched.reasoningEfforts = efforts
                if (contextFillable || contextUpdatable) patched.contextWindow = ctxW
                if (maxTokensFillable || maxTokensUpdatable) patched.maxTokens = maxT
                next[i] = patched
            }
            if (next !== undefined) {
                ops.push({ op: 'set', path: ['providers', providerId, 'models'], value: next })
            }
        }
        if (ops.length === 0) return
        try {
            await ctx.settings.mutate(NS, ops, descriptor.revision)
            ctx.logger.info(`${PLUGIN_NAME}: 已变更 ${changes} 个模型（补充/同步推理级别、容量字段、清理空字段）`)
            return
        } catch (error) {
            const conflict = isSettingsConflict(error) && attempt < MAX_ATTEMPTS
            if (conflict) continue
            ctx.logger.warn(`${PLUGIN_NAME}: ${error instanceof Error ? error.message : String(error)}`)
            return
        }
    }
}
