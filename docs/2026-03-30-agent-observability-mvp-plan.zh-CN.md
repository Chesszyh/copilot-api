# Agent 可观测性 MVP 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 为 `copilot-api` 增加一套本地、旁路、低开销的 Agent 可观测性 MVP，优先支持会话行为分析与 Prompt / Agent 质量诊断，同时保证现有请求转发性能不下降。

**架构：** 在现有代理请求链上增加一个极轻量的 capture 抽象，仅同步采集最小事件并放入有界内存队列。所有脱敏、摘要、聚合、原文留存、SQLite 持久化与分析计算都由异步 worker 完成，并通过独立的本地 analytics 接口与页面读取结果。

**技术栈：** Bun、TypeScript、Hono、SQLite（优先 Bun 内置 `bun:sqlite`）、本地文件存储、现有 trace/request/session 工具函数与日志体系。

---

## 计划前提

- 设计文档基线：
  - `docs/2026-03-30-agent-observability-design.zh-CN.md`
  - `docs/2026-03-30-agent-observability-design.md`
- 原始正文保留策略：
  - 默认脱敏摘要
  - 原文保留最近 3 天
  - 支持手动永久 pin
- 性能约束：
  - 请求路径新增同步开销目标 `p50 < 1ms`
  - 请求路径新增同步开销目标 `p95 < 3ms`
  - 流式 chunk 路径不允许做深处理

## 文件结构草案

以下是推荐的 MVP 文件拆分。若实施中发现复用现有文件更合理，可微调，但必须保持职责清晰。

### 新增文件

- `src/lib/observability/types.ts`
  - 定义 `session`、`request_event`、`tool_event`、队列事件、分析事实等类型
- `src/lib/observability/config.ts`
  - 观测系统配置读取、默认值、开关、容量上限
- `src/lib/observability/queue.ts`
  - 有界内存队列、丢弃统计、批量消费接口
- `src/lib/observability/capture.ts`
  - 主链 capture 抽象：start / complete / fail / stream hooks
- `src/lib/observability/redact.ts`
  - 脱敏规则与正文截断规则
- `src/lib/observability/session.ts`
  - request -> session 归并辅助逻辑
- `src/lib/observability/storage.ts`
  - SQLite 与原文目录的统一存储接口
- `src/lib/observability/worker.ts`
  - 后台消费与处理流水线
- `src/lib/observability/lifecycle.ts`
  - 服务启动、关闭、定时清理任务
- `src/routes/observability/summary-route.ts`
  - 聚合概览接口
- `src/routes/observability/sessions-route.ts`
  - session 列表与详情接口
- `src/routes/observability/pin-route.ts`
  - pin / unpin 接口
- `tests/observability/queue.test.ts`
- `tests/observability/redact.test.ts`
- `tests/observability/storage.test.ts`
- `tests/observability/capture.test.ts`
- `tests/observability/routes.test.ts`
- `docs/observability-benchmarks.md`
  - 实施后记录压测方法与结果

### 可能修改的现有文件

- `src/lib/config.ts`
  - 增加 observability 配置项
- `src/lib/paths.ts`
  - 增加 observability 数据目录、raw/pinned 路径
- `src/lib/request-context.ts`
  - 如有必要，扩展 request 上下文辅助字段，但避免职责膨胀
- `src/start.ts`
  - 启动 observability worker 与清理任务
- `src/server.ts`
  - 注册 analytics 路由与页面入口
- `src/routes/messages/handler.ts`
- `src/routes/responses/handler.ts`
- `src/routes/chat-completions/handler.ts`
  - 统一接入 capture 抽象
- `pages/index.html`
  - 若暂时复用页面，加入 observability 入口；否则新增独立页面
- `README.md`
  - 补充 observability 功能说明

## 分阶段实施策略

MVP 建议拆成六个任务块，每个任务块都能独立验证。

### Task 1: 打基础类型、配置与路径

**文件：**
- Create: `src/lib/observability/types.ts`
- Create: `src/lib/observability/config.ts`
- Modify: `src/lib/config.ts`
- Modify: `src/lib/paths.ts`
- Test: `tests/observability/redact.test.ts`

- [ ] **Step 1: 写配置与路径层的 failing tests**

覆盖点：

- observability 默认关闭或默认最小开启策略
- 队列容量、raw TTL、pin 目录等默认值
- 路径创建正确落在 `COPILOT_API_HOME` 下

- [ ] **Step 2: 运行测试并确认失败**

Run: `bun test tests/observability/redact.test.ts`
Expected: FAIL，因为相关模块尚未存在

- [ ] **Step 3: 实现最小类型、配置与路径**

实现内容：

- 明确 `ObservabilityConfig`
- 增加数据目录：
  - `observability/`
  - `observability/raw/`
  - `observability/pinned/`
  - `observability/events.db`
