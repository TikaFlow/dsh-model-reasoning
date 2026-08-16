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
| `public/models-cache.json` | models.dev 模型数据缓存，构建时复制到产物目录 |
| `lib/` | 构建产物（gitignore），含 `lib/index.js` 与 `lib/public/models-cache.json` |
| `cordis.patch.yml` | DSH 补丁层对本插件的注册 |
| `tsdown.config.ts` | 构建配置（`outDir: lib`、`copy: public`） |

## 核心逻辑

- 数据加载（`readCache` / `fetchLatest`）：进入插件时从缓存文件读取并解析（存在、大小 >= 10KB 且解析成功才算可用，避免更新中途截断误判）；缓存可用则立即用缓存填充，再延迟 5s 异步拉取 models.dev 最新数据（成功则覆盖缓存文件并整体替换内存目录后再次填充，失败仅记录日志、继续使用现有目录）；缓存不可用（理论上不会发生，构建已保留缓存）则直接拉取最新数据填充并更新缓存；目录以内存常驻形式供每次填充复用，首次由缓存或网络初始化，此后仅被异步刷新结果整体替换
- 填充流程（`fill`）：读取 settings 命名空间 `llm-pi-ai` 的 `providers[*].models`，对缺少 `reasoningEfforts` 的模型按 id 匹配目录，生成推理级别并通过 `settings.mutate` 写回
- 生命周期（`apply`）：`inject: ['settings']` 保证服务已就绪；`settings/updated` 事件监听配置变更后再次填充；apply 内优先用缓存执行首轮填充，并安排延迟异步刷新

## 配置说明

- settings 命名空间为 `llm-pi-ai`（由 harness 的 llm-pi-ai 插件注册），模型列表即该命名空间下的 `providers` 配置
- 推理级别取值与 harness 的 `ModelThinkingLevel` 一致：`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`

## 开发命令

- `pnpm build`：构建到 `lib/`
- `pnpm run typecheck`：tsc 类型检查
