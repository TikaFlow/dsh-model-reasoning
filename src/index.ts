import type { Context } from '@deepseek-ai/cordis'
import { installSettingsSection } from '@deepseek-ai/dsh-settings'
import { readCache, setCatalog } from './catalog'
import { LEGACY_NS, PLUGIN_NS, API_NS, PLUGIN_NAME } from './constants'
import { DEFAULT_SECTION, SectionSchema, resolveConfig, setConfigSource } from './config'
import { LegacyConfigSchema, LEGACY_BASE, isNamespaceRegistered, migrateConfig, waitForSettingsReady } from './migrate'
import { refresh } from './refresh'
import { fix } from './fix'

export const name = PLUGIN_NAME
export const inject = ['settings']

export function apply(ctx: Context) {
    // 注册自有配置命名空间：段为版本快照容器，setSource 解析出运行时配置，onChange 响应配置变更
    installSettingsSection(ctx, PLUGIN_NS, SectionSchema, DEFAULT_SECTION, {
        setSource: (current) => { setConfigSource(() => resolveConfig(current())) },
        // 插件配置变化时重新填充（fix 内部对无变更字段自然跳过）
        onChange: () => { fix(ctx) },
    })
    // 注册旧命名空间 shim（冻结 v0 schema，仅供迁移读取）。注册及其失败（冲突/存储段非法）都在
    // 子 fiber 微任务内发生，故其结果在下方启动 effect 就绪后用 isNamespaceRegistered 检测
    installSettingsSection(ctx, LEGACY_NS, LegacyConfigSchema, LEGACY_BASE, {
        setSource: () => {},
        onChange: () => {},
    })
    // llm-pi-ai 模型配置变更后重新填充
    ctx.on('settings/updated', (ns) => {
        if (ns !== API_NS) return
        fix(ctx)
    })
    // 首轮：等待自有命名空间注册完成 → 配置迁移 → 缓存读取 → 填充 → 异步刷新，统一由 effect 管理
    // （注册经 installSettingsSection 的子 fiber 延迟到微任务，必须等其完成后再迁移，否则 describe() 读空）
    // 卸载时置位，在途结果不触碰已卸载的上下文；迁移失败仅告警、按当前生效配置继续
    ctx.effect(() => {
        let disposed = false
        void waitForSettingsReady(ctx, () => disposed)
            .then((ready) => {
                if (disposed) return
                // 命名空间迟迟未注册（如服务缺席）时跳过迁移，不阻塞后续按生效配置的填充
                if (!ready) {
                    ctx.logger.warn(`${PLUGIN_NAME}: 未检测到自有配置命名空间注册，跳过配置迁移`)
                    return
                }
                // 此刻 PLUGIN_NS/LEGACY_NS 的注册回调均已执行：旧 NS 缺席说明其注册失败
                // （被占用或存储段非法），迁移将按无旧配置处理
                if (!isNamespaceRegistered(ctx, LEGACY_NS)) {
                    ctx.logger.warn(`${PLUGIN_NAME}: 旧配置命名空间未成功注册（可能已被其他插件占用或存有非法配置），迁移按无旧配置处理`)
                }
                return migrateConfig(ctx)
            })
            .catch((error) => {
                if (disposed) return
                ctx.logger.warn(`${PLUGIN_NAME}: 配置迁移失败，使用当前生效配置继续：${error instanceof Error ? error.message : String(error)}`)
            })
            .then(() => readCache())
            .then((cached) => {
                if (disposed) return
                if (cached) {
                    setCatalog(cached)
                    // 首轮填充完成后才拉取最新数据，避免两次写入并发冲突
                    fix(ctx)
                        .finally(() => {
                            if (disposed) return
                            refresh(ctx, () => disposed)
                        })
                        .catch((error) => {
                            if (disposed) return
                            ctx.logger.warn(`${PLUGIN_NAME}: 填充失败：${error instanceof Error ? error.message : String(error)}`)
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
