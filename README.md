# dsh-model-reasoning

DSH 插件：为所有非官方（自定义）提供商的模型自动填充推理级别（`reasoningEfforts`），推理级别数据来自 [models.dev](https://models.dev)。

## 功能

- 进入插件时优先使用构建附带的 models.dev 缓存（解析为非空数组才算可用）立即填充推理级别，避免启动时等待网络
- 首轮填充完成后异步拉取 models.dev 最新数据：成功则更新缓存并再次填充；失败以固定 5 秒间隔重试最多 3 次，仍失败仅记录日志、继续使用现有目录
- 监听 `settings/updated` 事件，模型配置变更后自动重新填充
- 默认仅填充缺少 `reasoningEfforts` 的模型，已有配置不受影响
- 支持通过自有配置控制行为：`allowUpdate` 开启后，以 models.dev 最新数据为准同步已有模型的推理级别档位

## 安装

```bash
dsh plugin --profile web add github:TikaFlow/dsh-model-reasoning
```

## 使用说明

无需任何操作，重启 DSH 后插件即自动生效：支持推理级别的模型将会自动填充推理级别，可在界面中选择。

### 配置

在 Web 设置界面右上角点击「打开配置文件 / Open configuration file」直接编辑 `settings.yaml`，在文件末尾添加：

```yaml
# 建议直接复制，注意开头不要有空格
model-reasoning:
  # 开启后以 models.dev 最新数据为准更新已有推理级别档位；默认 false
  allowUpdate: true
```
