import z from '@deepseek-ai/schemastery'
import type { FieldRules, MyConfig } from './types'

/** 默认配置：填充缺失开启，覆盖更新关闭 */
export const DEFAULT_CONFIG: MyConfig = { allowUpdate: false, autoFill: true }

const FieldRulesSchema: z<FieldRules> = z.object({
    reasoning: z.boolean().default(false),
    context: z.boolean().default(false),
})

export const MyConfigSchema: z<MyConfig> = z.object({
    allowUpdate: z.union([z.boolean(), FieldRulesSchema]).default(false),
    autoFill: z.union([z.boolean(), FieldRulesSchema]).default(true),
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
