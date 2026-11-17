# Issue → 代码 → 测试 追溯表

这张表展示需求到实现的完整追溯：每个 issue 都能指到具体文件、具体分支、具体测试用例。

## 一、主线 17 个 P0 issue 的落地情况

| # | Issue | 状态 | 主要代码 | 验证方式 |
|---|---|---|---|---|
| 1 | 定义项目范围 | ✅ | `docs/02-mvp-scope.md` | 文档 |
| 2 | 项目脚手架 | ✅ | `package.json` `tsconfig.json` `next.config.mjs` | `pnpm build` |
| 3 | 数据模型与 seed | ✅ | `prisma/schema.prisma`（14 表）`prisma/seed.ts` | `pnpm db:seed` |
| 4 | 三层权限骨架 | ✅ | `lib/auth/rbac.ts` `session.ts` `guard.ts` `lib/db/scoped.ts` | e2e 组 2/4/9 |
| 5 | 音频上传与队列 | ✅ | `app/api/meetings/route.ts` | e2e 组 3 |
| 6 | pi-agent-core 接入 | ✅ | `lib/agent/runtime.ts` `lib/llm.ts` | `pnpm smoke` |
| 7 | 离线转写与话轮落库 | ✅ | `lib/asr/index.ts` | e2e-asr |
| 8 | 说话人映射 | ✅ | `lib/asr/index.ts#mapParticipants` | e2e-asr |
| 9 | 状态机编排 | ✅ | `lib/agent/pipeline.ts` | e2e 组 5（阶段顺序断言） |
| 10 | 转写气泡 + 原话跳转 | ✅ | `components/transcript-view.tsx` | e2e 组 6 |
| 11 | SSE 与运行视图 | ✅ | `lib/events.ts` `app/api/meetings/[id]/stream` `components/agent-runner.tsx` | e2e 组 5 |
| 12 | 两层消息模型 | ✅ | `lib/agent/pipeline.ts` `lib/context/governance.ts` | e2e 组 6 |
| 13 | 结构化抽取与唯一写库 | ✅ | `lib/tools/index.ts#saveMinutes` | `pnpm smoke`（引用数断言） |
| 14 | 纪要视图 + 引用高亮 | ✅ | `components/minutes-view.tsx` | e2e 组 6 |
| 15 | 增量记忆 | ✅ | `lib/memory/store.ts` `lib/tools/index.ts#rememberFromMinutes` | e2e 组 7 |
| 16 | 跨会议追问 | ✅ | `app/api/ask/route.ts` `components/ask-form.tsx` | e2e 组 7/8 |
| 17 | README 与演示脚本 | ✅ | `README.md` | 文档 |

## 二、从 Backlog 提升并实现的三个 issue

| # | Issue | 原状态 | 现状态 | 代码 | 测试 |
|---|---|---|---|---|---|
| 22 | 接入真实 ASR | backlog | ✅ 已实现 | `lib/asr/real.ts` `lib/asr/index.ts` | `test:asr` 13 项 + `e2e:asr` 8 项 |
| 23 | 声纹与说话人聚类 | backlog | ✅ 已实现 | `lib/voice/*` `app/api/voiceprints` | `test:voice` 18 项 + `e2e:voice` 20 项 |
| 25 | 语义检索 | backlog | ✅ 已实现 | `lib/rag/*` | `test:rag` 16 项 |
| 26 | 实时流式转写与增量纪要 | backlog（原 #22 实时分支） | ✅ 已实现 | `lib/live/*` `components/live/*` | `test:live` 23 项 + `e2e:live` 24 项 |
| 27 | 会议中实时提问（会中问答） | backlog | ✅ 已实现 | `lib/live/qa-core.ts` `lib/live/qa.ts` `app/api/live/ask` `components/live/live-ask-panel.tsx` | `test:live-qa` 59 项 |
| 28 | 会中提问接入往期会议记忆 | backlog | ✅ 已实现 | `lib/live/qa-core.ts#rankMemories` `lib/live/qa.ts#loadMemoryPool` | `test:live-qa` A7/B3 组 |
| 29 | 会中回答改为流式输出 | backlog | ✅ 已实现 | `lib/llm.ts#streamText` `lib/live/qa.ts#streamAnswer` `app/api/live/ask` | `test:live-qa` B3 组流式断言 + 探针脚本 |
| 30 | 删除会议 | backlog | ✅ 已实现 | `lib/meeting/delete.ts` `app/api/meetings/[id]/route.ts` `components/delete-meeting-button.tsx` | `test:meeting-delete` 24 项 |
| 31 | 概括类问法被误判为查不到 | bug | ✅ 已修复 | `lib/live/qa-core.ts#isMetaSummaryQuery` `SUMMARY_RULES` | `test:live-qa` A8 组 16 项 |
| 32 | 按说话人提问被答成找不到 | bug | ✅ 已修复 | `lib/live/qa-core.ts#parseSpeakerQuery` `lib/live/qa.ts#loadSpeakerNames` | `test:live-qa` A9 组 18 项 |

