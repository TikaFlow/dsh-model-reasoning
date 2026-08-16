# dsh-model-reasoning

DSH 插件：为所有非官方（自定义）提供商的模型自动填充推理级别（`reasoningEfforts`），推理级别数据来自 [models.dev](https://models.dev)。

## 功能

- 进入插件时优先使用构建附带的 models.dev 缓存（存在、大小不低于 10KB 且解析成功才算可用）立即填充推理级别，避免启动时等待网络
- 延迟 5 秒异步拉取 models.dev 最新数据：成功则更新缓存并再次填充；失败则记录日志，继续使用现有目录
- 监听 `settings/updated` 事件，模型配置变更后自动重新填充
- 仅填充缺少 `reasoningEfforts` 的模型，已有配置不受影响

## 构建

```bash
pnpm install
pnpm build         # 构建到 lib/
pnpm run typecheck # 类型检查
```

构建后 `lib/public/models-cache.json` 为随插件分发的缓存数据。

## 配置

- settings 命名空间：`llm-pi-ai`（由 harness 的 llm-pi-ai 插件注册）
- 模型列表：该命名空间下的 `providers[*].models`
- 推理级别取值：`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`