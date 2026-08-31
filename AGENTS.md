# dsh-model-reasoning

## 项目简介

DSH 插件：为所有非官方（自定义）提供商的模型自动填充推理级别（`reasoningEfforts`）、最大上下文（`contextWindow`）与输出上限（`maxTokens`），数据来自 models.dev。

## 技术栈

- 运行时：Node.js（ESM），基于 `@deepseek-ai/cordis` 的插件
- 构建：tsdown（rolldown）输出到 `lib/`
- 类型：TypeScript 严格模式，类型检查命令 `pnpm run typecheck`

## 目录结构

| 路径 | 说明 |
| --- | --- |
| `src/index.ts` | 插件本体（仅 `export` 与 `apply` 生命周期），其余逻辑拆分至下列模块 |
| `src/types.ts` | 共享类型定义与类型守卫（`isPlainObject`、LEGACY 冻结类型、`PluginConfig`/快照等） |
| `src/constants.ts` | 命名空间（`API_NS`/`PLUGIN_NS`/`LEGACY_NS`）、配置版本与快照保留上限、重试参数、缓存路径、推理级别集合与提供商提示等常量 |
| `src/config.ts` | 当前配置 schema、默认值、版本快照段的 `resolveConfig` 与配置源读写 |
| `src/migrate.ts` | 配置版本迁移：LEGACY（v0）冻结 schema、链式升级台阶、`migrateConfig` 启动编排 |
| `src/catalog.ts` | 目录数据：内存索引、缓存读取、models.dev 拉取与拍平 |
| `src/lookup.ts` | 模型 id 归一化/匹配与 `lookup`、`toReasoningEfforts` 转换 |
| `src/fix.ts` | 填充/修复流程：遍历模型生成变更并写回 settings |
| `src/refresh.ts` | 异步刷新编排：拉取最新数据、更新索引后触发填充（含失败重试） |
| `test/` | 纯函数测试（见「测试规范」），入口 `test/index.ts`，产物打包到 `.test-dist/`（gitignore） |
| `public/models-cache.json` | models.dev 处理后缓存（拍平数组），构建时复制到产物目录 |
| `lib/` | 构建产物（gitignore），含 `lib/index.js` 与 `lib/public/models-cache.json` |
| `cordis.patch.yml` | DSH 补丁层对本插件的注册 |
| `tsdown.config.ts` | 构建配置（`outDir: lib`、`copy: public`） |

## 核心逻辑