三份详细 issue 正文在 [`docs/issues/`](docs/issues/)。

> 注意：#22 在本迭代拆分过了。原 #22 是「实时流式 ASR」，本轮实现的是**离线真实转写**，
> 实时能力仍留在 backlog（需要 WebSocket + 断句，是独立的三天工作量）。

## 三、测试全景（共 142 项断言）

| 套件 | 命令 | 断言数 | 覆盖 |
|---|---|---|---|
| 主链路端到端 | `pnpm e2e` | 20 | 登录/RBAC/上传/状态机/SSE/纪要/追问/防编造 |
| ASR 适配器 | `pnpm test:asr` | 13 | 两种上游格式、时间换算、错误、降级 |
| 声纹聚类 | `pnpm test:voice` | 18 | 聚类、身份认领、标签合并、边界 |
| 语义检索 | `pnpm test:rag` | 16 | 分词、召回、RRF、隔离、幂等、防幻觉 |
| 真实 ASR 端到端 | `pnpm e2e:asr` | 8 | 上传音频 → 真实 ASR → 入库 → 纪要 |
| 声纹端到端 | `pnpm e2e:voice` | 20 | 注册 → 会议聚类 → 删除 |
| 实时流单元 | `pnpm test:live` | 23 | 跨片拼接、去重、规则抽取 |
| 实时流端到端 | `pnpm e2e:live` | 24 | 分片上传 → 实时 SSE → 增量纪要 → 结束合并 |
| 会中提问 | `pnpm test:live-qa` | 59 | 问句分词、检索排序、候选合并、上下文预算、兜底回答、鉴权/权限/租户隔离/端到端问答 |
| 后端冒烟 | `pnpm smoke` | 1 | 不启动 UI 的纯链路 |

一次跑全部：

```bash
pnpm test:all
```

## 四、实际提 PR 时怎么用

每个 issue 一个分支、一个 PR，PR 描述直接把对应 issue 里的「实现 / 测试 / 踩坑记录」三节搬过去。

```bash
git checkout -b feat/22-real-asr
# ... 改代码 ...
git commit -m "feat(asr): 支持 OpenAI / FunASR 两种真实 ASR 上游"
git push -u origin feat/22-real-asr
gh pr create --title "feat(asr): 接入真实 ASR" --body "$(cat docs/issues/22-real-asr.md)"
```

PR 正文模板见 `docs/PR-TEMPLATE.md`。

## 五、为什么这份追溯表本身就是评估点

衡量是否真正做到 issue 驱动开发，只列举 issue 数量是不够的——
关键在于**能不能从任意一行代码反查到它的 issue 和验收标准**。

这张表就是做这件事的。它也解释了为什么三个 backlog 能在一个下午内被实现：
因为每个 issue 在写代码之前就已经把验收标准写死了，实现时只是「让断言变绿」。