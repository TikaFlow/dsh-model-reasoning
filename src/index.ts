import type { Context } from '@deepseek-ai/cordis'
import { installSettingsSection } from '@deepseek-ai/dsh-settings'
import { readCache, setCatalog } from './catalog'
import { MY_NS, NS, PLUGIN_NAME } from './constants'
import { DEFAULT_CONFIG, MyConfigSchema, getConfig, setConfigSource } from './config'
import { refresh } from './refresh'
import { update } from './update'

export const name = PLUGIN_NAME
export const inject = ['settings']

export function apply(ctx: Context) {
    // 注册自有配置命名空间：setSource 交由 configSource 读取，onChange 响应配置变更
    installSettingsSection(ctx, MY_NS, MyConfigSchema, DEFAULT_CONFIG, {
        setSource: (current) => { setConfigSource(current) },
        // 插件配置变化时重新填充：autoFill 控制是否填充缺失字段，allowUpdate 控制是否同步已有字段
        onChange: () => {
            const cfg = getConfig()
            if (cfg.autoFill || cfg.allowUpdate) update(ctx)
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
                setCatalog(cached)
                // 首轮填充完成后才拉取最新数据，避免两次写入并发冲突
                update(ctx)
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
