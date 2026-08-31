// catalog.ts 纯函数测试：buildCatalog 拍平与剪裁（推理/容量/图片模态三源）
import { buildCatalog } from '../src/catalog'
import type { CacheEntry } from '../src/types'
import { check, stable } from './helper'

/** 用单 provider 单模型构造 api 数据并返回该缓存条目（被剪裁时 undefined） */
function one(model: Record<string, unknown>): CacheEntry | undefined {
    return buildCatalog({ p: { models: { m: model } } })[0]
}

/** 执行本文件的全部用例 */
export function run(): void {
    // 图片模态：仅缓存正向信息（支持图片才写 image:true）
    check('仅含图片支持也入库', stable(one({ modalities: { input: ['text', 'image'] } })) === stable({ provider: 'p', id: 'm', efforts: [], image: true }), one({ modalities: { input: ['text', 'image'] } }))
    check('不含 image 且无其他数据被剪裁', one({ modalities: { input: ['text'] } }) === undefined)
    check('image 顺序不影响结果', stable(one({ modalities: { input: ['image', 'text'] } })) === stable({ provider: 'p', id: 'm', efforts: [], image: true }), one({ modalities: { input: ['image', 'text'] } }))
    check('pdf/video/audio 等值不算图片支持，有容量仍入库但不写 image', stable(one({ limit: { context: 100 }, modalities: { input: ['text', 'pdf', 'video', 'audio'] } })) === stable({ provider: 'p', id: 'm', efforts: [], contextWindow: 100 }), one({ limit: { context: 100 }, modalities: { input: ['text', 'pdf', 'video', 'audio'] } }))
    check('非图片模态整体不缓存 false', one({ modalities: { input: [] } }) === undefined && one({ modalities: {} }) === undefined && one({ modalities: 'x' }) === undefined)
    check('modalities 缺失时不写 image 键', stable(one({ limit: { context: 100 } })) === stable({ provider: 'p', id: 'm', efforts: [], contextWindow: 100 }), one({ limit: { context: 100 } }))

    // 剪裁条件回归：有效推理级别、容量、支持图片三者全无才剔除
    check('无任何信息被剪裁', one({ temperature: true }) === undefined)
    check('仅 none 档不算推理但图片支持可入库', stable(one({ reasoning: true, reasoning_options: [{ type: 'toggle' }], modalities: { input: ['text', 'image'] } })) === stable({ provider: 'p', id: 'm', efforts: [], image: true }), one({ reasoning: true, reasoning_options: [{ type: 'toggle' }], modalities: { input: ['text', 'image'] } }))
    check('推理+容量+图片共存全保留', stable(one({ reasoning: true, reasoning_options: [{ type: 'effort', values: ['off', 'high', 'bogus'] }], limit: { context: 200, output: 50 }, modalities: { input: ['text', 'image'] } })) === stable({ provider: 'p', id: 'm', efforts: ['none', 'high'], contextWindow: 200, maxTokens: 50, image: true }), one({ reasoning: true, reasoning_options: [{ type: 'effort', values: ['off', 'high', 'bogus'] }], limit: { context: 200, output: 50 }, modalities: { input: ['text', 'image'] } }))
}
