# Meeting Agent · 智能会议纪要 Agent（48h MVP）

上传会议音频或直接在会中录音 → 实时/离线 ASR 转写 → 声纹识别说话人 → Agent 编排生成结构化纪要 → **每条结论可回溯到原话**。

> 这是「48 小时时间盒内的可演示 MVP」，不是生产系统。
> 范围合同见 `../meeting-agent-demo/docs/02-mvp-scope.md`，架构说明见 `../meeting-agent-demo/docs/01-architecture.md`。

---

## 现在的状态

- ✅ **142 项测试全通过**（`pnpm test:all`）
- ✅ 生产构建通过（`pnpm build`）
- ✅ 全链路可在 `MOCK_LLM=1` 下离线跑通，不依赖任何外部服务
- ✅ 真实 ASR / 声纹 / 语义检索 / 模型四条外部依赖均已接入，填 `.env` 即可切换

### 三个曾经是 backlog、现已实现的能力

| 能力 | 说明 | issue |
|---|---|---|
| **真实 ASR** | 支持 OpenAI（whisper 系）与 FunASR 两种上游，失败可降级 | #22 |
| **声纹识别** | 注册声纹后自动认领说话人，认不出标「待复核」而非硬猜 | #23 |
| **语义检索** | 关键词 + 向量 RRF 混合召回 | #25 |
| **实时流式** | 会中边说边出转写与增量纪要，结束后合并成正式纪要 | #26 |

每个 issue 的完整设计、验收标准、踩坑记录都在 [`docs/issues/`](docs/issues/)，
issue → 代码 → 测试的追溯表见 [`docs/TRACEABILITY.md`](docs/TRACEABILITY.md)。

## 5 分钟跑起来

```bash
pnpm install

# 若 prisma 引擎下载被墙：
#   $env:PRISMA_ENGINES_MIRROR="https://registry.npmmirror.com/-/binary/prisma"

cp .env.example .env
pnpm db:push          # 建表
pnpm db:seed          # 种入 3 个角色用户 + 1 场待处理会议 + 1 场历史会议
pnpm dev              # http://localhost:3000
```

打开首页，右上角点 **张伟（owner）** 登录 → 打开「会议纪要功能上线节奏对齐」→ 点 **生成纪要**。

### 环境变量

**必填**

| 变量 | 说明 | 默认 |
|---|---|---|
| `DATABASE_URL` | SQLite 路径 | `file:./dev.db` |
| `MOCK_LLM` | `1` = 不调真实模型，走确定性输出（**演示兜底**） | `1` |

**LLM（`MOCK_LLM=0` 时必须）**

| 变量 | 说明 |
|---|---|
| `LLM_BASE_URL` | 任意 OpenAI 兼容网关 |
| `LLM_API_KEY` | 网关 Key |
| `LLM_MODEL` | 模型名 |

**ASR（`ASR_PROVIDER=real` 时必须）**

| 变量 | 说明 | 示例 |
|---|---|---|
| `ASR_PROVIDER` | `mock` 用预置转写；`real` 调外部服务 | `real` |
| `ASR_KIND` | `openai` 或 `funasr` | `openai` |
| `ASR_BASE_URL` | 上游地址 | `http://127.0.0.1:8080/v1` |
| `ASR_API_KEY` | 上游 Key（可选） | |
| `ASR_MODEL` | 模型名 | `whisper-1` |
| `ASR_FALLBACK_TO_MOCK` | `1` = 失败自动降级预置转写 | `0` |

**声纹（可选，不配则用离线确定性伪向量）**

| 变量 | 说明 |
|---|---|
| `VOICEPRINT_BASE_URL` | 声纹服务地址（`POST /embed`） |
| `VOICEPRINT_THRESHOLD` | 判定同一人的余弦阈值，默认 `0.72` |
| `VOICEPRINT_DIM` | 向量维度，默认 `192` |
| `VOICEPRINT_ENABLED` | `0` 可关闭声纹，退回标签映射 |

**语义检索（可选，不配则用 bigram 哈希兜底）**

| 变量 | 说明 |
|---|---|
| `EMBEDDING_PROVIDER` | `http` 使用外部 embedding 服务 |
| `EMBEDDING_BASE_URL` | OpenAI 兼容 `/embeddings` 地址 |
| `EMBEDDING_MODEL` | 模型名 |
| `SEMANTIC_SEARCH` | `0` 关闭语义，退回纯关键词 |

> **演示建议**：现场保持 `MOCK_LLM=1` + `ASR_PROVIDER=mock`，完全离线。
> 真实模型输出不稳定，结构化校验连续失败 3 次会进 `FAILED`，对现场是风险。

