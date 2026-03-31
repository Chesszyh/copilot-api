# Agent 可观测性当前状态报告与下一阶段计划

## 1. 文档基线

本报告基于以下文档与当前代码状态整理：

- `docs/2026-03-30-agent-observability-design.zh-CN.md`
- `docs/2026-03-30-agent-observability-mvp-plan.zh-CN.md`
- `docs/2026-03-30-agent-observability-user-manual.zh-CN.md`
- `docs/2026-03-30-observability-viewer-and-mock-design.zh-CN.md`

## 2. 当前状态

### 2.1 已完成

当前已经完成并可用的部分包括：

- observability 配置与路径初始化
- capture / queue / worker / storage / redact / session 等核心后端骨架
- `messages` 与 `responses` 主链路的 observability 接入
- SQLite 结构化事件存储
- `raw/` 与 `pinned/` 文件留存
- `pin / unpin`
- `/observability/summary`
- `/observability/sessions`
- `/observability/sessions/:sessionId`
- `/observability/pin/:sessionId`
- 独立页面 `/observability-viewer`
- `debugMockEnabled` 开关
- `/observability/mock/generate`
- `/observability/mock/reset`
- mock 数据生成与独立清理
- viewer JSON 下载、复制、文件路径展示
- viewer 默认 JSON 源码视图

### 2.2 已完成但文档此前滞后

此前用户手册仍把系统描述为“只有 API，没有独立页面”，该描述现在已经过时。当前状态应以以下能力为准：

- 已存在独立的 observability viewer 页面
- 已存在 mock 调试入口
- 已支持较完善的 JSON 阅读体验

### 2.3 部分完成

以下部分已经具备基础，但尚未达到设计文档中的分析目标：

- 会话行为分析
  - 已有基础 summary 和 session 详情
  - 但还缺少更丰富的聚合与筛选
- Prompt / Agent 质量分析
  - 已具备 request/session 事实数据
  - 但规则型质量信号仍未落地

## 3. 尚未完成的 TODO

以下 TODO 仍然与原始设计和 MVP 计划一致，且优先级较高。

### 3.1 规则型质量信号

尚未落地：

- `retry_after_answer`
- `user_correction_signal`
- `redundant_tool_signal`
- `high_reasoning_low_outcome_signal`

当前系统更像“观测平台”，还不是“质量诊断平台”。

### 3.2 `analysis_fact`

设计文档中已经定义了 `analysis_fact` 这一层派生事实，但当前实现尚未形成明确的派生表、统一计算入口和对外读取视图。

### 3.3 `tool_event`

设计文档中把 `tool_event` 列为核心实体之一，但当前实现还没有独立的 `tool_event` 存储与 API，因此 agent 工具路径分析仍不完整。

### 3.4 `chat-completions` observability 接入确认

MVP 计划要求三条主要代理路由都接入 capture：

- `messages`
- `responses`
- `chat.completions`

目前 `messages` 与 `responses` 是明确完成的，`chat.completions` 需要再做一次实现状态确认；若未完全接入，应补齐。

### 3.5 benchmark 文档与性能验收

以下尚未完成：

- `docs/observability-benchmarks.md`
- 正式记录 observability 开关前后的性能对比
- dropped events / queue backlog / RSS / p50/p95/p99 结果归档

### 3.6 README 更新

项目根 README 尚未同步 observability 的以下内容：

- 启用方式
- viewer 地址
- mock 调试方式
- 数据目录
- pin / raw retention 策略

## 4. 不属于当前 TODO 的事项

以下内容虽然在设计里出现过，但属于明确延期或下一阶段范围，不应混入当前收尾 TODO：

- `turn` 实体
- 多用户面板
- OTel / Langfuse / Phoenix 导出兼容
- 黑盒质量评分
- 复杂 dashboard 筛选系统

## 5. 下一阶段建议目标

下一阶段建议把重点放在“把已有观测平台补成真正的分析系统”，而不是继续打磨表层页面。

建议目标：

1. 落地最小规则型质量信号
2. 明确 `analysis_fact` 数据流
3. 确认并补齐 `chat.completions` 接入
4. 补 benchmark 文档与压测结果
5. 更新 README

