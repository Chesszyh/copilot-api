# Agent 可观测性用户手册

## 1. 这次升级增加了什么

本次升级为 `copilot-api` 增加了一套本地 Agent 可观测性 MVP，主要能力包括：

- 在代理主链上采集请求事件
- 将请求归并到 session
- 将结构化事件保存到本地 SQLite
- 将原始请求/响应正文短期保存到本地文件
- 支持对 session 执行 pin / unpin
- 提供本地 observability API 读取汇总与会话详情
- 提供独立的 observability viewer 页面
- 提供 debug mock 数据生成与 reset 能力
- 支持 JSON 源码视图、JSON 下载、复制与文件路径展示

## 2. 更新后的面板在哪里看

### 2.1 现有页面

当前仍然只有原有的配额页面：

- `http://localhost:4141/usage-viewer?endpoint=http://localhost:4141/usage`

它显示的是 GitHub Copilot 上游 usage/quota 信息，不是新的 observability session 分析页面。

### 2.2 Observability Viewer

当前新增的独立页面地址是：

- `http://localhost:4141/observability-viewer`

如果你改了启动端口，例如 `4142`，则对应为：

- `http://localhost:4142/observability-viewer`

该页面当前支持：

- summary 概览
- session 列表
- session 搜索
- 状态与来源过滤
- session 详情
- request 时间线
- request 快速跳转
- pin / unpin
- debug mock 入口
- JSON 源码视图
- JSON 下载、复制与文件路径展示

### 2.3 新增 observability API

- `GET /observability/summary`
- `GET /observability/sessions`
- `GET /observability/sessions/:sessionId`
- `POST /observability/pin/:sessionId`
- `DELETE /observability/pin/:sessionId`
- `POST /observability/mock/generate`
- `POST /observability/mock/reset`

也就是说：

- **旧页面**：看 Copilot 配额和 usage
- **新页面**：看本地 observability 会话与请求数据
- **新 API**：给 viewer 和调试脚本提供数据与控制入口

## 3. 启用方式

### 3.1 安装依赖

在项目根目录执行：

```bash
bun install
```

### 3.2 打开 observability

可观测性配置在本地 `config.json` 中，由项目运行时自动读取。

默认配置项位于运行目录下的：

- `~/.local/share/copilot-api/config.json`

如果你设置了 `COPILOT_API_HOME`，则位于：

- `$COPILOT_API_HOME/config.json`

在这个文件中加入或确认存在：

```json
{
  "observability": {
    "enabled": true,
    "debugMockEnabled": false,
    "queueCapacity": 2048,
    "batchSize": 100,
    "flushIntervalMs": 1000,
    "rawRetentionDays": 3,
    "maxBodyBytes": 262144
  }
}
```

### 3.3 启动服务

```bash
bun run start
```

或开发模式：

```bash
bun run dev
```

## 4. 新增 API 说明

### 4.1 `GET /observability/summary`

作用：读取本地 observability 汇总信息。

示例：

```bash
curl http://localhost:4141/observability/summary
```

当前返回的核心字段包括：

- `sessionCount`
- `requestCount`
- `pinnedSessionCount`
- `failedRequestCount`

### 4.2 `GET /observability/sessions`

作用：读取 session 列表。

示例：

```bash
curl http://localhost:4141/observability/sessions
```

支持简单分页参数：

```bash
curl "http://localhost:4141/observability/sessions?limit=20&offset=0"
```

### 4.3 `GET /observability/sessions/:sessionId`

作用：读取单个 session 详情。

示例：

```bash
curl http://localhost:4141/observability/sessions/<session_id>
```

当前详情会包含：

- session 基本信息
- 该 session 下的 request 列表
- 每个 request 的 model、route、timing、token、摘要、raw reference 等字段
- viewer 中可通过 request 跳转器快速定位到单条请求

### 4.4 `POST /observability/pin/:sessionId`

作用：将一个 session 标记为 pinned。

示例：

```bash
curl -X POST http://localhost:4141/observability/pin/<session_id>
```

含义：

- 该 session 将被标记为长期保留
- 其对应的 raw 正文文件不再参与 3 天 TTL 清理

### 4.5 `DELETE /observability/pin/:sessionId`

作用：取消 pin。

示例：

```bash
curl -X DELETE http://localhost:4141/observability/pin/<session_id>
```

注意：

- 取消 pin 后，后续 TTL 清理将重新生效
- 这不是立即删除，只是恢复到正常留存策略

## 5. 数据保存在哪里

默认情况下，observability 数据保存在：

- `~/.local/share/copilot-api/observability/events.db`
- `~/.local/share/copilot-api/observability/raw/`
- `~/.local/share/copilot-api/observability/pinned/`

如果你使用了自定义 API home，例如：

```bash
COPILOT_API_HOME=/tmp/copilot-api bun run start
```

则会保存到：

- `/tmp/copilot-api/observability/events.db`
- `/tmp/copilot-api/observability/raw/`
- `/tmp/copilot-api/observability/pinned/`

### 5.1 `events.db`

作用：

- 保存结构化的 session/request/raw artifact 元数据

### 5.2 `raw/`

作用：

