# dsh-model-reasoning

## 项目简介

DSH 插件：为所有非官方（自定义）提供商的模型自动填充推理级别（`reasoningEfforts`）、最大上下文（`contextWindow`）、输出上限（`maxTokens`）与图片模态（`input`），数据来自 models.dev。

## 技术栈

- 运行时：Node.js（ESM），基于 `@deepseek-ai/cordis` 的插件
- 构建：tsdown（rolldown）输出到 `lib/`
- 类型：TypeScript 严格模式，类型检查命令 `pnpm run typecheck`

## 目录结构

| 路径 | 说明 |
| --- | --- |
| `src/index.ts` | 插件本体（仅 `export` 与 `apply` 生命周期），其余逻辑拆分至下列模块 |
| `src/types.ts` | 共享类型定义与类型守卫（`isPlainObject`/`isCapacity`、LEGACY(v0)/历史版本(v1) 冻结类型、`PluginConfig`/快照等） |
| `src/constants.ts` | 命名空间（`API_NS`/`PLUGIN_NS`/`LEGACY_NS`）、配置版本与快照保留上限、重试参数、缓存路径、推理级别集合与提供商提示等常量 |
| `src/config.ts` | 当前配置 schema、默认值、版本快照段的 `resolveConfig` 与配置源读写 |
| `src/migrate.ts` | 配置版本迁移：LEGACY(v0)/历史版本(v1) 冻结 schema、链式升级台阶、启动就绪等待（`waitForSettingsReady`/`isNamespaceRegistered`）与 `migrateConfig` 编排 |
| `src/catalog.ts` | 目录数据：内存索引、缓存读取、models.dev 拉取与拍平 |
| `src/lookup.ts` | 模型 id 归一化/匹配与 `lookup`、`toReasoningEfforts` 转换 |
| `src/fix.ts` | 填充/修复流程：遍历模型生成变更并写回 settings |
| `src/refresh.ts` | 异步刷新编排：拉取最新数据、更新索引后触发填充（含失败重试） |
| `src/client/` | 浏览器半（web-ui，见「核心逻辑-浏览器半」）：`index.tsx` client 插件入口（词典/scope/槽注册）、`card.tsx` 设置卡片组件、`model.ts` 快照↔六布尔纯映射（单测对象）、`locales.ts` 中英词典 |
| `test/` | 纯函数测试（见「测试规范」），入口 `test/index.ts`，产物打包到 `.test-dist/`（gitignore） |
| `public/models-cache.json` | models.dev 处理后缓存（拍平数组），构建时复制到产物目录 |
| `lib/` | 构建产物（gitignore），含 `lib/index.js`（Node 半）、`lib/client.js`（浏览器半 lazy-CJS 工厂产物）与 `lib/public/models-cache.json` |
| `cordis.patch.yml` | DSH 补丁层对本插件的注册 |
| `tsdown.config.ts` | 构建配置（`outDir: lib`、`copy: public`） |

## 核心逻辑

