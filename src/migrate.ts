import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace, SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { CONFIG_VERSION, LEGACY_NS, MAX_OLD_SNAPSHOTS, MIN_SUPPORTED_VERSION, PLUGIN_NAME, PLUGIN_NS } from './constants'
import { DEFAULT_CONFIG, parseVersion, versionKey } from './config'
import type { LegacyConfig, LegacyFieldRules, LegacyFieldSwitch, PluginConfigSnapshot, V1FieldRules, V1PluginConfigSnapshot, VersionedSection } from './types'
import { isPlainObject } from './types'

// ---------- LEGACY（v0）迁移源代码：形态冻结（见 types.ts LEGACY 段说明），不引用当前版本的可演进定义。 ----------

/** LEGACY(v0)：字段规则 schema，dflt 为省略字段的默认值 */
const legacyFieldRules = (dflt: boolean): z<LegacyFieldRules> => z.object({
    reasoning: z.boolean().default(dflt),
    context: z.boolean().default(dflt),
})

/** LEGACY(v0)：配置 schema（布尔统一开关或对象按字段控制） */
export const LegacyConfigSchema: z<LegacyConfig> = z.object({
    allowUpdate: z.union([z.boolean(), legacyFieldRules(false)]).default(false),
    autoFill: z.union([z.boolean(), legacyFieldRules(true)]).default(true),
})

/** LEGACY(v0)：默认配置，旧 NS 注册的 base 层与解析失败兜底 */
export const LEGACY_BASE: LegacyConfig = { allowUpdate: false, autoFill: true }

/** LEGACY(v0)：布尔统一开关展开为规范对象形态（schema 解析后对象内字段已补齐） */
function legacyExpand(value: LegacyFieldSwitch): LegacyFieldRules {
    if (typeof value === 'boolean') return { reasoning: value, context: value }
    return value
}

// ---------- LEGACY（v1）迁移源代码：version-1 快照的冻结形态（见 types.ts LEGACY(v1) 段说明），不引用当前版本的可演进定义。 ----------

/** LEGACY(v1)：字段规则 schema（无 image 字段），dflt 为省略字段的默认值 */
const v1FieldRules = (dflt: boolean): z<V1FieldRules> => z.object({
    reasoning: z.boolean().default(dflt),
    context: z.boolean().default(dflt),
})

/** LEGACY(v1)：配置 schema（仅对象写法，configVersion 等多余键被 schema 忽略） */
const V1ConfigSchema: z<Omit<V1PluginConfigSnapshot, 'configVersion'>> = z.object({
    allowUpdate: v1FieldRules(false).default({ reasoning: false, context: false }),
    autoFill: v1FieldRules(true).default({ reasoning: true, context: true }),
})

/** LEGACY(v1)：默认配置，解析失败兜底 */
const V1_BASE: Omit<V1PluginConfigSnapshot, 'configVersion'> = { allowUpdate: { reasoning: false, context: false }, autoFill: { reasoning: true, context: true } }

/** v0 → v1：输入按 v0 schema 解析（非法整体回退 v0 默认），布尔统一开关展开为对象并补齐省略字段，添加版本号 */
function upgrade0To1(config: unknown, fromVersion: number): V1PluginConfigSnapshot {
    if (fromVersion < MIN_SUPPORTED_VERSION) {
        throw new Error(`无法从 v${fromVersion} 升级：低于最低支持版本 v${MIN_SUPPORTED_VERSION}`)
    }
    let legacy: LegacyConfig
    try {
        legacy = LegacyConfigSchema((isPlainObject(config) ? config : {}) as unknown as LegacyConfig)
    } catch {
        legacy = LEGACY_BASE
    }
    // 台阶目标版本固定为 1（本函数产物形态恒定），更高版本由后续台阶接力，故不引用 CONFIG_VERSION
    return { configVersion: 1, allowUpdate: legacyExpand(legacy.allowUpdate), autoFill: legacyExpand(legacy.autoFill) }
}

// ---------- 升级链（每级只做相邻版本升级） ----------

/** v1 → v2：输入按 v1 冻结 schema 解析（非法整体回退 v1 默认），新增 image 字段并落各自默认（autoFill=true、allowUpdate=false） */
function upgrade1To2(config: unknown, fromVersion: number): PluginConfigSnapshot {
    const v1 = fromVersion < 1
        ? upgrade0To1(config, fromVersion)
        : (() => {
            try {
                return V1ConfigSchema((isPlainObject(config) ? config : {}) as unknown as Omit<V1PluginConfigSnapshot, 'configVersion'>)
            } catch {
                return V1_BASE
            }
        })()
    // 台阶目标版本固定为 2（本函数产物形态恒定），更高版本由后续台阶接力，故不引用 CONFIG_VERSION
    return {
        configVersion: 2,
        allowUpdate: { ...v1.allowUpdate, image: false },
        autoFill: { ...v1.autoFill, image: true },
    }
}