## 6. 支持并行开发的任务拆分

下一阶段建议收缩到 3 个并行 agent。这样仍能并行推进，但共享文件和集成成本明显低于 4 路拆分。

### Agent A: 质量信号与派生事实核心

目标：

- 实现最小规则型质量信号
- 设计并落地 `analysis_fact`
- 为后续 `tool_event` 打基础

主文件 ownership：

- `src/lib/observability/worker.ts`
- `src/lib/observability/storage.ts`
- `src/lib/observability/types.ts`
- `tests/observability/storage.test.ts`
- `tests/observability/routes.test.ts`

交付结果：

- 最少 3 到 4 个规则型质量信号
- `analysis_fact` 的写入、查询与最小读取视图
- 共享 schema 的最终集成权

详细开发文档：

- `docs/2026-03-31-agent-a-quality-signals-and-analysis-fact.zh-CN.md`

### Agent B: 路由覆盖、链路回归与性能基准

目标：

- 确认并补齐 `chat.completions` observability 接入
- 做三条主链路的观测回归
- 输出性能基准方法与结果文档

主文件 ownership：

- `src/routes/chat-completions/handler.ts`
- `src/lib/observability/capture.ts`
- `tests/create-chat-completions.test.ts`
- `docs/observability-benchmarks.md`

交付结果：

- `messages` / `responses` / `chat.completions` 的 observability 接入状态一致
- benchmark 文档与基础结果表
- 不引入主链明显性能回退

详细开发文档：

- `docs/2026-03-31-agent-b-route-coverage-and-benchmarks.zh-CN.md`

### Agent C: 文档同步与 viewer 轻量增强

目标：

- 同步 README 与用户手册
- 为当前分析能力补齐使用说明
- 只做不影响后端协议的 viewer 轻量增强

主文件 ownership：

- `README.md`
- `docs/2026-03-30-agent-observability-user-manual.zh-CN.md`
- `pages/observability-viewer.html`
- `tests/observability/viewer-route.test.ts`

可选内容：

- session 筛选
- 状态过滤
- 更好的 request 导航
- 不改后端 schema 的可读性增强

约束：

- 不得引入前端构建系统
- 不得改动 Agent A 正在定义的 schema
- 需要以 Agent A 暴露出来的只读接口为准

详细开发文档：

- `docs/2026-03-31-agent-c-docs-and-viewer-polish.zh-CN.md`

## 7. 并行开发规则

为避免 agent 并行开发互相覆盖，建议遵循：

- 每个 agent 有明确文件 ownership
- 不要跨 agent 改动彼此的主文件
- 如果必须修改共享文件，例如 `storage.ts` 或 `types.ts`，优先让 Agent A 拥有最终集成权
- Agent C 不直接改后端 schema
- 合并顺序建议：
  1. Agent A
  2. Agent B
  3. Agent C

并行开发建议：

- 每个 agent 使用独立 worktree 和分支
- Agent A 先冻结 schema 草案，再允许 Agent B 和 Agent C 基于该草案推进
- Agent B 的 benchmark 结果应基于 Agent A 合入后的版本复测一次
- Agent C 的 viewer 增强必须避免阻塞 Agent A 与 Agent B 的后端联调

## 8. 推荐执行顺序

若资源有限，不一定要三路全开。推荐优先级：

1. Agent A
2. Agent B
3. Agent C

原因：

- Agent A 决定系统是否真正开始产生“分析价值”
- Agent B 决定观测覆盖是否完整，并提供性能验收证据
- Agent C 负责把已实现能力转成可用的文档和更顺手的阅读体验

## 9. 当前结论

当前 observability 计划已经完成了 MVP 的主体框架，系统已经从“设计阶段”进入“debug 与分析能力补完阶段”。

下一阶段不应再把重点放在“有没有页面”，而应聚焦：

- 质量信号
- 派生事实
- 路由覆盖完整性
- benchmark 与 README 收尾

换句话说：**平台已经搭起来了，下一步要让它真正会分析。**
