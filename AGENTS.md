# dsh-model-reasoning

## 项目简介

DSH 插件：为所有非官方（自定义）提供商的模型自动填充推理级别（`reasoningEfforts`），推理级别数据来自 models.dev。

## 技术栈

- 运行时：Node.js（ESM），基于 `@deepseek-ai/cordis` 的插件
- 构建：tsdown（rolldown）输出到 `lib/`
- 类型：TypeScript 严格模式，类型检查命令 `pnpm run typecheck`

## 目录结构

| 路径 | 说明 |
| --- | --- |
| `src/index.ts` | 插件唯一源码入口，全部逻辑集中于此 |
| `public/models-cache.json` | models.dev 处理后缓存（拍平数组），构建时复制到产物目录 |
| `lib/` | 构建产物（gitignore），含 `lib/index.js` 与 `lib/public/models-cache.json` |
| `cordis.patch.yml` | DSH 补丁层对本插件的注册 |
| `tsdown.config.ts` | 构建配置（`outDir: lib`、`copy: public`） |

## 核心逻辑

- **自有配置（`model-reasoning` 命名空间）**：通过 `installSettingsSection` 注册到 settings，可在 `settings.yaml` 中编辑或将来通过 Web 设置页开关控制；当前配置项 `allowUpdate: boolean`（默认 `false`），开启后以 models.dev 最新数据为准更新已有推理级别档位
- 数据加载（`readCache` / `fetchLatest`）：缓存为 models.dev 处理后拍平数组（每条 provider/id/efforts，已过滤非推理模型与无可用级别的模型，efforts 含 `none` 表示可关闭推理）；`readCache`（异步读取）校验解析结果为非空数组即构建分组索引（旧格式或坏数据一律失效，交由网络拉取自愈）；缓存可用则立即用缓存填充，再异步拉取 models.dev 原始 JSON（解析拍平后仅当数据非空才替换内存索引并覆盖缓存，内容无变化则跳过写入；失败以固定 5s 间隔重试最多 3 次，仍失败仅记录日志、继续使用现有目录）；缓存不可用（理论上不会发生，构建已保留缓存）则直接拉取最新数据填充并更新缓存；目录以内存常驻形式供每次填充复用，首次由缓存或网络初始化，此后仅被异步刷新结果整体替换
- 填充流程（`fill`）：读取 settings 命名空间 `llm-pi-ai` 的 `providers[*].models` 及描述符 revision，对缺少 `reasoningEfforts` 的模型查找目录（`lookup` 优先按 provider+modelId 匹配，失败再仅按 modelId 全局匹配），生成推理级别并按 provider 整段写回 `providers[providerId].models` 数组（其余模型字段原样保留；路径 op 不支持数组下标中间段）；写回携带 revision 做并发冲突校验，冲突时重读重算（限次）
- 生命周期（`apply`）：`inject: ['settings']` 保证服务已就绪；`settings/updated` 事件监听配置变更后再次填充；首轮缓存读取与异步刷新统一由 effect 管理（异步读到缓存后立即用缓存填充，填充完成后链式拉取最新数据；卸载时置位，在途读取/刷新结果不再触碰已卸载的上下文）

## 配置说明

- 自有配置命名空间为 `model-reasoning`（由本插件通过 `installSettingsSection` 注册），在 settings 文件的 `model-reasoning` section 中配置，如 `model-reasoning: { allowUpdate: true }`；后续可为其注册浏览器设置卡片，在 Web 设置页「插件配置」tab 展示开关
- settings 命名空间为 `llm-pi-ai`（由 harness 的 llm-pi-ai 插件注册），模型列表即该命名空间下的 `providers` 配置
- 推理级别取值与 harness 的 `ModelThinkingLevel` 一致：`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`

## 开发命令

- `pnpm build`：构建到 `lib/`
- `pnpm run typecheck`：tsc 类型检查
- `pnpm install`：安装依赖（`prepare` 钩子自动执行 `pnpm build`，故 `lib/` 在安装后即存在）
