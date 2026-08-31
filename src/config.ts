import z from '@deepseek-ai/schemastery'
import type { FieldRules, MyConfig } from './types'

/** 默认配置：填充缺失开启，覆盖更新关闭 */
export const DEFAULT_CONFIG: MyConfig = { allowUpdate: false, autoFill: true }

/** 字段规则 schema：dflt 为对象写法下省略字段的默认值（autoFill 传 true，allowUpdate 传 false） */
const fieldRules = (dflt: boolean): z<FieldRules> => z.object({
    reasoning: z.boolean().default(dflt),
    context: z.boolean().default(dflt),
})

export const MyConfigSchema: z<MyConfig> = z.object({
    allowUpdate: z.union([z.boolean(), fieldRules(false)]).default(false),
    autoFill: z.union([z.boolean(), fieldRules(true)]).default(true),
})

// 生效配置源：installSettingsSection 挂载后指向 settings scope，否则回退默认
let configSource: () => MyConfig = () => DEFAULT_CONFIG

/** 挂载配置读取来源（由 installSettingsSection 的 setSource 调用） */
export function setConfigSource(current: () => MyConfig): void {
    configSource = current
}

/** 当前生效配置 */
export function getConfig(): MyConfig {
    return configSource()
}
