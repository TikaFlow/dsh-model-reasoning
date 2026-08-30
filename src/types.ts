/** models.dev 单条条目的推理与容量解析结果 */
export interface ModelEntry {
    reasoning: boolean
    toggle: boolean
    efforts: string[]
    /** 最大上下文窗口（tokens），models.dev 未提供时为 undefined */
    contextWindow?: number
    /** 最大输出 tokens，models.dev 未提供时为 undefined */
    maxTokens?: number
}

/** 缓存条目：已拍平并过滤，仅保留填充所需字段 */
export interface CacheEntry {
    provider: string
    id: string
    /** 可选推理级别，'none' 表示可关闭推理；无可选档位时为空数组 */
    efforts: string[]
    /** 最大上下文窗口（tokens），仅当 models.dev 提供 */
    contextWindow?: number
    /** 最大输出 tokens，仅当 models.dev 提供 */
    maxTokens?: number
}

/** 拍平缓存：每条为 provider/id/efforts 及可选容量字段 */
export type Catalog = CacheEntry[]

/** 按 provider 分组的内存索引，供 lookup 复用 */
export interface ProviderGroup {
    ids: string[]
    entries: CacheEntry[]
}

/** 目录及其预构建的 provider 分组索引 */
export interface IndexedCatalog {
    catalog: Catalog
    groups: Map<string, ProviderGroup>
}

/** 按字段分别控制的规则开关 */
export interface FieldRules {
    /** 推理级别字段 */
    reasoning: boolean
    /** 上下文窗口与输出上限，二者一体受此开关控制 */
    context: boolean
}

/** bool 统一开关，对象按字段分别控制 */
export type FieldSwitch = boolean | FieldRules

/** 自有配置（model-reasoning 命名空间） */
export interface MyConfig {
    /** 开启后以 models.dev 最新数据为准更新已有配置 */
    allowUpdate: FieldSwitch
    /** 开启后自动填充缺失的推理级别/容量字段 */
    autoFill: FieldSwitch
}