---

## 验证

```bash
pnpm test:all          # 142 项断言，一次跑全部
pnpm smoke             # 纯后端链路冒烟（不启动 UI）
pnpm e2e               # 主链路端到端（需先 build + start -p 3210）
pnpm fake:asr          # 起一个本地假 ASR 服务，无外部依赖验证真实 ASR 链路
```

| 套件 | 断言 | 覆盖 |
|---|---|---|
| `pnpm e2e` | 20 | 登录/RBAC/上传/状态机/SSE/纪要/追问/防编造 |
| `pnpm test:asr` | 13 | 两种 ASR 上游格式、时间换算、错误、降级 |
| `pnpm test:voice` | 18 | 聚类、身份认领、标签合并、边界 |
| `pnpm test:rag` | 16 | 分词、召回、RRF、租户隔离、幂等、防幻觉 |
| `pnpm test:live` | 23 | 跨片拼接、增量去重、规则抽取 |
| `pnpm e2e:live` | 24 | 分片上传 → 实时 SSE → 增量纪要 → 结束合并 |
| `pnpm e2e:asr` | 8 | 上传音频 → 真实 ASR → 入库 → 纪要 |
| `pnpm e2e:voice` | 20 | 注册声纹 → 会议聚类 → 删除 |

| 组 | 断言 |
|---|---|
| 登录与 RBAC | owner 登录、viewer 创建会议被拒(403)、viewer 触发 Agent 被拒(403)、viewer 编辑纪要被拒(403) |
| Agent 编排 | SSE 建立、5 个阶段顺序正确、6 类工具调用事件、收到 done |
| 纪要质量 | 页面渲染、决议/待办/风险分区、引用按钮、转写气泡 |
| 记忆追问 | 追问可用、命中历史并带引用、无命中时不编造 |

---

## 演示脚本（9 步）

| 步骤 | 操作 | 对应设计 |
|---|---|---|
| 1 | owner 登录 | RBAC 第 1 层 |
| 2 | 新建会议（可传音频，也可不传） | 上传与异步任务 |
| 3 | 打开会议详情 | 转写气泡按人分色 |
| 4 | 点「生成纪要」 | 状态机 + SSE 实时可见 |
| 5 | 观察运行视图 | 阶段推进 + 工具调用 + 摘要流 |
| 6 | 看纪要页 | 概述 / 决议 / 待办 / 风险 |
| 7 | 点 `#引用` | 跳回原话并高亮（反幻觉的可见证据） |
| 8 | 编辑待办负责人 | 字段级编辑 + 审计日志 |
| 9 | 切 viewer 再试 | 被拒；跨会议追问带引用 |

---

## 代码结构与 issue 对应

| 目录 / 文件 | 对应 issue | 说明 |
|---|---|---|
| `prisma/schema.prisma` | #3 | 权威数据源，15 张表（含声纹库与向量索引） |
| `prisma/seed.ts` | #3 | 1 租户 / 3 角色 / 2 场会议 |
| `lib/auth/rbac.ts` | #4 | 第 1 层：角色能力矩阵 + 工具白名单（硬编码） |
| `lib/auth/session.ts` `guard.ts` | #4 | 第 0/1 层：身份与统一守卫 |
| `lib/db/scoped.ts` | #4 | 第 3 层：强制 `tenant_id` 过滤 |
| `lib/agent/runtime.ts` | #6 | pi-agent-core `Agent` + 工具注册 + `beforeToolCall` 闸门 |
| `lib/llm.ts` | #6 | 自定义 OpenAI 兼容 provider（换网关只改 env） |
| `lib/asr/index.ts` | #5 #7 #8 | 上传链路、话轮合并、统一入口与降级 |
| `lib/asr/real.ts` | **#22** | 真实 ASR：OpenAI / FunASR 两种上游适配器 |
| `lib/voice/cluster.ts` | **#23** | 声纹聚类：余弦 + 阈值，不预设簇数 |
| `lib/voice/embedder.ts` | **#23** | 声纹提取（HTTP 服务 + 离线确定性兜底） |
| `lib/rag/embedding.ts` | **#25** | 文本向量化（HTTP embedding + bigram 哈希兜底） |
| `lib/rag/retriever.ts` | **#25** | RRF 混合召回 + 相关性闸门 |
| `lib/agent/pipeline.ts` | #9 #12 #13 #15 | 六态状态机、摘要、结构化抽取、记忆沉淀、建索引 |
| `lib/tools/index.ts` | #7 #13 #16 #25 | 工具实现；`save_minutes` 是**唯一写库路径** |
| `lib/context/governance.ts` | #12 | `transformContext` / `convertToLlm` |
| `lib/memory/store.ts` | #15 | `MemoryStore` 接口（可替换 mem0） |
| `lib/events.ts` | #11 | 事件总线，支持重连回放 |
| `app/api/meetings/[id]/stream` | #11 | SSE |
| `app/api/voiceprints` | **#23** | 声纹注册 / 列表 / 删除 |
| `components/*` | #10 #14 | 转写气泡、纪要视图、运行视图、声纹面板 |
| `app/api/ask` | #16 | 跨会议单轮追问 |