- **自有配置（`tikaflow-model-fix` 命名空间，版本快照制）**：段为 `version-N` -> 配置快照的映射（dsh-settings 根写入要求纯对象，故不用列表）；`CONFIG_VERSION=2` 为当前代码版本，`MIN_SUPPORTED_VERSION=0`（旧 `model-reasoning` 命名空间的形态统一视为 v0），`MAX_OLD_SNAPSHOTS=3`；段 schema 为宽松 `z.dict(z.any())`（保证更新版本快照不阻塞注册），严格校验只针对当前版本快照值（`PluginConfigSchema`：`autoFill`/`allowUpdate` **仅对象写法** `{ reasoning, context, image }` 按字段控制，省略字段跟随整项默认 `autoFill`=`true`、`allowUpdate`=`false`；布尔写法是 v0 专属历史形态，仅由升级链展开为对象，当前 schema 不接受，杜绝语法二义性）；运行时 `resolveConfig` 优先当前版本快照，其次 ≤ 当前且 ≥ 最低支持的最高版本，均不可用回退默认
- **配置迁移（`migrateConfig`，首轮填充之前执行）**：有当前版本快照 → 直接使用，两阶段清理旧快照：先清理低于 `MIN_SUPPORTED_VERSION` 的快照（已失效、不读取不处理，提升最低支持时随之淘汰），再清理低于当前版本且超出 `MAX_OLD_SNAPSHOTS` 上限的 excess（从最低版本起淘汰；等于/高于当前版本的快照永不清理，高版本供新版插件回退后无损读取，检测到仅告警不读取）；v0 位于 LEGACY 旧命名空间、不在当前 NS 的 `version-N` 键内，故不参与上述清理（旧 NS 段一律保留不删除，便于回滚 0.5.x 插件）；无当前版本 → 迁移源依次取段内最低支持以上的最高旧快照、旧 NS 用户段（存在实际对象段），走升级链写入；全新用户直接写 `DEFAULT_STORED` 规范默认快照（不经升级链），保证启动后必有当前版本快照；写入用定向路径 op（`set ['version-N']`），不触碰用户手写键与高版本快照
- **升级链与历史形态隔离**：每个台阶 `upgradeNToN+1` 只做相邻一级升级、目标版本号固定字面量（不引用 `CONFIG_VERSION`），入口 `upgradeConfig` 指向最新台阶，`fromVersion` 低于台阶起点时递归前一级、否则跳过；新版本发布仅追加台阶函数；需固化的历史形态分两类，均不引用当前版本的可演进定义——一是 LEGACY（仅指 v0，旧 `model-reasoning` 命名空间，如 `LegacyConfig`），二是新命名空间（`tikaflow-model-fix`，0.6.0 起的版本快照体系）内的历史版本快照 schema（如 v1 的 `V1FieldRules`/`V1PluginConfigSnapshot`，它是快照体系的旧版本、不属 LEGACY）；某历史版本不再支持（提升 `MIN_SUPPORTED_VERSION`）时其冻结代码段与对应台阶整体移除（v0 还包括 `upgrade0To1` 与 index.ts 的旧 NS shim 注册）；`PluginConfig`（运行时配置）与 `PluginConfigSnapshot`（存储快照）独立定义、无继承拼接
- 数据加载（`readCache` / `fetchLatest`）：缓存为 models.dev 处理后拍平数组（每条 provider/id/efforts/contextWindow/maxTokens/image，仅当具备【有效推理级别、contextWindow、maxTokens、支持图片】任一信息时入库；容量提取经 `isCapacity`——非正整数与 `CAPACITY_UNLIMITED=99999999`（models.dev 对"无限/未公布"的哨兵建模，另含媒体模型的 0）视为无该字段；`image` 只缓存正向信息——支持图片才写 `true`，纯文本模型省略该字段以控制体积）；`readCache`（异步读取）校验解析结果为非空数组即构建分组索引（旧格式或坏数据一律失效，交由网络拉取自愈；旧缓存缺 `image` 字段视为无数据，不填图片、刷新后自愈）；缓存可用则立即用缓存填充，再异步拉取 models.dev 原始 JSON（解析拍平后仅当数据非空才替换内存索引并覆盖缓存，内容无变化则跳过写入；拉取失败以固定 5s 间隔重试最多 3 次，仍失败仅记录日志、继续使用现有目录；覆盖缓存的写入失败同样以固定 5s 间隔重试最多 3 次，仍失败仅记录日志，不影响本次运行）；缓存不可用（理论上不会发生，构建已保留缓存）则直接拉取最新数据填充并更新缓存；目录以内存常驻形式供每次填充复用，首次由缓存或网络初始化，此后仅被异步刷新结果整体替换
- 填充流程（`fix`）：读取 settings 命名空间 `llm-pi-ai` 的 `providers[*].models` 及描述符 revision，对缺少 `reasoningEfforts` / `contextWindow` / `maxTokens` / `input` 的模型查找目录（`lookup` 优先按 provider+modelId 匹配，失败再仅按 modelId 全局匹配），生成推理级别、容量值或图片模态（缓存 `image` 为 true 时填 `["text","image"]`；纯文本或无数据不填，harness 未声明本就按纯文本处理）并按 provider 整段写回 `providers[providerId].models` 数组（其余模型字段原样保留；路径 op 不支持数组下标中间段）；填充缺失字段受 `autoFill` 对应字段控制，覆盖更新仅当 `allowUpdate` 对应字段开启且新值合法（`efforts` 经 `isPlainObject` 校验、容量经 `isCapacity`、模态由 `toInputValue` 生成），新旧值相同则跳过；写回携带 revision 做并发冲突校验，冲突时重读重算（限次）
- **浏览器半（web-ui 设置卡片，`src/client/`）**：同一 npm 包同时携带 Node 半（`src/`）与浏览器半，由 package.json 的 `exports["./client"]` → `lib/client.js` 与 `dsh.client: { platform: "web", inject: [...] }` 声明（此处 `inject` 是**依赖包图边**、填槽位所有者包 `@deepseek-ai/dsh-client-ui-settings-models`，非 cordis 服务名；服务名只写在 `src/client/index.tsx` 的 `export const inject`）。宿主 client-modules 扫描已挂载的 Loader 条目并经 `/plugins` combo 路由下发，**插件被挂载即出现在页面，无需重建 web 应用**（参照 harness `docs/cookbook/adding-a-settings-card.md`）。产物必须复刻 harness `packages/client/tsdown.client.ts` `clientConfig()` 的闭包工厂契约（`window.__ModuleLoader__.load({ id: 包名, factory })`，banner/intro/footer 三段，见 `tsdown.config.ts`）：externals 仅宿主模块表基线 8 项（react、react/jsx-runtime、react-dom、react-dom/client、cordis、dsh-client-store、dsh-client-ui-slots、dsh-client-ui-primitives，宿主权威列表在 `packages/client/web/src/platform.ts`），其余一律 inline；跨插件值导入被禁（type-only 会被擦除，不受限），本项目在 `tsdown.config.ts` 自建 purity 门禁自守。声明 `dsh.client` 后 `lib/client.js` 缺失会导致宿主激活期聚合抛错，**build 必须先于安装/link**
- **宿主版本兼容（对外纪律）**：一切前端可用面以 **npm 发布版**为准（`npm view @deepseek-ai/dsh dist-tags`），`.tmp-harness` 只是源码参照、HEAD 可能领先一切已发布版本。已实证事实：`settings.models.footer` 槽仅 **0.1.2-alpha.2+** 发布包中存在，npm `latest`（0.1.1-rc.2）**没有**该槽——在其上 `slots.inject` 会无限等待、静默无卡片无报错。参考实测可用实现见 `.tmp-slider`（dsh-reasoning-slider，兼容 rc.2）。本插件按**向前兼容**原则：web-ui 仅支持 ≥ 0.1.2-alpha.2（`peerDependencies` 声明），不为旧宿主做降级
- **卡片内嵌位置与注册**：注册 `ctx.slots.inject('settings.models.footer', () => ctx.slots.register({ name, id: 'tikaflow-model-fix', order: 100, locale: CARD_NS }, 组件))`——footer 是宿主 `ModelsSection` 为仓库外插件预留的 list 席位（「模型」选项卡底部、provider 行与添加控件之后；选项卡头部任何版本都无席位），list 槽 id 取本插件新配置命名空间（而非包名/旧 NS）。**最低宿主 0.1.2-alpha.2**（footer 槽自该版发布包起存在，已对 rc.2/alpha.2/3/4 逐一验证），由 package.json 的 `peerDependencies` 声明下限；更旧宿主上 `slots.inject` 会无限等待（静默无卡片），不做兼容降级（向前看原则）。词典 `ctx.locale.register` 重复注册会抛错，须经 `ctx.effect` 挂 disposer 保 HMR；组件 `t` 由 register 的 `locale:` 席位合成注入。开关为自绘（宿主无现成 Switch），样式经模块级幂等 `<style>`（`data-plugin` 标记供宿主 HMR 认领），类名 `dsh-mr-` 前缀，颜色走 `--dsw-alias-*` 令牌 + `body[data-ds-dark-theme]` 规则镜像适配深浅色（暗色下开关圆点整体黑色系、关/开用不同深度）；client 模块须 `export const name`（与包名一致）
- **卡片读写（后端零改动）**：`ctx.settingsScope.bind({ namespace, decode })` 得到响应式 scope（revision 并发围栏）；**必须自带 decode 且永不返回 undefined**（缺省路径走宿主 schema rehydrate，宽松 dict 失败会使 status 永挂 loading），解码语义镜像 `resolveConfig`（v2 优先→旧快照→默认，纯函数在 `src/client/model.ts` 并有单测）；六布尔草稿仅暂存本地（draft 初值 null 跟随已存值，关页面即丢弃），点「应用」`scope.set('version-2', 规范快照)` 单字段原子写（`configVersion` + 六布尔全显式，不触碰段内其他键），写入触发宿主 `onChange` → `fix`；表头两格为纵向总控（不落存储）：列内任一为开则显示开，点击把该列三格全置为取反值。**浏览器半不得值导入 Node 半模块**（`src/constants.ts` 会拖入 `node:path`）：NS 与版本号在 `src/client/model.ts` 以字面量维护，与 `src/constants.ts` 同步修改
- 生命周期（`apply`）：`inject: ['settings']` 保证服务已就绪；注册 `PLUGIN_NS`（快照容器 + `resolveConfig` 源）与 `LEGACY_NS` 只读 shim（冻结 v0 schema）；`settings/updated` 事件监听 `API_NS` 变更后再次填充；首轮由 effect 统一编排：等待 `PLUGIN_NS` 注册完成（`waitForSettingsReady`）→ 配置迁移 → 缓存读取 → 填充 → 异步刷新。关键时序：`installSettingsSection` 经 `ctx.inject` 子 fiber 注册，注册回调（含 `register`、以及注册冲突/存储段非法的抛错）都被推迟到微任务，而 apply 内的 effect 体同步执行、`describe()` 此刻读空——故迁移前必须先有界等待注册完成（否则旧配置读不到且 `version-N` 快照不写入；`waitForSettingsReady` 用 `setTimeout(0)` 让出宏任务排空微任务，超 `REGISTER_WAIT_MAX` 次未就绪则跳过迁移）；LEGACY 的注册结果同样只能在就绪后观察：用 `isNamespaceRegistered(ctx, LEGACY_NS)` 检测，缺席即注册失败（被占用或段非法），迁移按无旧配置处理并告警；迁移必先于填充，否则旧格式会被按新 schema 误解析；卸载时置位，在途结果不触碰已卸载的上下文；迁移失败仅告警、按当前生效配置继续