- 在 `config.json` 里补 observability 默认配置

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test tests/observability/redact.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/config.ts src/lib/paths.ts src/lib/observability/types.ts src/lib/observability/config.ts tests/observability/redact.test.ts
git commit -m "feat: add observability config and paths"
```

### Task 2: 实现有界队列与最小 capture 抽象

**文件：**
- Create: `src/lib/observability/queue.ts`
- Create: `src/lib/observability/capture.ts`
- Modify: `src/lib/request-context.ts`
- Test: `tests/observability/queue.test.ts`
- Test: `tests/observability/capture.test.ts`

- [ ] **Step 1: 写队列与 capture 的 failing tests**

覆盖点：

- 有界队列入队/出队
- 队列满时丢弃详细事件并记录 dropped count
- capture.start / complete / fail 生成最小事件
- stream 场景下只统计首包时间和结束时间，不做 chunk 深分析

- [ ] **Step 2: 运行测试并确认失败**

Run: `bun test tests/observability/queue.test.ts tests/observability/capture.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现最小队列与 capture**

实现内容：

- 同步路径仅生成轻量 request event shell
- 支持 `observeRequestStart`
- 支持 `observeRequestComplete`
- 支持 `observeRequestError`
- 支持 `observeStreamFirstChunk`
- 支持 `observeStreamComplete`

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test tests/observability/queue.test.ts tests/observability/capture.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/observability/queue.ts src/lib/observability/capture.ts src/lib/request-context.ts tests/observability/queue.test.ts tests/observability/capture.test.ts
git commit -m "feat: add observability queue and capture layer"
```

### Task 3: 持久化与原文留存

**文件：**
- Create: `src/lib/observability/storage.ts`
- Create: `src/lib/observability/redact.ts`
- Create: `src/lib/observability/session.ts`
- Test: `tests/observability/storage.test.ts`
- Test: `tests/observability/redact.test.ts`

- [ ] **Step 1: 写 storage / redact 的 failing tests**

覆盖点：

- SQLite 初始化
- request_event / session 基本写入
- raw 原文写入短期目录
- 过期清理逻辑
- pin 后原文转为长期保留
- 常见敏感字段脱敏：
  - `authorization`
  - `x-api-key`
  - `token`
  - 类密钥字符串

- [ ] **Step 2: 运行测试并确认失败**

Run: `bun test tests/observability/storage.test.ts tests/observability/redact.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 SQLite 与原文留存**

实现内容：

- SQLite schema 初始化
- raw/pinned 文件写入
- 简单 session upsert
- 原文 TTL 清理
- 基础脱敏与截断

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test tests/observability/storage.test.ts tests/observability/redact.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/observability/storage.ts src/lib/observability/redact.ts src/lib/observability/session.ts tests/observability/storage.test.ts tests/observability/redact.test.ts
git commit -m "feat: add observability storage and retention"
```

### Task 4: 后台 worker 与主链路接入

**文件：**
- Create: `src/lib/observability/worker.ts`
- Create: `src/lib/observability/lifecycle.ts`
- Modify: `src/start.ts`
- Modify: `src/routes/messages/handler.ts`
- Modify: `src/routes/responses/handler.ts`
- Modify: `src/routes/chat-completions/handler.ts`
- Test: `tests/observability/capture.test.ts`

- [ ] **Step 1: 写主链接入相关 failing tests**

覆盖点：

- 三条路由都能写入最小 request_event
- 异常场景能写错误事件
- streaming 路由能记录首包与结束时间
- worker 异步消费不阻塞响应

- [ ] **Step 2: 运行测试并确认失败**

Run: `bun test tests/observability/capture.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 worker 与主链接入**

实现内容：

- 启动时初始化 worker
- 服务关闭时 flush / stop
- 在三个 handler 中统一使用 capture 抽象
- 避免重复 `JSON.stringify` 大 payload
- 确保 stream chunk 处理路径不做重逻辑

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test tests/observability/capture.test.ts`
Expected: PASS

- [ ] **Step 5: 运行核心回归测试**

Run: `bun test tests/anthropic-request.test.ts tests/create-chat-completions.test.ts tests/responses-translation.test.ts tests/responses-stream-translation.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/lib/observability/worker.ts src/lib/observability/lifecycle.ts src/start.ts src/routes/messages/handler.ts src/routes/responses/handler.ts src/routes/chat-completions/handler.ts tests/observability/capture.test.ts
git commit -m "feat: wire observability into request handlers"
```

### Task 5: 本地 analytics 接口与最小读视图

**文件：**
- Create: `src/routes/observability/summary-route.ts`
- Create: `src/routes/observability/sessions-route.ts`
- Create: `src/routes/observability/pin-route.ts`
- Modify: `src/server.ts`
- Modify: `pages/index.html` 或新增独立页面文件
- Test: `tests/observability/routes.test.ts`

- [ ] **Step 1: 写 analytics routes 的 failing tests**

覆盖点：

- summary 接口返回基础会话统计
- session 列表可分页读取
- session 详情可读请求链
- pin / unpin 接口可更新保留状态

- [ ] **Step 2: 运行测试并确认失败**

Run: `bun test tests/observability/routes.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现最小 analytics 接口**