- **自有配置（`tikaflow-model-fix` 命名空间，版本快照制）**：段为 `version-N` -> 配置快照的映射（dsh-settings 根写入要求纯对象，故不用列表）；`CONFIG_VERSION=1` 为当前代码版本，`MIN_SUPPORTED_VERSION=0`（旧 `model-reasoning` 命名空间的形态统一视为 v0），`MAX_OLD_SNAPSHOTS=3`；段 schema 为宽松 `z.dict(z.any())`（保证更新版本快照不阻塞注册），严格校验只针对当前版本快照值（`PluginConfigSchema`：`autoFill`/`allowUpdate` **仅对象写法** `{ reasoning, context }` 按字段控制，省略字段跟随整项默认 `autoFill`=`true`、`allowUpdate`=`false`；布尔写法是 v0 专属历史形态，仅由升级链展开为对象，当前 schema 不再接受，杜绝语法二义性）；运行时 `resolveConfig` 优先当前版本快照，其次 ≤ 当前且 ≥ 最低支持的最高版本，均不可用回退默认
- **配置迁移（`migrateConfig`，首轮填充之前执行）**：有当前版本快照 → 直接使用，仅清理低于当前版本且超出上限的最旧快照（等于/高于当前版本的快照永不清理，高版本供新版插件回退后无损读取，检测到仅告警不读取）；无当前版本 → 迁移源依次取段内最低支持以上的最高旧快照、旧 NS 用户段（存在实际对象段），走升级链写入；全新用户直接写 `DEFAULT_STORED` 规范默认快照（不经升级链），保证启动后必有当前版本快照；写入用定向路径 op（`set ['version-N']`），不触碰用户手写键与高版本快照；旧 NS 段一律保留不删除（便于回滚 0.5.x 插件）
- **升级链与 LEGACY 隔离**：每个台阶 `upgradeNToN+1` 只做相邻一级升级、目标版本号固定字面量（不引用 `CONFIG_VERSION`），入口 `upgradeConfig` 指向最新台阶，`fromVersion` 低于台阶起点时递归前一级、否则跳过；新版本发布仅追加台阶函数；LEGACY 类型（`LegacyConfig` 等）与 `LegacyConfigSchema` 冻结于 0.5.6 形态、不引用当前版本的可演进定义，不再支持 v0（提升 `MIN_SUPPORTED_VERSION`）时 LEGACY 代码段、`upgrade0To1` 与 index.ts 的旧 NS shim 注册整体移除；`PluginConfig`（运行时配置）与 `PluginConfigSnapshot`（存储快照）独立定义、无继承拼接
- 数据加载（`readCache` / `fetchLatest`）：缓存为 models.dev 处理后拍平数组（每条 provider/id/efforts/contextWindow/maxTokens，全量模型入库，仅当无推理级别且无容量字段时剪裁）；`readCache`（异步读取）校验解析结果为非空数组即构建分组索引（旧格式或坏数据一律失效，交由网络拉取自愈）；缓存可用则立即用缓存填充，再异步拉取 models.dev 原始 JSON（解析拍平后仅当数据非空才替换内存索引并覆盖缓存，内容无变化则跳过写入；拉取失败以固定 5s 间隔重试最多 3 次，仍失败仅记录日志、继续使用现有目录；覆盖缓存的写入失败同样以固定 5s 间隔重试最多 3 次，仍失败仅记录日志，不影响本次运行）；缓存不可用（理论上不会发生，构建已保留缓存）则直接拉取最新数据填充并更新缓存；目录以内存常驻形式供每次填充复用，首次由缓存或网络初始化，此后仅被异步刷新结果整体替换
- 填充流程（`fix`）：读取 settings 命名空间 `llm-pi-ai` 的 `providers[*].models` 及描述符 revision，对缺少 `reasoningEfforts` / `contextWindow` / `maxTokens` 的模型查找目录（`lookup` 优先按 provider+modelId 匹配，失败再仅按 modelId 全局匹配），生成推理级别或容量值并按 provider 整段写回 `providers[providerId].models` 数组（其余模型字段原样保留；路径 op 不支持数组下标中间段）；填充缺失字段受 `autoFill` 对应字段控制，覆盖更新仅当 `allowUpdate` 对应字段开启且新值合法（`efforts` 经 `isPlainObject` 校验、容量为数字），新旧值相同则跳过；写回携带 revision 做并发冲突校验，冲突时重读重算（限次）
- 生命周期（`apply`）：`inject: ['settings']` 保证服务已就绪；注册 `PLUGIN_NS`（快照容器 + `resolveConfig` 源）与 `LEGACY_NS` 只读 shim（冻结 v0 schema，注册冲突/失败 try/catch 降级为无旧配置，不阻塞启动）；`settings/updated` 事件监听 `API_NS` 变更后再次填充；首轮由 effect 统一编排：配置迁移 → 缓存读取 → 填充 → 异步刷新（迁移必先于填充，否则旧格式会被按新 schema 误解析；卸载时置位，在途结果不再触碰已卸载的上下文；迁移失败仅告警、按当前生效配置继续）

## 配置说明

- 自有配置命名空间为 `tikaflow-model-fix`（由本插件通过 `installSettingsSection` 注册），配置写在版本快照键下且仅用对象写法，如 `tikaflow-model-fix: { version-1: { autoFill: { reasoning: true, context: false } } }`；插件首次启动（或版本升级）时自动写入当前版本快照（无旧配置时为默认值）
- 旧命名空间 `model-reasoning` 仅在配置迁移时读取（v0 形态，冻结 schema），迁移后保留在文件中不再读取；旧版插件（≤ 0.5.x）回滚后仍可读取该段
- settings 命名空间为 `llm-pi-ai`（由 harness 的 llm-pi-ai 插件注册），模型列表即该命名空间下的 `providers` 配置
- 推理级别取值与 harness 的 `ModelThinkingLevel` 一致：`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`

## 开发命令

- `pnpm build`：构建到 `lib/`
- `pnpm run typecheck`：tsc 类型检查（含 `test/`）
- `pnpm test`：执行纯函数测试（tsdown 打包 `test/index.ts` 到 `.test-dist/` 后由 node 运行，失败时非零退出码）
- `pnpm install`：安装依赖（`prepare` 钩子自动执行 `pnpm build`，故 `lib/` 在安装后即存在）

## 测试规范

- `test/` 仅收录**不依赖 DSH 运行时的纯函数**测试；当前范围为配置版本迁移与解析（`src/config.ts`、`src/migrate.ts` 的纯函数部分）；涉及时序或框架的编排逻辑（`migrateConfig`、`fix`、`readCache`/`fetchLatest`、`refresh`）不进 `test/`，开发时可用 stub ctx 临时脚本验证，验证后删除
- 文件组织：按被测模块命名 `test/<module>.test.ts`，导出 `run()` 执行本文件全部用例，并在 `test/index.ts` 中注册调用；断言与汇总使用 `test/helper.ts`（`check` 记录结果、`stable` 键序无关序列化比较、`summary` 汇总并设置退出码）
- 新增或修改纯函数时必须同步补充/更新用例并执行 `pnpm test` 通过；测试断言优先覆盖边界与兼容性语义（非法输入兜底、幂等、版本回退等），不追求逐行覆盖
