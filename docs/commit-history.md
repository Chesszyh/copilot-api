# Chesszyh <chesszyh987@gmail.com> commit history

## 统计口径

- 全仓库所有 refs：11 个提交，约 +9864 / -572，触及 38 个文件
- 当前分支可达历史：9 个提交，约 +7190 / -277，触及 37 个文件
- 仅在分支 feat/agent-observability-mvp 上的提交（不在当前主线可达历史里）：3dc7929、2022f3f

---

## Chesszyh 的所有提交与修改明细（按时间）

1) a78b00f (2026-03-30)

chore: ignore local worktrees
文件：.gitignore
改动：
- 增加 .worktrees/ 忽略规则；
- 调整 dist/ 结尾换行。

---
2) 3dc7929 (2026-03-30)【分支提交】

feat: add observability capture core（18 files, +1934/-65）
文件：
- src/lib/config.ts, src/lib/paths.ts
- src/lib/observability/{capture,lifecycle,queue,redact,session,storage,types,worker}.ts
- src/routes/{chat-completions/messages/responses}/handler.ts
- src/start.ts
- tests/observability/{capture,queue,redact,storage}.test.ts

核心改动：
- 引入 observability 配置项和默认值（队列容量、批大小、刷盘间隔、保留天数、最大 body 大小）；
- 新增 observability 核心模块：采集、队列、脱敏、存储、生命周期、worker；
- 在三类主路由（chat-completions/messages/responses）注入请求开始/首 token/完成/异常采集；
- 启动流程中挂载 observability lifecycle；
- 增加采集、队列、脱敏、存储单测。

---
3) 2022f3f (2026-03-30)【分支提交】

feat: add observability storage and analytics routes（18 files, +740/-230）
文件：
- src/lib/observability/{capture,lifecycle,queue,redact,session,storage,worker}.ts
- src/routes/messages/handler.ts, src/routes/responses/handler.ts
- src/routes/observability/{pin,sessions,summary}-route.ts
- src/server.ts, src/start.ts
- tests/observability/{capture,queue,routes,storage}.test.ts

核心改动：
- lifecycle 从“仅 drain”升级为“drain 到 storage”，并在 stop 时强制 flush；
- worker 新增持久化逻辑：写 session/request_event/raw artifact，并做 TTL 清理；
- storage 增加 summary/list/detail/pin-unpin 等能力；
- 新增 /observability/summary、/observability/sessions、/observability/pin 路由；
- messages/responses handler 抽取公共 capture 完成逻辑，减少重复分支。

---
4) b9f5422 (2026-03-30)

docs: add agent observability design and mvp plan（4 files, +1678）
文件：
- .gitignore
- docs/2026-03-30-agent-observability-design.md
- docs/2026-03-30-agent-observability-design.zh-CN.md
- docs/2026-03-30-agent-observability-mvp-plan.zh-CN.md

改动：
- 新增 observability 设计文档与 MVP 计划（中英）；
- .gitignore 增加 wiki/。

---
5) 75fda15 (2026-03-30)【主线落地】

feat: add observability storage and analytics routes（20 files, +2440/-139）
文件：
- src/lib/observability/{capture,lifecycle,queue,redact,session,storage,types,worker}.ts（新增）
- src/routes/messages/handler.ts, src/routes/responses/handler.ts
- src/routes/observability/{pin,sessions,summary}-route.ts（新增）
- src/server.ts, src/start.ts
- tests/observability/{capture,queue,redact,routes,storage}.test.ts（新增）

核心改动：
- 在主线一次性引入 observability 模块与 analytics API；
- messages/responses 流式与非流式路径都接入采集闭环；
- server 挂载 observability 相关路由；
- start 阶段初始化 lifecycle。

---
6) 4c82184 (2026-03-30)

feat: add observability config and storage paths（2 files, +36）
文件：src/lib/config.ts, src/lib/paths.ts
改动：
- ObservabilityConfig 接口及默认配置正式补齐；
- PATHS 新增 observability 目录、raw/pinned 子目录、sqlite db 路径；
- ensurePaths() 创建 observability 目录结构。

