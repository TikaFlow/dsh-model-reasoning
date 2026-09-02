/**
 * 模型参数填充卡片（浏览器半）：4 行表格（表头为纵向总控，不落存储）+ 强制更新/应用按钮。
 * 本地暂存（draft）：单格/总控点击只改草稿，点「应用」才经 settingsScope 原子写 version-2；
 * 关闭页面即丢弃。每次挂载从宿主快照重新读取（draft 初值为 null 即跟随已存配置）。
 * 「强制更新」（危险按钮，贴最左）经 Connection RPC 请求 Node 半单次 force 填充，
 * 结果（变更数/失败原因）显示在 footer 下方提示行，执行前 confirm 二次确认。
 */

import { useState, useSyncExternalStore } from 'react'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { RpcResult } from '../types'
import {
    DEFAULT_FLAGS,
    FIELD_KEYS,
    VERSION_KEY,
    applyColumn,
    isDirty,
    masterValue,
    snapshotFromFlags,
    toggleCell,
} from './model'
import type { Column, Flags } from './model'
import { COLUMN_KEYS, ROW_KEYS } from './locales'

/** 卡片组件 props（t 由 slots.register 的 locale 席位合成注入；scope/forceUpdate 由入口闭包传入） */
export interface CardProps {
    t: TranslateNS<'settings.modelReasoning'>
    scope: SettingsScope<Flags>
    /** 强制更新 RPC：channel 与端点在入口拼好，卡片只消费结果 */
    forceUpdate: () => Promise<RpcResult<unknown>>
}

const STYLE_ID = 'dsh-model-reasoning-card-css'

/** 内嵌样式表（类名 dsh-mr- 前缀防撞；颜色全部走 --dsw-alias-* 令牌带字面兜底，深浅色由宿主令牌自动切换） */
const STYLE_TEXT = [
    '.dsh-mr-card{display:flex;flex-direction:column;gap:12px;max-width:720px;padding:16px;border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08))}',
    '.dsh-mr-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,#1a1a1a)}',
    '.dsh-mr-grid{display:flex;flex-direction:column}',
    '.dsh-mr-row{display:grid;grid-template-columns:minmax(0,1fr) 140px 140px;align-items:center;gap:8px;padding:8px 0;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08))}',
    '.dsh-mr-head{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#666)}',
    '.dsh-mr-label{font-size:13px;color:var(--dsw-alias-label-primary,#1a1a1a)}',
    '.dsh-mr-colCell{display:flex;align-items:center;gap:8px}',
    '.dsh-mr-cellWrap{display:flex;align-items:center}',
    '.dsh-mr-switch{position:relative;flex:none;width:36px;height:20px;padding:0;border:none;border-radius:10px;cursor:pointer;background:var(--dsw-alias-border-l4,rgba(0,0,0,.16));transition:background .15s ease}',
    '.dsh-mr-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary,#2f6bff)}',
    '.dsh-mr-switch:disabled{opacity:.5;cursor:default}',
    '.dsh-mr-thumb{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground,#fff);transition:transform .15s ease}',
    '.dsh-mr-switch[aria-checked="true"] .dsh-mr-thumb{transform:translateX(16px)}',
    '.dsh-mr-footer{display:flex;align-items:center;justify-content:space-between;gap:8px}',
    '.dsh-mr-actions{display:flex;align-items:center;gap:8px}',
    '.dsh-mr-hint{font-size:12px;color:var(--dsw-alias-label-tertiary,#999)}',
    '.dsh-mr-apply{font-size:13px;padding:6px 16px;border:none;border-radius:8px;cursor:pointer;color:var(--dsw-alias-label-primary-foreground,#fff);background:var(--dsw-alias-button-primary-fill,#1a1a1a)}',
    '.dsh-mr-apply:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#333)}',
    '.dsh-mr-apply:disabled{opacity:.45;cursor:default}',
    // 危险操作按钮：红底白字（state-error-primary 令牌随宿主深浅色自适应），与常规按钮同款尺寸
    '.dsh-mr-force{font-size:13px;padding:6px 16px;border:none;border-radius:8px;cursor:pointer;color:var(--dsw-alias-label-primary-foreground,#fff);background:var(--dsw-alias-state-error-primary,#d92d24)}',
    '.dsh-mr-force:hover:not(:disabled){filter:brightness(.9)}',
    '.dsh-mr-force:disabled{opacity:.45;cursor:default}',
].join('\n')

