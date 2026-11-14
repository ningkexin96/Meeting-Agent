---
title: "[ingest] 接入真实 ASR（OpenAI / FunASR 两种上游）"
labels: P0, layer:ingest
milestone: MVP / 48h
---

## 背景

原 `ASR_PROVIDER=real` 只是占位实现，直接抛错。要让 demo 能处理**真实音频**，而不是只跑预置文本。

上一轮 `#22` 记录的是「实时流式 ASR」，那是另一个问题（WebSocket + 断句）。本 issue 解决的是
**离线真实转写**：把重依赖挡在进程外，Next.js 只负责 HTTP 调用。

## 目标

- 支持两种上游格式，通过环境变量切换，不改代码：
  - `ASR_KIND=openai` → `POST {ASR_BASE_URL}/audio/transcriptions`（multipart）
    whisper.cpp server / faster-whisper / OpenAI / 云厂商兼容网关都走这个
  - `ASR_KIND=funasr` → `POST {ASR_BASE_URL}/transcribe`（返回 utterances + spk）
- 返回统一归一化成 `AsrTurn[]`（毫秒坐标）
- 失败可降级（`ASR_FALLBACK_TO_MOCK=1`），且**降级事实必须暴露到界面**，不能静默

## 验收标准

- [x] 秒 → 毫秒换算正确（OpenAI 风格）
- [x] FunASR 的毫秒坐标直接使用
- [x] `no_speech_prob` 映射为置信度
- [x] speaker 标签归一化为 `speaker_N`
- [x] 上游非 2xx 时抛 `AsrError` 且带响应体片段
- [x] 上游只返回整段 text（无 segments）时降级成一整句，不崩
- [x] 降级开关开时回退预置转写，并在事件流里发一条告警文本
- [x] 降级开关关时抛 `AsrUnavailableError`
- [x] 音频路径解析兼容「绝对路径 / 相对 STORAGE_DIR / 相对 cwd」

## 实现

| 文件 | 作用 |
|---|---|
| `lib/asr/real.ts` | 两种上游适配器 + 音频读取 + 错误类型 |
| `lib/asr/index.ts` | `transcribeWithFallback` 统一入口、`mergeTurns` 合并策略 |
| `lib/agent/pipeline.ts` | PREPARING 阶段调用，降级时发告警事件 |
| `scripts/fake-asr-server.mjs` | 本地假 ASR 服务，无外部依赖也能验证链路 |

## 测试

```bash
pnpm test:asr      # 13 项
pnpm e2e:asr       # 8 项（上传音频 → 真实 ASR → 入库 → 纪要）
```

## 踩坑记录

**话轮合并会把整场会议压成一条。**
whisper 不做说话人分离，所有段落都是 `speaker_0`，原合并逻辑（同 speaker + 间隔 < 2s）
把 6 段合成 1 条，摘要和引用全部失去意义。
修正：只合并「短句碎片」，句末有 `。！？；` 的完整句保持独立。

**音频路径。**
`meeting.audioPath` 存的是文件名，ASR 里直接按 cwd 解析会 ENOENT。
修正：按「绝对路径 → STORAGE_DIR/文件名 → cwd 相对」依次尝试。

## 不做

- 实时流式（归 #22，需 WebSocket）
- 说话人分离（归 #23 声纹聚类）