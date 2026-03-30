# Agent 可观测性设计

## 概述

本文档为 `copilot-api` 设计一套本地可观测性系统，核心关注点是：

- 用户与会话行为分析
- Prompt / Agent 质量分析
- 成本与配额分析作为次重点
- 性能与稳定性分析作为次重点

该系统必须保证现有代理的中转性能不下降，最好还能在部分场景下带来轻微优化。因此它被设计为同进程内的旁路观测层：请求主链只做极轻量采集，脱敏、摘要、聚合、评分、持久化全部异步完成。

## 目标

- 第一阶段优先服务单个高频使用者的本地分析需求。
- 设计上保留未来扩展到多用户面板的可能性。
- 同时支持请求级与会话级分析，但以会话分析为主。
- 默认只保存脱敏后的摘要与结构化元数据。
- 原始请求与响应正文默认只保留最近 3 天。
- 支持对指定会话或请求执行手动永久留存。
- 不引入代理延迟、吞吐、内存行为上的可感知回退。

## 非目标

- 替代 GitHub 上游配额接口。
- 在第一阶段引入多租户鉴权、计费、权限体系。
- 在 MVP 中做复杂的“语义正确性”自动评估。
- 在请求主链中接入同步的外部 SaaS tracing / analytics。
- 在 MVP 中建设分布式实时遥测基础设施。

## 当前项目上下文

当前仓库已经具备一些适合作为可观测性基础的能力：

- `messages`、`responses`、`chat.completions` 三条主要请求入口
- 按 handler 输出的本地日志
- 基于 async local storage 的 `trace_id`
- 较稳定的 request / session 标识生成逻辑
- 来自 GitHub 上游 `copilot_internal/user` 的配额查询能力

当前缺少的是一套专门面向分析的本地事件模型。现有日志更适合排错，不适合作为结构化分析数据源。

## 现成外部轮子

业界已经有几类和 LLM / agent 可观测性相关的通用框架值得参考：

- OpenTelemetry 的 GenAI 与 agent span 语义约定
- Langfuse 的 tracing 与 prompt 管理能力
- Arize Phoenix 的 tracing 与 eval 工作流

这些框架对字段命名、事件语义、未来兼容性很有帮助，但它们并不能直接解决本仓库的核心约束：在 Bun 代理内实现一套贴近 coding agent 工作流、又不会拖慢主链的本地分析系统。

## 设计原则

### 1. 可观测性必须是旁路，而不是主链功能

代理的主职责仍然是接收请求、转换协议、转发到 Copilot、返回结果。观测系统只能观察这个生命周期，不能要求主链等待统计、落盘、脱敏、摘要、聚合完成。

### 2. 事实与推断必须分离

像延迟、token、重试次数、工具调用次数这类直接可测的内容，应与“本次 agent 表现差”“这个 prompt 不稳定”这类推断型结论明确分开。

### 3. 会话优先，请求落地

产品层面最重要的是会话视角；数据落地层面最稳定的事实单位仍然是具体 HTTP 请求。会话分析应建立在请求事件归并之上。

### 4. 默认安全留存

默认只保存脱敏摘要和结构化元数据。原始正文默认保留 3 天，之后清除；只有手动 pin 的内容才长期保留。

### 5. 压力下优雅降级

当队列、worker、存储出现压力时，应优先丢弃详细观测，而不是影响请求转发。

## 产品范围

### 主系统

- 会话行为分析系统
- Prompt / Agent 质量分析系统

### 次系统

- 成本与配额分析系统
- 性能与稳定性分析系统

## 已讨论的方案方向

### 方案 A：行为分析优先

重点关注会话完成率、放弃率、重试链路、工具路径、用户接管点。

优点：

- 最快产生有用结果
- 与单用户 coding agent 场景高度贴合
- 解释成本低

缺点：

- 对 prompt 质量的判断较间接

### 方案 B：质量分析优先

重点关注 prompt 模板对比、工具选择质量、回答后重试、agent 路径质量。

优点：

- 直接服务于 prompt 和 agent 调优

缺点：

- 需要更早建立推断规则
- 第一阶段更难做稳

### 方案 C：双层分析系统

以一套共享事件管线为底层，同时提供两种主视角：

- 行为分析
- 质量分析

成本和性能作为辅助维度。

优点：

- 长期结构最合理
- 避免重复建设
- 最符合当前目标

缺点：

- 必须严格收缩 MVP，不能一开始做太大

### 推荐结论

采用方案 C，但执行顺序上遵循“行为优先，质量跟进”。也就是说，从一开始就设计能同时支持行为和质量分析的底层事件模型，但第一阶段先做可靠、可解释的行为与效率信号，而不是急着做复杂语义评分。

## 核心数据模型

MVP 推荐先落地三类实体和一层派生事实。

### `session`

表示一段工作会话，是最主要的分析单位。

关键字段：

- `session_id`
- `root_trace_id`
- `user_id` 或匿名主体标识
- `client_type`
- `started_at`
- `ended_at`
- `status`
- `pinned`

