/**
 * 卡片文案词典（浏览器半）。CARD_NS 并入 ui-slots 的 LocaleNamespaceMap 类型表，
 * 注册 slot 时声明 `locale: CARD_NS`，组件即可得到类型化的 `t`。
 */

import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** 卡片词典命名空间 */
export const CARD_NS = 'settings.modelReasoning'

/** 卡片文案键集合 */
export type CardKey =
    | 'title'
    | 'colModelParams'
    | 'colAutoFill'
    | 'colAllowUpdate'
    | 'rowReasoning'
    | 'rowContext'
    | 'rowImage'
    | 'apply'
    | 'saving'
    | 'loading'
    | 'unavailable'
    | 'readOnly'
    | 'switchAria'

declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        'settings.modelReasoning': CardKey
    }
}

/** 行/列键的展示文案映射（组件按 FIELD_KEYS / 列枚举取键） */
export const ROW_KEYS: Record<'reasoning' | 'context' | 'image', CardKey> = {
    reasoning: 'rowReasoning',
    context: 'rowContext',
    image: 'rowImage',
}

/** 列名键映射 */
export const COLUMN_KEYS: Record<'autoFill' | 'allowUpdate', CardKey> = {
    autoFill: 'colAutoFill',
    allowUpdate: 'colAllowUpdate',
}

export const zh: Record<CardKey, string> = {
    title: '模型参数填充',
    colModelParams: '模型参数',
    colAutoFill: '自动填充',
    colAllowUpdate: '允许更新',
    rowReasoning: '推理级别',
    rowContext: '上下文与输出',
    rowImage: '图片输入',
    apply: '应用',
    saving: '保存中…',
    loading: '正在读取配置…',
    unavailable: '配置不可用（未检测到插件的宿主服务）',
    readOnly: '当前环境为只读，无法保存',
    switchAria: '{row}：{column}',
}

export const en: Record<CardKey, string> = {
    title: 'Model field auto-fill',
    colModelParams: 'Model parameter',
    colAutoFill: 'Auto fill',
    colAllowUpdate: 'Allow update',
    rowReasoning: 'Reasoning efforts',
    rowContext: 'Context & output',
    rowImage: 'Image input',
    apply: 'Apply',
    saving: 'Saving…',
    loading: 'Loading settings…',
    unavailable: 'Settings unavailable (host plugin service not found)',
    readOnly: 'Read-only environment; cannot save',
    switchAria: '{row}: {column}',
}