/** 幂等注入样式（模块级守护，重复挂载不重复插入） */
let stylesInjected = false
function ensureStyles(): void {
    if (stylesInjected || typeof document === 'undefined') return
    if (document.getElementById(STYLE_ID) !== null) {
        stylesInjected = true
        return
    }
    const tag = document.createElement('style')
    tag.id = STYLE_ID
    tag.dataset.plugin = 'dsh-model-reasoning'
    tag.textContent = STYLE_TEXT
    document.head.appendChild(tag)
    stylesInjected = true
}

/** 失败信息截断（提示行为小字，防长消息撑爆卡片） */
function truncateMessage(value: string): string {
    return value.length > 120 ? `${value.slice(0, 119)}…` : value
}

/** 自绘开关（全仓范式：button role=switch + aria-checked，无现成组件可复用） */
function Switch(props: { checked: boolean; disabled: boolean; aria: string; onChange: () => void }) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={props.checked}
            aria-label={props.aria}
            disabled={props.disabled}
            className="dsh-mr-switch"
            onClick={props.onChange}
        >
            <span className="dsh-mr-thumb" />
        </button>
    )
}

/** 卡片主体 */
export function Card(props: CardProps) {
    ensureStyles()
    const scope = props.scope
    const { t } = props
    // scope 的方法是类实例方法，须经箭头函数保 this 绑定后交给 uSES
    const snap = useSyncExternalStore(
        (listener) => scope.subscribe(listener),
        () => scope.getSnapshot(),
    )
    // draft === null 表示未编辑、跟随已存值；首次点击即冻结当前显示值为草稿
    const [draft, setDraft] = useState<Flags | null>(null)
    const [submitting, setSubmitting] = useState(false)
    // 强制更新执行态与结果提示（常驻至下次点击，null 不渲染）
    const [forceBusy, setForceBusy] = useState(false)
    const [forceResult, setForceResult] = useState<string | null>(null)

    if (snap.status === 'unavailable') {
        return (
            <div className="dsh-mr-card">
                <div className="dsh-mr-title">{t('title')}</div>
                <div className="dsh-mr-hint">{t('unavailable')}</div>
            </div>
        )
    }

    const saved = snap.value
    const shown = draft ?? saved ?? DEFAULT_FLAGS
    const ready = snap.status === 'ready' && saved !== undefined
    const canWrite = ready && snap.writable === true
    const dirty = draft !== null && saved !== undefined && isDirty(draft, saved)

    const cellAria = (column: Column, row: (typeof FIELD_KEYS)[number]) =>
        `${t(ROW_KEYS[row])} ${t(COLUMN_KEYS[column])}`

    const onCell = (column: Column, key: (typeof FIELD_KEYS)[number]) => {
        setDraft(toggleCell(shown, column, key))
    }
    // 纵向总控：任一为开则显示开；点击取反并把该列三格全部设为同一值
    const onMaster = (column: Column) => {
        setDraft(applyColumn(shown, column, !masterValue(shown, column)))
    }
    const onApply = () => {
        if (!canWrite || !dirty || submitting) return
        setSubmitting(true)
        // 写入成功由宿主回推新 value（dirty 自动归 false）；失败时 scope 内部已重读恢复，
        // 此处仅复位提交态，错误日志交由宿主 settingsScope 通道
        void scope.set(VERSION_KEY, snapshotFromFlags(shown))
            .catch(() => {
                /* 恢复读由 scope 负责，失败保持 dirty 态可重试 */
            })
            .finally(() => {
                setSubmitting(false)
            })
    }
    // 危险操作：confirm 二次确认后经 RPC 触发 Node 半单次 force 填充；
    // 不依赖 canWrite/dirty（不改配置本身，只按目录覆盖写回模型字段）
    const onForce = () => {
        if (!ready || forceBusy || submitting) return
        if (!window.confirm(t('forceConfirm'))) return
        setForceBusy(true)
        setForceResult(null)
        props.forceUpdate()
            .then((result) => {
                if (result.ok) {
                    const changed = (result.value as { changed?: number } | undefined)?.changed ?? 0
                    setForceResult(changed > 0 ? t('forceDone', { count: changed }) : t('forceNone'))
                } else {
                    setForceResult(t('forceFailed', { message: truncateMessage(result.error.message) }))
                }
            })
            .catch((error: unknown) => {
                // 传输层失败（HTTP 非 2xx 等）call 直接 reject，与 ok:false 同一路径展示
                setForceResult(t('forceFailed', { message: truncateMessage(error instanceof Error ? error.message : String(error)) }))
            })
            .finally(() => {
                setForceBusy(false)
            })
    }

    return (
        <div className="dsh-mr-card">
            <div className="dsh-mr-title">{t('title')}</div>
            {!ready ? <div className="dsh-mr-hint">{t('loading')}</div> : null}
            <div className="dsh-mr-grid">
                <div className="dsh-mr-row dsh-mr-head">
                    <span className="dsh-mr-label">{t('colModelParams')}</span>
                    <span className="dsh-mr-colCell">
                        {/* 开关在前、标题随后（全选式阅读顺序）：与数据行开关左缘对齐且不误配到相邻列 */}
                        <Switch
                            checked={masterValue(shown, 'autoFill')}
                            disabled={!canWrite}
                            aria={`${t('colAutoFill')} (${t('colModelParams')})`}
                            onChange={() => { onMaster('autoFill') }}
                        />
                        {t('colAutoFill')}
                    </span>
                    <span className="dsh-mr-colCell">
                        <Switch
                            checked={masterValue(shown, 'allowUpdate')}
                            disabled={!canWrite}
                            aria={`${t('colAllowUpdate')} (${t('colModelParams')})`}
                            onChange={() => { onMaster('allowUpdate') }}
                        />
                        {t('colAllowUpdate')}
                    </span>
                </div>
                {FIELD_KEYS.map((key) => (
                    <div key={key} className="dsh-mr-row">
                        <span className="dsh-mr-label">{t(ROW_KEYS[key])}</span>
                        <span className="dsh-mr-cellWrap">
                            <Switch
                                checked={shown.autoFill[key]}
                                disabled={!canWrite}
                                aria={cellAria('autoFill', key)}
                                onChange={() => { onCell('autoFill', key) }}
                            />
                        </span>
                        <span className="dsh-mr-cellWrap">
                            <Switch
                                checked={shown.allowUpdate[key]}
                                disabled={!canWrite}
                                aria={cellAria('allowUpdate', key)}
                                onChange={() => { onCell('allowUpdate', key) }}
                            />
                        </span>
                    </div>
                ))}
            </div>
            <div className="dsh-mr-footer">
                <button
                    type="button"
                    className="dsh-mr-force"
                    disabled={!ready || forceBusy || submitting}
                    onClick={onForce}
                >
                    {forceBusy ? t('forceBusy') : t('force')}
                </button>
                <span className="dsh-mr-actions">
                    {ready && !snap.writable ? <span className="dsh-mr-hint">{t('readOnly')}</span> : null}
                    <button
                        type="button"
                        className="dsh-mr-apply"
                        disabled={!canWrite || !dirty || submitting || forceBusy}
                        onClick={onApply}
                    >
                        {submitting ? t('saving') : t('apply')}
                    </button>
                </span>
            </div>
            {forceResult !== null ? <div className="dsh-mr-hint">{forceResult}</div> : null}
        </div>
    )
}