## 配置说明

- 自有配置命名空间为 `tikaflow-model-fix`（由本插件通过 `installSettingsSection` 注册），配置写在版本快照键下且仅用对象写法，如 `tikaflow-model-fix: { version-2: { autoFill: { reasoning: true, context: false, image: true } } }`；插件首次启动（或版本升级）时自动写入当前版本快照（无旧配置时为默认值）
- 配置亦可经 Web 设置界面的可视化卡片修改（见「核心逻辑-浏览器半」，要求宿主 ≥ 0.1.2-alpha.2）：卡片内嵌于「模型」选项卡底部；卡片点「应用」写入的即上述对象写法的当前版本快照，两种途径行为一致
- 旧命名空间 `model-reasoning` 仅在配置迁移时读取（v0 形态，冻结 schema）；迁移后该段保留在文件中，仅供回滚旧版插件（≤ 0.5.x）读取，本插件除迁移外不读取它
- settings 命名空间为 `llm-pi-ai`（由 harness 的 llm-pi-ai 插件注册），模型列表即该命名空间下的 `providers` 配置
- 推理级别取值与 harness 的 `ModelThinkingLevel` 一致：`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`
- 图片模态写回字段为 `input`，取值仅 `text` / `image`（harness `MODALITIES` 限定）；空数组或未声明均视为未声明（继承 route 默认、按纯文本处理），数据源中的 `pdf`/`video`/`audio` 等值忽略不写；本插件仅为支持图片的模型填 `["text","image"]`，纯文本模型不写（不缓存 false）