MVP 先提供：

- `/observability/summary`
- `/observability/sessions`
- `/observability/sessions/:id`
- `/observability/pin/:sessionId`

页面范围控制：

- 先做最小可用读取页
- 不在 MVP 中做复杂筛选器和实时刷新

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test tests/observability/routes.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/routes/observability/summary-route.ts src/routes/observability/sessions-route.ts src/routes/observability/pin-route.ts src/server.ts pages/index.html tests/observability/routes.test.ts
git commit -m "feat: add observability analytics routes"
```

### Task 6: 规则型质量信号、文档与性能基准

**文件：**
- Modify: `src/lib/observability/worker.ts`
- Modify: `src/lib/observability/storage.ts`
- Create: `docs/observability-benchmarks.md`
- Modify: `README.md`

- [ ] **Step 1: 为规则型质量信号补充 failing tests**

覆盖点：

- `retry_after_answer`
- `user_correction_signal`
- `redundant_tool_signal`
- `high_reasoning_low_outcome_signal`

- [ ] **Step 2: 运行测试并确认失败**

Run: `bun test tests/observability/routes.test.ts tests/observability/storage.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现最小质量信号计算**

只做规则型信号，不做模型评估。

- [ ] **Step 4: 编写基准测试文档与执行命令**

至少覆盖：

- observability off vs on
- messages / responses / chat-completions
- streaming vs non-streaming
- p50/p95/p99
- RSS
- queue backlog
- dropped event count

- [ ] **Step 5: 更新 README**

补充：

- observability 功能说明
- 数据留存策略
- pin 机制
- 性能约束说明

- [ ] **Step 6: 运行全量测试**

Run: `bun test`
Expected: PASS

- [ ] **Step 7: 运行 lint**

Run: `bun run lint`
Expected: PASS

- [ ] **Step 8: 提交**

```bash
git add src/lib/observability/worker.ts src/lib/observability/storage.ts docs/observability-benchmarks.md README.md
git commit -m "feat: add observability quality signals and docs"
```

## MVP 交付标准

实现完成后，至少要满足以下验收条件：

- 能在三条主要代理路由上采集最小 request_event
- 能将 request_event 归并到 session
- 能持久化结构化数据到 SQLite
- 能把原始正文保留 3 天并支持手动 pin
- 能通过本地接口读取 summary 和 session 详情
- 能输出至少四类规则型质量信号
- 在压测中没有出现明显性能回退

## 最低基准验证清单

- [ ] 关闭 observability，记录基线
- [ ] 开启 observability，比较 `messages` non-stream
- [ ] 开启 observability，比较 `messages` stream
- [ ] 开启 observability，比较 `responses` non-stream
- [ ] 开启 observability，比较 `responses` stream
- [ ] 开启 observability，比较 `chat/completions`
- [ ] 记录 p50 / p95 / p99
- [ ] 记录 RSS 与 event loop lag
- [ ] 记录 dropped event 数

## 风险控制策略

### 风险 1：同步路径偷偷变重

控制：

- 所有 capture API 保持浅层参数与轻量对象
- 禁止在 capture 中做深层序列化
- 每个任务块结束后都跑回归和压测

### 风险 2：长 stream 拉高内存

控制：

- 限制单请求原文缓存
- 限制单 stream 拼装上限
- 超限后写截断标记而不是继续累积

### 风险 3：SQLite 写入成为瓶颈

控制：

- worker 批量写入
- 必要时将 raw 正文写文件、结构化数据写库
- 出现积压时优先丢详细事件

### 风险 4：质量评分不可解释

控制：

- MVP 只上规则型信号
- 先不做黑盒总分

## 开发顺序建议

严格按以下顺序执行，不要跳步：

1. 配置与路径
2. 队列与 capture
3. 存储与留存
4. worker 与主链接入
5. analytics 读取接口
6. 规则型质量信号
7. 文档与性能基准

## 执行注意事项

- 保持每个提交都可运行、可测试。
- 每次只引入一个新责任点，避免把 capture、worker、storage 混在同一提交里。
- 优先复用现有 request id、session id、trace id 逻辑，不重复发明标识体系。
- 如果实施中发现 `pages/index.html` 不适合继续扩展，允许新增独立 observability 页面，但不要在 MVP 中引入前端构建系统。
- 若 `bun:sqlite` 在当前环境存在兼容问题，再退回其他最小依赖方案；不要一开始就引入重型数据库依赖。

## 参考文档

- `docs/2026-03-30-agent-observability-design.zh-CN.md`
- `docs/2026-03-30-agent-observability-design.md`

## 完成后的下一步

MVP 完成后，再评估以下增强项是否值得进入下一阶段：

- `turn` 实体
- 多用户视角
- 更丰富的 dashboard 筛选
- 与 OTel / Langfuse / Phoenix 的导出兼容
- 更复杂的质量评估与 prompt 实验框架