---

## 实现里做对的几个点（二面可讲）

1. **模型不能直接写库**：全局只有 `saveMinutes()` 一处写纪要表，且强制带 `source_turn_id`，
   写入前过 Schema 校验；校验失败最多修 3 次，仍失败则进 `FAILED` 并保留中间产物。
2. **摘要只是索引**：原始话轮永久保留，摘要带 `turnRefs`，前端点引用可回跳原话。
3. **三层权限都能演示**：路由 403 → 工具闸门 → 查询强制 `tenant_id`。
4. **断线可恢复**：SSE 重连时事件总线回放历史事件。
5. **演示不依赖外网**：`MOCK_LLM=1` + `ASR_PROVIDER=mock` + 声纹/检索离线兜底，全离线。
6. **宁可标未知，也不硬猜**：说话人认不出时标「未知参会者 + 待复核」，
   检索无相关时不召回。会议纪要的价值在可信，不在覆盖率。
7. **降级必须可见**：真实 ASR 失败降级到预置转写时，事件流里发一条告警，不静默替换。

## 踩过的坑（写进 README 免得后面再踩）

- **`@mariozechner/pi-agent-core` 已废弃**，必须用 `@earendil-works/pi-agent-core@1.5.2`。
- **pi-ai 只导出 `import` 条件**（ESM-only），在 tsx/CJS 脚本里静态 `import` 会报
  `ERR_PACKAGE_PATH_NOT_EXPORTED`；本项目统一改成运行时动态 `import()`。
- **provider 工厂不接受 baseUrl 参数**：换网关要用 `createProvider({ baseUrl, models })` +
  自定义 model 条目。
- **SSE 心跳必须处理客户端断开**，否则 `controller.enqueue` 抛 `ERR_INVALID_STATE` 直接让进程崩溃。
- **话轮合并会把整场会议压成一条**：whisper 无说话人信息时全是 `speaker_0`，
  必须只合并「短句碎片」，完整句保持独立。
- **向量相似度无法区分相关/无关**：实测「今天天气」0.178 vs「存储怎么处理」0.200，
  任何单一阈值都会错判；必须结合关键词是否命中做闸门。
- **`centroid([...JSON.parse(emb), new])` 是错的**：`JSON.parse` 返回一个向量，
  展开成一堆数字而非「向量数组」，正确写法是 `centroid([prev, new])` 并校验维度。
- **Prisma 引擎下载**在国内网络需要设 `PRISMA_ENGINES_MIRROR`。

## 已知缺陷

1. **实时是「准实时」不是「字级实时」**：分片 4 秒 + ASR 往返，实际延迟约 4~8 秒；真正的低延迟需要 WebSocket 音频流（架构已预留，见 `lib/live/` 的 session 抽象）
2. **声纹依赖外部服务**：不配 `VOICEPRINT_BASE_URL` 时用确定性伪向量，
   它能验证链路但**不是真声纹**，换了设备/录音就失效
3. **语义检索用了兜底向量**：不配 `EMBEDDING_BASE_URL` 时是 bigram 哈希，
   对「换一种说法」的召回能力有限；配了真实 embedding 才有真正的语义能力
4. **相关性闸门偏保守**：无关键词命中时宁可不召回，牺牲了部分召回率换可信度
5. **记忆是轻量实现**，非 mem0（backlog #24）
6. **权限只到租户 + 角色**：无字段级脱敏、无会议级可见性（#29）
7. **索引为全量加载**：几万条以内无感，量上来需要换 pgvector（backlog #25 的后续）

## 下一步

- WebSocket 音频流（把当前的 4 秒分片降到亚秒级延迟）
- 接入真实声纹服务（ECAPA-TDNN）与真实 embedding 服务
- pgvector 替换内存余弦
- 待办同步飞书 / GitHub Issue
- 用 10 场真实会议做评估集回归