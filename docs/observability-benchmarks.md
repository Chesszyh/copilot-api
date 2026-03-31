# Observability Benchmarks

## 1. 目标

本文件用于验证 observability 在开启后不会对主链路产生明显性能回退，并为后续版本提供可复现的对比基线。

覆盖范围：

- `messages`
- `responses`
- `chat.completions`
- streaming / non-streaming

## 2. 测试环境记录

每次压测前先记录以下信息：

- 日期与提交：`git rev-parse --short HEAD`
- OS / Kernel
- CPU / 内存
- Bun 版本：`bun --version`
- 运行命令（含端口、是否 `--proxy-env`）
- `config.json` 里 observability 关键配置：
  - `enabled`
  - `queueCapacity`
  - `batchSize`
  - `flushIntervalMs`
  - `maxBodyBytes`

建议保存为如下模板：

```text
Date:
Commit:
Host:
CPU:
Memory:
Bun:
Start command:
Observability config:
```

## 3. off/on 对比方法

### 3.1 关闭 observability（baseline）

`config.json`:

```json
{
  "observability": {
    "enabled": false
  }
}
```

启动：

```bash
bun run ./src/main.ts start --port 4141
```

### 3.2 开启 observability

`config.json`:

```json
{
  "observability": {
    "enabled": true
  }
}
```

启动：

```bash
bun run ./src/main.ts start --port 4141
```

### 3.3 测试原则

- off/on 使用同一台机器、同一份请求数据
- 每个场景至少跑 3 轮，记录中位结果
- 每轮前先 warmup（例如 10 秒）
- 场景执行顺序建议固定，降低环境抖动影响

## 4. 推荐压测命令

> 以下命令以 `autocannon` 为例（通过 `bunx` 调用）。

### 4.1 chat.completions（non-stream）

```bash
bunx autocannon -c 10 -d 30 -m POST \
  -H "content-type: application/json" \
  -b '{"model":"gpt-5-mini","stream":false,"messages":[{"role":"user","content":"Say hi"}]}' \
  http://127.0.0.1:4141/v1/chat/completions
```

### 4.2 chat.completions（stream）

```bash
bunx autocannon -c 10 -d 30 -m POST \
  -H "content-type: application/json" \
  -b '{"model":"gpt-5-mini","stream":true,"messages":[{"role":"user","content":"Count from 1 to 5"}]}' \
  http://127.0.0.1:4141/v1/chat/completions
```

### 4.3 messages（non-stream）

```bash
bunx autocannon -c 10 -d 30 -m POST \
  -H "content-type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -b '{"model":"claude-3-5-sonnet","stream":false,"max_tokens":128,"messages":[{"role":"user","content":"Say hi"}]}' \
  http://127.0.0.1:4141/v1/messages
```

### 4.4 messages（stream）

```bash
bunx autocannon -c 10 -d 30 -m POST \
  -H "content-type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -b '{"model":"claude-3-5-sonnet","stream":true,"max_tokens":128,"messages":[{"role":"user","content":"Count from 1 to 5"}]}' \
  http://127.0.0.1:4141/v1/messages
```

### 4.5 responses（non-stream）

```bash
bunx autocannon -c 10 -d 30 -m POST \
  -H "content-type: application/json" \
  -b '{"model":"gpt-5-mini","stream":false,"input":"Say hi"}' \
  http://127.0.0.1:4141/v1/responses
```

### 4.6 responses（stream）

```bash
bunx autocannon -c 10 -d 30 -m POST \
  -H "content-type: application/json" \
  -b '{"model":"gpt-5-mini","stream":true,"input":"Count from 1 to 5"}' \
  http://127.0.0.1:4141/v1/responses
```

## 5. 观测项采集建议

每个场景（off/on）至少记录：

- p50 / p95 / p99 latency
- RPS
- RSS（MB）
- queue backlog（峰值）
- dropped events（droppedDetailed / droppedMinimal）

其中：

- latency / RPS：来自 `autocannon` 输出
- RSS：可用 `ps` 采样（示例）
  - `ps -o pid=,rss=,command= -p <server_pid>`
- backlog / dropped：建议在压测窗口内从队列统计采样并记录峰值

## 6. 结果记录模板

```markdown
## Benchmark Run - <date>

Environment:
- Commit: <sha>
- Bun: <version>
- Host: <cpu/memory/os>

| Scenario | Obs Enabled | p50 (ms) | p95 (ms) | p99 (ms) | RPS | RSS (MB) | Backlog Peak | droppedDetailed | droppedMinimal | Notes |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| chat.completions non-stream | off |  |  |  |  |  |  |  |  |  |
| chat.completions non-stream | on  |  |  |  |  |  |  |  |  |  |
| chat.completions stream     | off |  |  |  |  |  |  |  |  |  |
| chat.completions stream     | on  |  |  |  |  |  |  |  |  |  |
| messages non-stream         | off |  |  |  |  |  |  |  |  |  |
| messages non-stream         | on  |  |  |  |  |  |  |  |  |  |
| messages stream             | off |  |  |  |  |  |  |  |  |  |
| messages stream             | on  |  |  |  |  |  |  |  |  |  |
| responses non-stream        | off |  |  |  |  |  |  |  |  |  |
| responses non-stream        | on  |  |  |  |  |  |  |  |  |  |
| responses stream            | off |  |  |  |  |  |  |  |  |  |
| responses stream            | on  |  |  |  |  |  |  |  |  |  |
```

## 7. 验收建议

- 主链路延迟回退不应显著（重点看 p95/p99）
- 若 backlog 峰值持续升高或 dropped events 持续增加，需要先调 `queueCapacity/batchSize/flushIntervalMs` 再评估
- `messages / responses / chat.completions` 三条链路均需给出 off/on 对照数据
