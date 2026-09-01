// migrate.ts 纯函数测试：upgradeConfig 升级链 / DEFAULT_STORED / pruneOps 清理规则
import { upgradeConfig, DEFAULT_STORED, pruneOps } from '../src/migrate'
import { check, stable } from './helper'

/** 执行本文件的全部用例 */
export function run(): void {
    // v0 -> v1 -> v2 链式升级：image 字段落各自默认（autoFill=true、allowUpdate=false）
    check('v0 仅 allowUpdate 布尔', stable(upgradeConfig({ allowUpdate: true }, 0)) === stable({
        configVersion: 2,
        allowUpdate: { reasoning: true, context: true, image: false },
        autoFill: { reasoning: true, context: true, image: true },
    }), upgradeConfig({ allowUpdate: true }, 0))
    check('v0 allowUpdate 对象省略字段', stable(upgradeConfig({ allowUpdate: { reasoning: true } }, 0)) === stable({
        configVersion: 2,
        allowUpdate: { reasoning: true, context: false, image: false },
        autoFill: { reasoning: true, context: true, image: true },
    }), upgradeConfig({ allowUpdate: { reasoning: true } }, 0))
    check('v0 autoFill 布尔 + allowUpdate 对象', stable(upgradeConfig({ autoFill: false, allowUpdate: { context: true } }, 0)) === stable({
        configVersion: 2,
        allowUpdate: { reasoning: false, context: true, image: false },
        autoFill: { reasoning: false, context: false, image: true },
    }), upgradeConfig({ autoFill: false, allowUpdate: { context: true } }, 0))
    check('v0 垃圾输入回整项默认', stable(upgradeConfig({ autoFill: 'x', allowUpdate: 42 }, 0)) === stable({
        configVersion: 2,
        allowUpdate: { reasoning: false, context: false, image: false },
        autoFill: { reasoning: true, context: true, image: true },
    }), upgradeConfig({ autoFill: 'x', allowUpdate: 42 }, 0))
    check('v0 非对象输入回整项默认', stable(upgradeConfig(undefined, 0)) === stable({
        configVersion: 2,
        allowUpdate: { reasoning: false, context: false, image: false },
        autoFill: { reasoning: true, context: true, image: true },
    }), upgradeConfig(undefined, 0))

    // v1 -> v2：沿用原字段，补 image 默认；configVersion 等多余键被忽略
    check('v1 快照升到 v2 并补 image 默认', stable(upgradeConfig({ configVersion: 1, allowUpdate: { reasoning: true, context: false }, autoFill: { reasoning: false, context: true } }, 1)) === stable({
        configVersion: 2,
        allowUpdate: { reasoning: true, context: false, image: false },
        autoFill: { reasoning: false, context: true, image: true },
    }), upgradeConfig({ configVersion: 1, allowUpdate: { reasoning: true, context: false }, autoFill: { reasoning: false, context: true } }, 1))
    check('v1 快照省略 autoFill 整项落默认', stable(upgradeConfig({ configVersion: 1, allowUpdate: { reasoning: true, context: true } }, 1)) === stable({
        configVersion: 2,
        allowUpdate: { reasoning: true, context: true, image: false },
        autoFill: { reasoning: true, context: true, image: true },
    }), upgradeConfig({ configVersion: 1, allowUpdate: { reasoning: true, context: true } }, 1))
    check('v1 垃圾输入回 v1 默认再升 v2', stable(upgradeConfig('garbage', 1)) === stable({
        configVersion: 2,
        allowUpdate: { reasoning: false, context: false, image: false },
        autoFill: { reasoning: true, context: true, image: true },
    }), upgradeConfig('garbage', 1))

    // 默认快照与升级链的一致性（全新用户直写默认 vs 空配置走升级链，结果必须相同）
    check('DEFAULT_STORED 与升级链空输入一致', stable(DEFAULT_STORED) === stable(upgradeConfig({}, 0)), { DEFAULT_STORED, chain: upgradeConfig({}, 0) })

    // pruneOps：两阶段清理——先淘汰低于最低支持版本（Phase A），再淘汰低于当前版本且超出保留上限的 excess（Phase B）；
    // 等于/高于当前版本永不清理；v0 位于 LEGACY、不在 PLUGIN_NS 版本列表内，故不在此处理
    check('当前与高版本不参与清理', pruneOps([2, 5, 6, 7]).length === 0, pruneOps([2, 5, 6, 7]))
    check('低版本未超限不清理', pruneOps([1]).length === 0, pruneOps([1]))
    check('Phase A 清理低于最低支持版本', stable(pruneOps([1, 2, 3, 4], 5, 3, 3)) === stable([
        { op: 'unset', path: ['version-1'] }, { op: 'unset', path: ['version-2'] },
    ]), pruneOps([1, 2, 3, 4], 5, 3, 3))
    check('Phase B 超限淘汰最低', stable(pruneOps([1, 2, 3, 4], 5, 0, 3)) === stable([
        { op: 'unset', path: ['version-1'] },
    ]), pruneOps([1, 2, 3, 4], 5, 0, 3))
    check('两阶段叠加（A 先于 B）', stable(pruneOps([1, 2, 3, 4, 5, 6], 7, 3, 3)) === stable([
        { op: 'unset', path: ['version-1'] }, { op: 'unset', path: ['version-2'] }, { op: 'unset', path: ['version-3'] },
    ]), pruneOps([1, 2, 3, 4, 5, 6], 7, 3, 3))
}
