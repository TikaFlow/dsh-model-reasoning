/**
 * 浏览器半纯映射层：`tikaflow-model-fix` 版本快照段 <-> 卡片六布尔。
 * 零外部值依赖（不引 src/constants、src/types 的值，避免 node:path 等被打进浏览器包），
 * 解析语义镜像 src/config.ts 的 resolveConfig（v2 优先 -> 次高旧快照 -> 默认）。
 */

import type { FieldRules, PluginConfig } from '../types'

/** 本插件的配置命名空间（与 src/constants.ts 的 PLUGIN_NS 字面量一致，宿主迁移后仅存本 NS） */
export const MODEL_FIX_NS = 'tikaflow-model-fix'

/** 当前代码配置版本；与 src/constants.ts 的 CONFIG_VERSION 同步修改 */
export const CONFIG_VERSION = 2

/** 版本快照键前缀 */
const VERSION_PREFIX = 'version-'

/** 快照写入的字段键（保存时单字段原子写 version-2，不触碰段内其他键） */
export const VERSION_KEY = `${VERSION_PREFIX}${CONFIG_VERSION}`

/** 卡片行对应的字段键（渲染顺序与总控共用） */
export const FIELD_KEYS = ['reasoning', 'context', 'image'] as const

/** 列名：自动填充 / 允许更新（对应快照的 autoFill / allowUpdate 组） */
export type Column = 'autoFill' | 'allowUpdate'

/** 六布尔配置（与 PluginConfig 同形） */
export type Flags = PluginConfig

/** 判断是否为普通数据对象（与 src/types 同语义的浏览器本地复制，勿改此处以规避值依赖） */
function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const proto: unknown = Object.getPrototypeOf(value)
    return proto === Object.prototype || proto === null
}

/** 解析 version-N 键；非法返回 undefined */
function parseVersion(key: string): number | undefined {
    if (!key.startsWith(VERSION_PREFIX)) return
    const value = Number(key.slice(VERSION_PREFIX.length))
    return Number.isInteger(value) && value >= 0 ? value : undefined
}

/**
 * 解析一组字段规则（对象写法的单列）：整体缺失落该项默认；
 * 存在但非对象、或字段存在但非布尔 => 返回 undefined 表示整段快照非法（镜像 schema 抛错语义）。
 */
function parseRules(value: unknown, dflt: boolean): FieldRules | undefined {
    if (value === undefined) return { reasoning: dflt, context: dflt, image: dflt }
    if (!isPlainObject(value)) return
    const rules = {} as FieldRules
    for (const key of FIELD_KEYS) {
        const field = value[key]
        if (field === undefined) {
            rules[key] = dflt
            continue
        }
        if (typeof field !== 'boolean') return
        rules[key] = field
    }
    return rules
}

/** 默认配置：填充缺失开启，覆盖更新关闭（与 src/config.ts DEFAULT_CONFIG 一致） */
export const DEFAULT_FLAGS: Flags = {
    autoFill: { reasoning: true, context: true, image: true },
    allowUpdate: { reasoning: false, context: false, image: false },
}

/** 校验并物化 v2 快照；非法返回 undefined（跳过该快照走回落链） */
function parseV2(entry: unknown): Flags | undefined {
    if (!isPlainObject(entry)) return
    const allowUpdate = parseRules(entry.allowUpdate, false)
    if (!allowUpdate) return
    const autoFill = parseRules(entry.autoFill, true)
    if (!autoFill) return
    return { allowUpdate, autoFill }
}

/** 校验并升级 v1 快照（无 image 字段的冻结形态，补各项默认：autoFill.image=true、allowUpdate.image=false） */
function parseV1(entry: unknown): Flags | undefined {
    if (!isPlainObject(entry)) return
    const allowUpdate = parseRules(entry.allowUpdate, false)
    if (!allowUpdate) return
    const autoFill = parseRules(entry.autoFill, true)
    if (!autoFill) return
    return {
        allowUpdate: { ...allowUpdate, image: false },
        autoFill: { ...autoFill, image: true },
    }
}

/**
 * 解码命名空间整段（镜像 resolveConfig）：优先当前版本快照；否则取 <= 当前的最高旧快照；
 * 均不可用回退默认。**永不返回 undefined**（返回 undefined 会让宿主 scope 永挂 loading）。
 */
export function decodeSection(section: unknown): Flags {
    if (!isPlainObject(section)) return DEFAULT_FLAGS
    let best: Flags | undefined
    for (const [key, value] of Object.entries(section)) {
        const version = parseVersion(key)
        if (version === undefined || version > CONFIG_VERSION) continue
        let config: Flags | undefined
        if (version === CONFIG_VERSION) config = parseV2(value)
        else if (version === 1) config = parseV1(value)
        // 更低版本只存在于 LEGACY 旧 NS（宿主启动时已迁移），本段内视为不可读
        if (!config) continue
        if (version === CONFIG_VERSION) return config
        if (!best) best = config
    }
    return best ?? DEFAULT_FLAGS
}

/** 六布尔 -> 规范 v2 存储快照（configVersion + 六布尔全显式，与宿主 DEFAULT_STORED 形态一致） */
export function snapshotFromFlags(flags: Flags): Record<string, unknown> {
    return {
        configVersion: CONFIG_VERSION,
        allowUpdate: { ...flags.allowUpdate },
        autoFill: { ...flags.autoFill },
    }
}

/** 列总控的当前显示值：该列三格中任一为开即为开（点击时取反并整列同置） */
export function masterValue(flags: Flags, column: Column): boolean {
    return FIELD_KEYS.some((key) => flags[column][key])
}

/** 整列同置：把 column 的三格全部设为 value，返回新对象（不改入参） */
export function applyColumn(flags: Flags, column: Column, value: boolean): Flags {
    const rules = { reasoning: value, context: value, image: value }
    return column === 'autoFill'
        ? { ...flags, autoFill: rules }
        : { ...flags, allowUpdate: rules }
}

/** 单格取反：把 column.key 翻转，返回新对象（不改入参） */
export function toggleCell(flags: Flags, column: Column, key: (typeof FIELD_KEYS)[number]): Flags {
    const rules = { ...flags[column] }
    rules[key] = !rules[key]
    return { ...flags, [column]: rules }
}

/** 六布尔逐项比较，判断草稿相对已存配置是否有改动 */
export function isDirty(draft: Flags, saved: Flags): boolean {
    for (const column of ['autoFill', 'allowUpdate'] as const) {
        for (const key of FIELD_KEYS) {
            if (draft[column][key] !== saved[column][key]) return true
        }
    }
    return false
}