可选派生字段：

- `session_effectiveness_score`
- `final_outcome_label`

### `request_event`

表示一次进入代理的实际请求。

关键字段：

- `request_id`
- `session_id`
- `trace_id`
- `route_type`
- `model`
- `stream`
- `request_started_at`
- `first_token_at`
- `request_finished_at`
- `status_code`
- `error_type`
- `input_tokens`
- `output_tokens`
- `cached_tokens`
- `reasoning_tokens`
- `raw_payload_ref`
- `sanitized_payload`
- `sanitized_response`

### `tool_event`

表示一次工具调用或工具调用链。

关键字段：

- `tool_event_id`
- `session_id`
- `request_id`
- `tool_name`
- `tool_type`
- `arguments_summary`
- `started_at`
- `finished_at`
- `success`
- `retry_of`
- `output_summary`
- `is_redundant_call`
- `is_recovery_call`

### `analysis_fact`

用于快速查询的派生指标。

示例字段：

- `wasted_token_ratio`
- `detour_ratio`
- `first_useful_output_ms`
- `retry_after_answer_rate`
- `user_correction_rate`
- `redundant_tool_call_rate`
- `high_reasoning_low_outcome_rate`

## 为什么暂不引入 `turn`

`turn` 当然有价值，但 MVP 不必一开始就落实体。当前代理已经天然以 HTTP 请求为边界，同时具备较好的 session 归并基础。第一版以 request 为事实源、session 为主要视角，已经足够覆盖大部分需求。未来如果请求聚类逻辑更稳定，再把 `turn` 提升为独立实体更合适。

## 数据留存模型

### 默认留存

- 结构化元数据：按策略长期保留或定期清理
- 脱敏后的请求 / 响应摘要：默认保留
- 原始正文：默认保留 3 天

### 永久留存

- 允许手动 pin 指定会话或请求
- 被 pin 的原始内容移动或复制到长期目录

### 存储拆分

- SQLite 保存结构化事件和聚合事实
- 短期原文目录保存最近 3 天内容
- 长期目录保存永久 pin 的内容

## 分析系统视图

### 1. 会话行为分析

主要回答：

- 哪类会话最终完成了任务，哪类没有？
- 哪些会话最容易被放弃、中断、重试？
- 哪些任务类型消耗了最多的请求和工具调用？
- 用户最常在哪个阶段开始手动接管？
- 哪些会话包含明显重复劳动？

核心指标：

- completion rate
- abandonment rate
- average requests per session
- average tools per session
- interruption rate
- repeated-session pattern rate

### 2. Prompt / Agent 质量分析

主要回答：

- 哪类 prompt 模式最容易触发重试或纠正？
- 哪类 agent 路径明显在过度探索？
- 哪些工具被冗余调用？
- 哪些请求 reasoning 成本很高但结果很差？
- 哪些回答会立刻引发后续纠正？

核心指标：

- retry-after-answer rate
- user correction rate
- redundant tool call rate
- over-exploration rate
- high-reasoning low-outcome rate
- completion-without-followup rate

### 3. 成本与配额分析

主要回答：

- 哪些任务类型最贵？
- 被放弃或失败的会话消耗了多少成本？
- prompt cache 是否真的带来收益？
- 一次成功完成会话的平均 token / premium 成本是多少？

核心指标：

- tokens per completed session
- wasted token ratio
- cached token ratio
- premium-associated request distribution

### 4. 性能与稳定性分析

主要回答：

- 哪些模型或路由有最长尾延迟？
- 从请求开始到首个“有效输出”要多久？
- 哪些 stream 经常中途失败？
- 哪些工具链路最拖慢整体体验？

核心指标：

- latency p50/p95/p99
- time to first byte
- time to first useful output
- stream failure rate
- tool latency distribution

## 指标分层

### 第 1 层：事实指标

例如：

- 延迟
- token 数
- 请求数
- 工具调用数
- 重试次数
- compact 次数
- 模型切换次数
- 状态码

### 第 2 层：效率指标

例如：

- token throughput
- cache benefit ratio
- reasoning cost ratio
- cost per successful session
- detour ratio
- wasted token ratio

### 第 3 层：质量信号

例如：

- `user_correction_signal`
- `redundant_tool_signal`
- `over_exploration_signal`
- `high_reasoning_low_outcome_signal`
- `manual_takeover_signal`
- `strong_completion_signal`

### 第 4 层：可解释评分

MVP 可以提供评分，但必须是可解释的组合分数：

- `session_effectiveness_score`
- `agent_efficiency_score`
- `prompt_stability_score`
- `overall_quality_score`

每个分数都必须能追溯到参与计算的事实指标和质量信号。

## MVP 范围

MVP 应回答 4 个关键问题：

1. 哪些会话完成了，哪些没有？
2. 哪些 agent 路径明显在浪费时间或重复劳动？
3. 哪些工具调用是冗余的？
4. token 成本和延迟主要积累在哪些地方？