## 开发命令

- `pnpm build`：构建到 `lib/`（`tsdown.config.ts` 数组双配置：Node 半 `lib/index.js` + 浏览器半 `lib/client.js`，clean 由 Node 半配置承担）
- `pnpm run typecheck`：tsc 类型检查（含 `test/` 与 `src/client/`；浏览器半类型依赖 `@deepseek-ai/dsh-client-*` devDeps，版本须与宿主 harness 对齐）
- `pnpm test`：执行纯函数测试（tsdown 打包 `test/index.ts` 到 `.test-dist/` 后由 node 运行，失败时非零退出码）；**必须 `--no-config`**——否则 CLI 参数会合并进数组的每个配置，client 的工厂 banner 污染测试产物（无配置时产物扩展名为 `.mjs`）
- `pnpm install`：安装依赖（`prepare` 钩子自动执行 `pnpm build`，故 `lib/` 在安装后即存在；声明了 `dsh.client` 后 **build 必须先于 link/安装到宿主**，否则宿主激活期因缺 `lib/client.js` 聚合抛错）

## 测试规范

- `test/` 仅收录**不依赖 DSH 运行时的纯函数**测试；当前范围为配置版本迁移与解析（`src/config.ts`、`src/migrate.ts` 的纯函数部分）、目录拍平剪裁（`src/catalog.ts` 的 `buildCatalog`）与浏览器半纯映射层（`src/client/model.ts`，零外部值依赖故可直接单测）；涉及时序或框架的编排逻辑（`migrateConfig`、`fix`、`readCache`/`fetchLatest`、`refresh`、浏览器半 `apply`/组件）不进 `test/`，开发时可用 stub ctx 临时脚本验证，验证后删除
- 文件组织：按被测模块命名 `test/<module>.test.ts`，导出 `run()` 执行本文件全部用例，并在 `test/index.ts` 中注册调用；断言与汇总使用 `test/helper.ts`（`check` 记录结果、`stable` 键序无关序列化比较、`summary` 汇总并设置退出码）
- 新增或修改纯函数时必须同步补充/更新用例并执行 `pnpm test` 通过；测试断言优先覆盖边界与兼容性语义（非法输入兜底、幂等、版本回退等），不追求逐行覆盖
