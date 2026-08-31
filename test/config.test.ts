// config.ts 纯函数测试：resolveConfig / versionKey / parseVersion
import { resolveConfig, versionKey, parseVersion } from '../src/config'
import { check, stable } from './helper'

/** 执行本文件的全部用例 */
export function run(): void {
    check('versionKey 拼接', versionKey(1) === 'version-1')
    check('parseVersion 合法', parseVersion('version-12') === 12)
    check('parseVersion 非法返回 undefined', parseVersion('version-x') === undefined && parseVersion('allowUpdate') === undefined)

    const v1Entry = { configVersion: 1, autoFill: { reasoning: true, context: false }, allowUpdate: { reasoning: false, context: false } }
    const DEFAULT_STABLE = stable({ allowUpdate: { reasoning: false, context: false }, autoFill: { reasoning: true, context: true } })
    check('取当前版本快照', stable(resolveConfig({ 'version-1': v1Entry })) === stable({ autoFill: { reasoning: true, context: false }, allowUpdate: { reasoning: false, context: false } }), resolveConfig({ 'version-1': v1Entry }))
    check('布尔写法在 v1 快照中非法，回退默认', stable(resolveConfig({ 'version-1': { configVersion: 1, allowUpdate: true, autoFill: false } })) === DEFAULT_STABLE, resolveConfig({ 'version-1': { configVersion: 1, allowUpdate: true, autoFill: false } }))
    check('缺字段按整项默认补齐', stable(resolveConfig({ 'version-1': { configVersion: 1, autoFill: { context: false } } })) === stable({ allowUpdate: { reasoning: false, context: false }, autoFill: { reasoning: true, context: false } }), resolveConfig({ 'version-1': { configVersion: 1, autoFill: { context: false } } }))
    check('低版本快照含布尔写法（v0 形态）无法按 v1 解析，回退默认', stable(resolveConfig({ 'version-0': { allowUpdate: true } })) === DEFAULT_STABLE, resolveConfig({ 'version-0': { allowUpdate: true } }))
    check('仅更高版本回默认', stable(resolveConfig({ 'version-9': { whatever: true } })) === DEFAULT_STABLE, resolveConfig({ 'version-9': { whatever: true } }))
    check('非法快照回默认', stable(resolveConfig({ 'version-1': 'garbage' })) === DEFAULT_STABLE, resolveConfig({ 'version-1': 'garbage' }))
    check('段为数组/非对象回默认', stable(resolveConfig([])) === DEFAULT_STABLE, resolveConfig([]))
}