### 在范围内

- 请求路径上的轻量采集
- 异步 worker 处理
- SQLite 结构化存储
- 3 天原文留存
- 手动 pin 留存机制
- 会话总览
- 会话详情
- 质量诊断视图
- 成本 / 延迟侧视图

### 不在范围内

- 基于模型的复杂语义质量评估
- 对全量历史做向量检索
- 完整多租户权限体系
- 分布式消息队列
- 实时推送式仪表盘
- 在关键路径中依赖第三方 SaaS

## 落地架构

建议拆成六个模块，边界必须清晰。

### `capture`

同步、请求路径安全的采集层。

职责：

- 创建最小事件壳
- 记录请求生命周期时间点
- 将轻量事件放入队列

禁止做：

- 脱敏
- 摘要
- 存储
- 评分

### `event-queue`

进程内有界队列，用来解耦主链与观测处理。

要求：

- 容量有上限
- 支持批量消费
- 压力下可降级
- 能统计丢弃事件数

### `processor`

异步事件处理流水线。

建议阶段：

- normalize
- redact
- summarize
- extract
- score
- persist

### `storage`

负责结构化数据与原文的统一持久化。

目标：

- SQLite 数据库
- 短期原文目录
- 长期 pin 目录

### `analysis`

负责在线事实计算与周期聚合，不直接参与主链采集。

### `viewer/api`

负责暴露只读接口，用于：

- 上游 GitHub 配额查看
- 本地可观测性汇总
- 单会话详情
- 单请求详情

## 性能约束

这是实现中的硬要求。

### 请求路径预算

- 新增同步开销目标：`p50 < 1ms`
- 新增同步开销目标：`p95 < 3ms`

### Stream 处理

- 不做逐 chunk 深处理
- chunk 路径上只允许极轻量计数
- 响应正文拼装和分析必须在 stream 完成或失败后异步进行

### 队列降级策略

系统压力上升时：

1. 先丢弃详细正文采集
2. 保留最小结构化事件
3. 无论如何不能阻塞请求转发

### 存储策略

- 禁止在主链同步写 SQLite
- 禁止在主链同步写原文文件
- 所有持久化都必须批量异步执行

### 内存控制

必须限制：

- 单请求正文缓存上限
- 单 stream 拼装缓冲上限
- 单 session 待刷写事件上限
- 队列积压上限

## 现有性能机会

当前代码中已经存在一些 debug / verbose 路径下的 payload 序列化与 chunk 日志开销。如果后续把结构化观测做成统一通道，有机会减少重复 stringify 和重复日志拼接。因此观测系统不一定只是“新增成本”，在某些运行模式下还有机会降低冗余开销。

## 验证与基准测试

如果没有基准测试，就不能宣称“性能不变”。

最低验证要求：

- 对比 observability 关闭与开启的结果
- 覆盖 `messages`、`responses`、`chat.completions`
- 同时覆盖 streaming 与 non-streaming
- 观察：
  - RPS
  - p50/p95/p99 latency
  - RSS 内存
  - event loop lag
  - GC 行为
  - queue backlog
  - dropped event counts

## 推荐文档集

本设计确认后，后续实施阶段建议继续补三份文档：

- `docs/observability-data-model.md`
- `docs/observability-mvp-plan.md`
- `docs/observability-benchmarks.md`

当前文档作为总设计入口。

## 推荐实施顺序

1. 增加最小化 capture 抽象与有界队列。
2. 先持久化最小结构化请求事实。
3. 增加原文短期留存、过期删除与 pin 机制。
4. 实现 session 聚合。
5. 增加基于规则的质量信号。
6. 增加本地 analytics 接口与页面。
7. 增加基准测试与性能回归检查。

## 风险

### 1. 请求路径隐藏开销

缓解：

- 让主链采集保持极浅
- 每个阶段都做前后压测

### 2. 长 stream 导致内存膨胀

缓解：

- 为缓冲设置硬上限
- 超限后截断采集

### 3. 评分体系过度复杂

缓解：

- 第一版只做显式规则信号
- 延后语义评估

### 4. 敏感数据留存风险

缓解：

- 默认脱敏
- 原文只保留 3 天
- 永久留存必须显式 pin

### 5. 分析范围蔓延

缓解：

- MVP 锁定行为分析与质量诊断
- 成本与性能只做辅助视图

## 决策摘要

当前推荐方案是：

- 在本仓库内实现一套本地旁路可观测性层
- 以会话行为分析和 Prompt / Agent 质量分析为主
- 通过异步队列与后台 worker 保证主链性能
- 默认只保存脱敏元数据和摘要
- 原始正文保留 3 天，并支持手动永久 pin
- 在字段命名上尽量向现有 agent observability 语义约定靠拢

这套设计是刻意以“本地优先、性能优先、MVP 可控”为中心收缩出来的，以适配 `copilot-api` 当前真实的运行条件。
