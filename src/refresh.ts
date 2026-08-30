import type { Context } from '@deepseek-ai/cordis'
import { fetchLatest, setCatalog } from './catalog'
import { MAX_ATTEMPTS, PLUGIN_NAME, RETRY_DELAY_MS } from './constants'
import { update } from './update'

/** 异步拉取最新数据：成功后更新索引并再次填充；isDisposed 避免结果触碰已卸载上下文 */
export function refresh(ctx: Context, isDisposed: () => boolean, retryCount = MAX_ATTEMPTS): void {
    fetchLatest(ctx)
        .then((indexed) => {
            if (isDisposed()) return
            setCatalog(indexed)
            update(ctx).catch((error) => {
                if (isDisposed()) return
                ctx.logger.warn(`${PLUGIN_NAME}: 填充失败：${error instanceof Error ? error.message : String(error)}`)
            })
        })
        .catch((error) => {
            if (isDisposed()) return
            // 每次失败都记录，便于判断是一次成功还是重试后才成功
            const attempt = MAX_ATTEMPTS - retryCount + 1
            ctx.logger.warn(
                `${PLUGIN_NAME}: 拉取 models.dev 最新数据失败（第 ${attempt}/${MAX_ATTEMPTS} 次）：${error instanceof Error ? error.message : String(error)}`,
            )
            // 剩余重试次数不足则放弃，交由后续事件或重启再触发
            if (--retryCount <= 0) return
            setTimeout(() => {
                if (isDisposed()) return
                refresh(ctx, isDisposed, retryCount)
            }, RETRY_DELAY_MS)
        })
}
