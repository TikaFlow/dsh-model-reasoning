/** 纯函数测试的轻量断言辅助：累计结果、稳定序列化、汇总并设置退出码 */

let passed = 0
let failed = 0

/** 断言一条用例，输出 PASS/FAIL */
export function check(name: string, ok: boolean, detail?: unknown): void {
    if (ok) {
        passed++
        console.log(`PASS ${name}`)
    } else {
        failed++
        console.log(`FAIL ${name} -> ${JSON.stringify(detail)}`)
    }
}

/** 键序无关的稳定 JSON 序列化，供深度比较断言 */
export function stable(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
    if (value && typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : 1)
        return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`
    }
    return JSON.stringify(value)
}

/** 汇总输出；存在失败时以非零码退出 */
export function summary(): void {
    console.log(failed === 0 ? `ALL PASS (${passed})` : `${failed}/${passed + failed} FAILED`)
    if (failed > 0) process.exitCode = 1
}