- 保存最近 3 天的原始请求/响应正文

### 5.3 `pinned/`

作用：

- 保存被 pin 的长期保留原文

## 6. 目前会采集哪些数据

当前 MVP 重点采集：

- `requestId`
- `sessionId`
- `traceId`
- `routeType`
- `path`
- `method`
- `model`
- `stream`
- `requestStartedAt`
- `firstTokenAt`
- `requestFinishedAt`
- `statusCode`
- `errorType`
- `inputTokens`
- `outputTokens`
- `cachedTokens`
- `reasoningTokens`
- `sanitizedPayload`
- `sanitizedResponse`
- `rawReference`

viewer 当前还提供以下只读辅助能力：

- 按 `sessionId / scenario / clientType` 搜索 session
- 按 `status` 过滤 session
- 按 `source` 过滤 `live / mock`
- 在 session 详情中通过 request 跳转器快速定位单条请求

## 7. 默认留存策略

### 7.1 默认行为

- 结构化元数据保留
- 原始正文保留最近 3 天
- 正文有大小上限
- 默认会做脱敏摘要保存

### 7.2 pin 后行为

- session 被标记为 pinned
- 相关 raw artifacts 不再参与 TTL 清理
- 更适合保留你想长期分析的会话

## 8. 如何验证升级是否正常工作

建议按以下顺序测试。

### 8.1 基础测试

```bash
bun test
bun run lint
bun run typecheck
```

### 8.2 仅测 observability 相关

```bash
bun test tests/observability/capture.test.ts
bun test tests/observability/queue.test.ts
bun test tests/observability/redact.test.ts
bun test tests/observability/storage.test.ts
bun test tests/observability/routes.test.ts
```

### 8.3 运行服务后做手工验证

先启动：

```bash
bun run start
```

然后先确认原有基础接口正常：

```bash
curl http://localhost:4141/
curl http://localhost:4141/v1/models
curl http://localhost:4141/usage
```

### 8.4 发送真实代理请求

至少分别发一次：

- `POST /v1/messages`
- `POST /v1/responses`
- `POST /v1/chat/completions`

建议同时覆盖：

- non-stream
- stream

发完后检查：

```bash
curl http://localhost:4141/observability/summary
curl http://localhost:4141/observability/sessions
```

应看到：

- `sessionCount` 增加
- `requestCount` 增加
- session 列表中出现新会话

### 8.5 查看单个 session 详情

```bash
curl http://localhost:4141/observability/sessions/<session_id>
```

确认：

- request 是否归入该 session
- timing/token 字段是否存在
- payload/response 摘要是否存在

### 8.6 测试 pin / unpin

```bash
curl -X POST http://localhost:4141/observability/pin/<session_id>
curl http://localhost:4141/observability/sessions/<session_id>
curl -X DELETE http://localhost:4141/observability/pin/<session_id>
```

确认：

- `pinned` 状态变化正常

## 9. 如何检查本地文件是否真的生成

```bash
find ~/.local/share/copilot-api/observability -maxdepth 3 -type f | sort
```

如果使用自定义 home，则把路径替换成你的 `$COPILOT_API_HOME`。

重点看：

- `events.db` 是否存在
- `raw/` 下是否出现文件
- pin 后 `pinned/` 下是否出现文件

## 10. 性能测试建议

因为本次升级强调“不能拖慢主链”，建议做 observability 开关对比测试。

### 10.1 关闭 observability

```json
{
  "observability": {
    "enabled": false
  }
}
```

### 10.2 开启 observability

```json
{
  "observability": {
    "enabled": true
  }
}
```

分别测试同一批请求，至少比较：

- 首包延迟
- 总耗时
- 长 stream 是否明显变慢
- 内存是否明显上涨

## 11. 常见问题

### 11.1 为什么我只能看到 `/usage-viewer`，看不到新的面板？

先确认你访问的是：

- `/observability-viewer`

而不是：

- `/usage-viewer`

`/usage-viewer` 仍然只显示 GitHub Copilot usage/quota；新的本地观测面板在 `/observability-viewer`。

新面板当前还支持：

- session 搜索
- status/source 过滤
- request 快速跳转

### 11.2 为什么 `summary` 是空的？

常见原因：

- `observability.enabled` 没打开
- 服务没重启
- 还没产生新的代理请求
- 请求没有真正经过本地 `copilot-api`

### 11.3 pin 之后为什么还要看 `raw/` 和 `pinned/`？

因为 pin 主要影响原始正文是否长期保留。结构化数据仍在 SQLite 中，原文是否被保护要看文件目录与 DB 元数据。

### 11.4 为什么 lint 会输出 `baseline-browser-mapping` 提示？

这是依赖版本提醒，不代表 lint 失败。只要命令最终退出码为 0，就说明 lint 已通过。

## 12. 后续可扩展方向

当前用户最常见的下一步需求会是：

- 增加 session 筛选、排序、搜索
- 增加更细的质量信号与评分
- 增加 benchmark 文档与压测脚本
- 增加多用户视图

如果你准备继续推进，优先级最高的一步通常是：**补规则型质量信号和 benchmark，而不是继续扩 viewer 的表层 UI。**
