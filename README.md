# dsh-model-reasoning

[DSH](https://github.com/deepseek-ai/deepseek-harness)（DeepSeek Harness）插件：为所有非官方（自定义）提供商的模型自动填充推理级别（`reasoningEfforts`）、最大上下文（`contextWindow`）与输出上限（`maxTokens`），数据来自 [models.dev](https://models.dev)。

> 本插件已被 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 收录，同时可在 [dsh-market](https://github.com/dsh-market/dsh-market) 中搜索、安装。

## 功能

- 进入插件时优先使用构建附带的 models.dev 缓存（解析为非空数组才算可用）立即填充，避免启动时等待网络
- 首轮填充完成后异步拉取最新数据：成功则更新缓存并再次填充；失败则重试
- 监听模型配置变化后自动重新填充
- 填充内容包括 `reasoningEfforts`、 `contextWindow` / `maxTokens`；已有配置不受影响
- 支持通过自有配置控制行为：`autoFill` 控制是否自动填充，`allowUpdate` 控制是否同步最新数据（可能覆盖手动修改的模型参数）
- 配置存放在独立命名空间，插件升级时自动迁移旧配置，回退旧版本亦不受影响，全程无需手动处理

## 安装

-  通过插件市场安装（推荐）

> 使用 `dsh-market` 插件市场安装时无需重启 DSH 即生效。

-  通过命令行安装

```bash
dsh plugin --profile web add github:TikaFlow/dsh-model-reasoning

# 重启 DSH 
dsh web
```

## 使用说明

无需任何操作，进入 DSH 后插件即自动生效：支持推理级别的模型将会自动填充推理级别，可在界面中选择；缺失上下文的模型将自动补全 `contextWindow` / `maxTokens`。

### 配置

在 Web 设置界面右上角点击「打开配置文件 / Open configuration file」直接编辑 `settings.yaml`，找到以下内容修改：

```yaml
tikaflow-model-fix:
  version-1:
    autoFill:
      reasoning: true   # 填充缺失的推理级别档位；默认 true
      context: true     # 填充缺失的 contextWindow/maxTokens；默认 true
    allowUpdate:
      reasoning: true   # 同步已有模型的推理级别档位；默认 false
      context: false    # 不同步已有模型的 contextWindow/maxTokens；默认 false
```

> 旧版本 `model-reasoning` 命名空间下的配置会自动迁移为上述对象形态，无需手动处理；旧配置段会留在文件中，确认无误后可自行删除。