---
7) 75b009a (2026-03-30)

docs: add observability user manual（1 file, +417）
文件：docs/2026-03-30-agent-observability-user-manual.zh-CN.md
改动：新增中文用户手册。

---
8) 9404a08 (2026-03-30)

feat: add observability viewer and mock tooling（17 files, +2097/-3）
文件：
- pages/observability-viewer.html（新增）
- src/lib/config.ts
- src/lib/observability/{mock,session,storage,types}.ts
- src/lib/request-auth.ts
- src/routes/observability/{mock,viewer}-route.ts（新增）
- src/server.ts, src/start.ts
- docs/2026-03-30-observability-viewer-and-mock-design.zh-CN.md
- tests/observability/{mock-generator,mock-routes,viewer-route,storage}.test.ts
- tests/request-auth.test.ts

核心改动：
- 新增 observability viewer 页面与路由；
- 新增 mock 数据生成器（coverage/realistic 预设、可重置）；
- storage schema 扩展 source/scenario，并加 mock 数据清理能力；
- auth 中允许未认证路径支持通配符匹配；
- 启动日志展示 observability viewer 入口。

---
9) f484042 (2026-03-30)

feat: improve observability json viewing（2 files, +323/-2）
文件：pages/observability-viewer.html, tests/observability/viewer-route.test.ts
改动：
- viewer 增加 JSON 面板、树形展示、下载 JSON、复制内容、复制路径等交互；
- 对应测试断言更新。

---
10) dbf7a52 (2026-03-31)

Merge branch 'all' ... into all（14 files, +559/-27）
文件：
- .gitignore, CLAUDE.md, bun.lock, package.json
- docs/2026-03-30-ratelimit-analysis.zh-CN.md
- opencode.json（删除）
- src/lib/{api-config,config,deviceid,request-context,trace}.ts
- src/routes/messages/{count-tokens-handler,handler}.ts
- src/types/winreg.d.ts

说明：
- 这是合并提交，主要把远端 all 变更并入本地；
- 记录显示有冲突点在 src/routes/messages/handler.ts，并完成冲突解决；
- .gitignore 合并后包含 .worktrees/、wiki/、/examples 等条目。

---
11) 61ed19f (2026-03-31)

feat: improve observability source view（2 files, +195/-132）
文件：pages/observability-viewer.html, tests/observability/viewer-route.test.ts
改动：
- JSON 展示从树结构升级为“源码视图”：行号、语法高亮、结构提示 chip；
- 增加对 fenced/double-encoded JSON 的解析（unwrapJsonString）；
- 更新 viewer route 测试断言（含“源码视图”）。

---
当前代码中的关键落点（可直接定位）

- observability 配置：src/lib/config.ts:26, src/lib/config.ts:304
- observability 采集：src/lib/observability/capture.ts:34, src/lib/observability/capture.ts:83, src/lib/observability/capture.ts:128
- 持久化存储：src/lib/observability/storage.ts:156, src/lib/observability/storage.ts:863, src/lib/observability/storage.ts:919,
src/lib/observability/storage.ts:963
- 生命周期与刷盘：src/lib/observability/lifecycle.ts:12, src/lib/observability/worker.ts:109
- observability 路由：src/routes/observability/summary-route.ts:9, src/routes/observability/sessions-route.ts:10,
src/routes/observability/pin-route.ts:9, src/routes/observability/mock-route.ts:29, src/routes/observability/viewer-route.ts:30
- auth 通配路径匹配：src/lib/request-auth.ts:73
- viewer 源码视图核心：pages/observability-viewer.html:1029, pages/observability-viewer.html:1150, pages/observability-viewer.html:1160,
pages/observability-viewer.html:1220
- server 挂载与免认证路径：src/server.ts:37, src/server.ts:71

如果你要，我可以下一步给你导出一份“每个 commit 的完整文件级 diff 清单（A/M/D + 每文件增删行）”版本。