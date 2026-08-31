// migrate.ts 纯函数测试：upgradeConfig 升级链 / DEFAULT_STORED / pruneOps 清理规则
import { upgradeConfig, DEFAULT_STORED, pruneOps } from '../src/migrate'
import { check, stable } from './helper'

/**
 * 模拟未来新增台阶（当前版本=2）的链式写法，验证「逐级升级、每步只做相邻版本、
 * 入口指向最新台阶」的约定成立：upgradeConfig -> upgrade1To2 ->(v<1 时) upgrade0To1。
 */
function simulateUpgrade0To1(config: unknown, _fromVersion: number) {
    const raw: Record<string, unknown> = config && typeof config === 'object' && !Array.isArray(config)
        ? config as Record<string, unknown> : {}
    return { configVersion: 1, allowUpdate: raw.allowUpdate ?? false, autoFill: raw.autoFill ?? true }
}
function simulateUpgrade1To2(config: unknown, fromVersion: number) {
    const v1 = fromVersion < 1 ? simulateUpgrade0To1(config, fromVersion) : config as ReturnType<typeof simulateUpgrade0To1>
    // 1 -> 2：新增独立容量开关，沿用 autoFill 取值
    return { configVersion: 2, allowUpdate: v1.allowUpdate, autoFill: v1.autoFill, capacityFill: v1.autoFill }
}

/** 执行本文件的全部用例 */
export function run(): void {
    // v0 -> v1 无损升级
    check('v0 仅 allowUpdate 布尔', stable(upgradeConfig({ allowUpdate: true }, 0)) === stable({
        configVersion: 1, allowUpdate: { reasoning: true, context: true }, autoFill: { reasoning: true, context: true },
    }), upgradeConfig({ allowUpdate: true }, 0))
    check('v0 allowUpdate 对象省略字段', stable(upgradeConfig({ allowUpdate: { reasoning: true } }, 0)) === stable({
        configVersion: 1, allowUpdate: { reasoning: true, context: false }, autoFill: { reasoning: true, context: true },
    }), upgradeConfig({ allowUpdate: { reasoning: true } }, 0))
    check('v0 autoFill 布尔 + allowUpdate 对象', stable(upgradeConfig({ autoFill: false, allowUpdate: { context: true } }, 0)) === stable({
        configVersion: 1, allowUpdate: { reasoning: false, context: true }, autoFill: { reasoning: false, context: false },
    }), upgradeConfig({ autoFill: false, allowUpdate: { context: true } }, 0))
    check('垃圾输入回整项默认', stable(upgradeConfig({ autoFill: 'x', allowUpdate: 42 }, 0)) === stable({
        configVersion: 1, allowUpdate: { reasoning: false, context: false }, autoFill: { reasoning: true, context: true },
    }), upgradeConfig({ autoFill: 'x', allowUpdate: 42 }, 0))
    check('非对象输入回整项默认', stable(upgradeConfig(undefined, 0)) === stable({
        configVersion: 1, allowUpdate: { reasoning: false, context: false }, autoFill: { reasoning: true, context: true },
    }), upgradeConfig(undefined, 0))
    check('已是 v1 形态再过本台阶保持幂等', stable(upgradeConfig({ configVersion: 1, allowUpdate: { reasoning: true, context: false }, autoFill: { reasoning: false, context: true } }, 1)) === stable({
        configVersion: 1, allowUpdate: { reasoning: true, context: false }, autoFill: { reasoning: false, context: true },
    }), upgradeConfig({ configVersion: 1, allowUpdate: { reasoning: true, context: false }, autoFill: { reasoning: false, context: true } }, 1))

    // 默认快照与升级链的一致性（全新用户直写默认 vs 空配置走升级链，结果必须相同）
    check('DEFAULT_STORED 与升级链空输入一致', stable(DEFAULT_STORED) === stable(upgradeConfig({}, 0)), { DEFAULT_STORED, chain: upgradeConfig({}, 0) })

    // 链式约定（模拟 v2）
    const fromV0 = simulateUpgrade1To2({ allowUpdate: true }, 0)
    check('链式：v0 逐级升到 v2', fromV0.configVersion === 2 && fromV0.allowUpdate === true && JSON.stringify(fromV0.capacityFill) === 'true', fromV0)
    const fromV1 = simulateUpgrade1To2({ configVersion: 1, allowUpdate: false, autoFill: { reasoning: true, context: false } }, 1)
    check('链式：v1 直达 v2（跳过 v0 台阶）', fromV1.configVersion === 2 && fromV1.allowUpdate === false && JSON.stringify(fromV1.capacityFill) === JSON.stringify({ reasoning: true, context: false }), fromV1)

    // pruneOps：只淘汰低于当前版本的超限快照，等于/高于当前版本永不清理
    check('高版本不参与清理', pruneOps([0, 1, 5, 6, 7]).length === 0, pruneOps([0, 1, 5, 6, 7]))
    check('低版本未超限不清理', pruneOps([0, 1]).length === 0, pruneOps([0, 1]))
}