/**
 * 配置版本迁移入口：把 fromVersion（段内旧快照版本；旧 NS 配置传最低支持版本 0）
 * 逐级升级到当前 CONFIG_VERSION 快照形态。
 * 新版本发布时：新增「只做相邻一级升级」的 upgradeNToN+1 函数，并把本函数指向最新台阶，
 * 链上既有函数一律不改。例如未来当前版本=3：
 *   upgradeConfig = (c, v) => upgrade2To3(c, v)
 *   upgrade2To3 = (c, v) => { const v2 = v < 2 ? upgrade1To2(c, v) : c; return /* 2→3 的升级 *\/ }
 */
export function upgradeConfig(config: unknown, fromVersion: number): PluginConfigSnapshot {
    // 当前版本 = 2：升级链最新台阶为 v1 → v2
    return upgrade1To2(config, fromVersion)
}

/** 全新用户的规范默认快照（与升级链对空输入的结果一致，由 test 守护） */
export const DEFAULT_STORED: PluginConfigSnapshot = {
    configVersion: CONFIG_VERSION,
    allowUpdate: DEFAULT_CONFIG.allowUpdate,
    autoFill: DEFAULT_CONFIG.autoFill,
}

/** 收集段内合法且不低于最低支持的版本号（升序） */
function collectVersions(section: VersionedSection | undefined): number[] {
    if (!section) return []
    const versions = new Set<number>()
    for (const key of Object.keys(section)) {
        const version = parseVersion(key)
        if (version !== undefined && version >= MIN_SUPPORTED_VERSION) versions.add(version)
    }
    return [...versions].sort((a, b) => a - b)
}

/**
 * 清理低于当前版本且超出保留上限的旧快照（升序排列，从最低版本开始淘汰）；
 * 等于或高于当前版本的快照始终保留（当前在使用，高版本供回退后无损读取）。
 */
export function pruneOps(versions: number[]): SettingsPathOp[] {
    const olds = versions.filter((version) => version < CONFIG_VERSION)
    if (olds.length <= MAX_OLD_SNAPSHOTS) return []
    return olds.slice(0, olds.length - MAX_OLD_SNAPSHOTS)
        .map((version) => ({ op: 'unset', path: [versionKey(version)] }))
}

/** 读取指定命名空间当前的用户段与 revision */
function readSection(ctx: Context, ns: SettingsNamespace) {
    const descriptor = ctx.settings.describe().find((d) => d.ns === ns)
    if (!descriptor) return
    return { user: descriptor.user, revision: descriptor.revision }
}

/**
 * 启动时配置迁移：
 * - 有当前版本快照 → 直接使用，仅按上限清理低版本旧快照（高版本快照保留）
 * - 无当前版本 → 依次尝试：段内最低支持以上的最高旧快照 → 旧命名空间用户段（v0），走升级链；
 *   两者皆无（全新用户）→ 直接写入规范默认快照（不经升级链），确保后续读取必有当前版本
 * - 旧命名空间段保留，供回滚旧版插件继续读取
 */
export async function migrateConfig(ctx: Context): Promise<void> {
    const mine = readSection(ctx, PLUGIN_NS)
    if (!mine) return
    const section = isPlainObject(mine.user) ? mine.user as VersionedSection : undefined
    const versions = collectVersions(section)
    if (versions.includes(CONFIG_VERSION)) {
        const ops = pruneOps(versions)
        if (ops.length > 0) await ctx.settings.mutate(PLUGIN_NS, ops, mine.revision)
        return
    }
    if (versions.some((v) => v > CONFIG_VERSION)) {
        ctx.logger.warn(`${PLUGIN_NAME}: 检测到更高版本的配置快照（可能有新版插件在管配置），本版本仅保留不读取其内容`)
    }
    // 迁移源：段内可处理的最高旧快照；其次存在用户段的旧 NS；均无则视为全新用户，直接落默认
    const olds = versions.filter((v) => v < CONFIG_VERSION)
    const sourceVersion = olds[olds.length - 1]
    const legacyUser = readSection(ctx, LEGACY_NS)?.user
    let stored: PluginConfigSnapshot
    let action: string
    if (sourceVersion !== undefined) {
        stored = upgradeConfig(section?.[versionKey(sourceVersion)], sourceVersion)
        action = `从段内 ${versionKey(sourceVersion)} 快照升级`
    } else if (isPlainObject(legacyUser)) {
        stored = upgradeConfig(legacyUser, MIN_SUPPORTED_VERSION)
        action = `从旧命名空间配置（v${MIN_SUPPORTED_VERSION}）升级`
    } else {
        stored = DEFAULT_STORED
        action = '写入默认配置'
    }
    const ops: SettingsPathOp[] = [
        { op: 'set', path: [versionKey(CONFIG_VERSION)], value: stored },
        ...pruneOps([...versions, CONFIG_VERSION]),
    ]
    await ctx.settings.mutate(PLUGIN_NS, ops, mine.revision)
    ctx.logger.info(`${PLUGIN_NAME}: ${action}，已写入 ${versionKey(CONFIG_VERSION)} 快照`)
}
