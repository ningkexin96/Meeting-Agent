// 状态机编排 —— 对应 issue #9
// 原则：阶段边界由代码控制（固定顺序、输入校验、失败重试），阶段内由模型/工具完成
import { prisma } from "@/lib/db/client";
import { runBus, type AgentStage } from "@/lib/events";
import { mapParticipants, mergeTurns, transcribeWithFallback } from "@/lib/asr";
import { isMockLlm } from "@/lib/llm";
import { callModel, extractJson } from "@/lib/agent/llm-call";
import { mockExtract, mockSummarize } from "@/lib/mock-llm";
import {
  assertMeetingInTenant,
  loadTurns,
  rememberFromMinutes,
  saveMinutes,
  validateDraft,
  type MinutesDraft,
  type ToolContext,
} from "@/lib/tools";
import { canUseTool } from "@/lib/auth/rbac";
import { audit } from "@/lib/db/scoped";

const MAX_REPAIR = 3;

const running = new Set<string>();

export function isRunning(meetingId: string) {
  return running.has(meetingId);
}

export async function runPipeline(ctx: ToolContext) {
  if (running.has(ctx.meetingId)) return { skipped: true, reason: "该会议正在处理中" };
  running.add(ctx.meetingId);
  runBus.reset(ctx.meetingId);

  const emitStage = async (stage: AgentStage, note?: string) => {
    runBus.publish(ctx.meetingId, { type: "stage", stage, note, at: Date.now() });
    await prisma.meeting.update({
      where: { id: ctx.meetingId },
      data: { stage, status: stage === "FAILED" ? "failed" : statusFor(stage) },
    });
  };

  const emitTool = (tool: string, args: Record<string, unknown>, ok = true) => {
    runBus.publish(ctx.meetingId, { type: "tool", tool, args, ok, at: Date.now() });
  };

  try {
    // ① PREPARING：确定性流程，只有代码，没有模型
    await emitStage("PREPARING", "校验会议归属与音频状态");
    const meeting = await assertMeetingInTenant(ctx.tenantId, ctx.meetingId);
    if (!canUseTool(ctx.role, "run_transcription")) {
      throw new Error(`角色 ${ctx.role} 不允许执行转写`);
    }

    let turnCount = await prisma.transcriptTurn.count({ where: { meetingId: ctx.meetingId } });
    if (turnCount === 0) {
      // 前置校验：真实 ASR 下没有音频就没法转写，直接给出可理解的错误，
      // 而不是让上游抛一个难懂的异常。mock 模式除外（它本来就不读音频）。
      const provider = process.env.ASR_PROVIDER ?? "mock";
      if (provider !== "mock" && !meeting.audioPath) {
        const liveCount = await prisma.liveSegment.count({
          where: { meetingId: ctx.meetingId },
        });
        if (liveCount === 0) {
          throw new Error(
            "这场会议没有音频，也没有实时转写记录，无法生成纪要。" +
              "请先上传音频，或改用「实时模式」边开会边记录。",
          );
        }
      }

      emitTool("run_transcription", {
        asr: process.env.ASR_PROVIDER ?? "mock",
        kind: process.env.ASR_KIND ?? "-",
      });
      // 真实 ASR 失败时按 ASR_FALLBACK_TO_MOCK 决定是否降级，并把降级事实暴露出去
      const asr = await transcribeWithFallback(meeting.audioPath, {
        allowFallback: process.env.ASR_FALLBACK_TO_MOCK === "1",
      });
      if (asr.usedFallback) {
        emitTool("run_transcription_fallback", { reason: asr.error ?? "未知" }, false);
        runBus.publish(ctx.meetingId, {
          type: "text",
          text: `⚠️ 真实 ASR 不可用，已降级为预置转写：${asr.error ?? ""}`,
          at: Date.now(),
        });
      }
      const merged = mergeTurns(asr.turns);

      // 说话人归属：有音频 + 声纹服务时走声纹聚类（issue #23），否则退回标签映射
      const speakerRes = await resolveSpeakers({
        audioPath: meeting.audioPath,
        turns: merged,
        tenantId: ctx.tenantId,
        sourceIsMock: asr.adapter.startsWith("mock"),
      });
      if (speakerRes.mode === "voiceprint") {
        emitTool("cluster_speakers", {
          engine: speakerRes.engine,
          matched: speakerRes.speakers.filter((s) => s.userId).length,
          unknown: speakerRes.speakers.filter((s) => !s.userId).length,
        });
      }

      const participantIds = new Map<string, string>();
      for (const p of speakerRes.speakers) {
        const row = await prisma.meetingParticipant.create({
          data: {
            meetingId: ctx.meetingId,
            userId: p.userId,
            displayName: p.displayName,
            speakerLabel: p.label,
            confidence: p.confidence,
          },
        });
        participantIds.set(p.label, row.id);
      }

      let idx = 0;
      for (const t of merged) {
        const label = speakerRes.labelMap.get(t.speakerLabel) ?? t.speakerLabel;
        const patient = speakerRes.speakers.find((s) => s.label === label);
        await prisma.transcriptTurn.create({
          data: {
            meetingId: ctx.meetingId,
            participantId: participantIds.get(label)!,
            idx: idx++,
            startMs: t.startMs,
            endMs: t.endMs,
            text: t.text,
            asrConfidence: t.confidence,
            // 两条线都要看：ASR 置信度低、或说话人归属待复核
            needsReview: t.confidence < 0.6 || Boolean(patient?.needsReview),
          },
        });
      }
      turnCount = idx;
      await audit(
        ctx,
        "transcription.done",
        { turns: turnCount, speakerMode: speakerRes.mode },
        ctx.meetingId,
      );
    }

    const turns = await loadTurns(ctx.tenantId, ctx.meetingId);

    // ② SUMMARIZING：两层消息模型的第一层落库
    await emitStage("SUMMARIZING", "生成分块摘要与全局摘要");
    emitTool("search_transcript", { query: "", limit: turns.length });
    await prisma.summary.deleteMany({ where: { meetingId: ctx.meetingId } });

    if (isMockLlm()) {
      const mock = mockSummarize(turns.map((t) => ({ idx: t.idx, speaker: t.participant.displayName, text: t.text })));
      runBus.publish(ctx.meetingId, { type: "text", text: mock.text, at: Date.now() });
      await prisma.summary.create({
        data: {
          meetingId: ctx.meetingId,
          stage: "chunk",
          idx: 0,
          content: mock.text,
          turnRefs: JSON.stringify(turns.map((t) => t.id)),
        },
      });
    } else {
      // 真实模型路径：按 20 turn 分块压缩（防止上下文撑爆）
      const text = await callModel(buildSummarizePrompt(turns), "summarize");
      runBus.publish(ctx.meetingId, { type: "text", text, at: Date.now() });
      await prisma.summary.create({
        data: {
          meetingId: ctx.meetingId,
          stage: "chunk",
          idx: 0,
          content: text,
          turnRefs: JSON.stringify(turns.map((t) => t.id)),
        },
      });
    }

    // ③ EXTRACTING：结构化抽取，Schema 校验 + 最多 3 次修复
    await emitStage("EXTRACTING", "抽取决议 / 待办 / 风险");

    // 加载该会议关联的 Skill（决定抽取重点），没有就用默认
    const { getSkill, buildSkillPromptPart } = await import("@/lib/skills");
    await import("@/lib/skills/registry"); // 注册内置 Skill
    const skill = getSkill(meeting.skillId);
    const skillPrompt = buildSkillPromptPart(skill);
    emitTool("load_skill", { skillId: skill.id, name: skill.name });

    let draft: MinutesDraft | null = null;
    let lastErr = "";
    for (let attempt = 1; attempt <= MAX_REPAIR; attempt++) {
      try {
        const raw = isMockLlm()
          ? mockExtract(turns.map((t) => ({ idx: t.idx, id: t.id, text: t.text, speaker: t.participant.displayName })))
          : extractJson(await callModel(buildExtractPrompt(turns, skillPrompt), "extract"));
        draft = validateDraft(raw);
        emitTool("validate_schema", { attempt, ok: true });
        break;
      } catch (e) {
        lastErr = (e as Error).message;
        emitTool("validate_schema", { attempt, ok: false, error: lastErr }, false);
        // 真实模式下把失败原因也推给前端，便于现场排查
        if (!isMockLlm()) {
          runBus.publish(ctx.meetingId, {
            type: "text",
            text: `⚠️ 第 ${attempt} 次抽取校验失败，正在重试：${lastErr}`,
            at: Date.now(),
          });
        }
      }
    }
    if (!draft) throw new Error(`结构化输出连续 ${MAX_REPAIR} 次校验失败：${lastErr}`);

    if (draft.actionItems.some((a) => !a.owner && !a.dueAt)) {
      emitTool("mark_unresolved", { count: draft.actionItems.filter((a) => !a.owner).length });
    }

    const saved = await saveMinutes(ctx, draft);
    emitTool("save_minutes", { decisions: draft.decisions.length, actions: draft.actionItems.length, risks: draft.risks.length });

    // ④ REVIEWING：产出待人工确认
    await emitStage("REVIEWING", "已生成草稿，等待人工复核");

    // ⑤ 记忆沉淀（每 5 轮触发一次的逻辑，在会议维度做一次增量）
    const mem = await rememberFromMinutes(ctx, draft);
    emitTool("recall_meeting_memory", { added: mem.added, noop: mem.noop });

    // ⑥ 建语义索引（issue #25）：话轮 / 摘要 / 决议 + 本次新增记忆
    try {
      const { indexMeeting, indexObjects } = await import("@/lib/rag/retriever");
      const indexed = await indexMeeting(ctx.tenantId, ctx.meetingId);
      const freshMemories = await prisma.memory.findMany({
        where: { meetingId: ctx.meetingId, tenantId: ctx.tenantId },
      });
      const memIndexed = await indexObjects(
        freshMemories.map((m) => ({
          tenantId: ctx.tenantId,
          objectType: "memory" as const,
          objectId: m.id,
          meetingId: ctx.meetingId,
          content: m.content,
        })),
      );
      emitTool("index_semantic", { objects: indexed, memories: memIndexed });
    } catch (e) {
      // 索引失败不应该让整场会议失败：检索会退回关键词
      emitTool("index_semantic", { error: (e as Error).message }, false);
    }

    await emitStage("DONE", "纪要已生成");
    await audit(ctx, "agent.done", { minutesId: saved.minutesId, citations: saved.citations }, ctx.meetingId);
    runBus.publish(ctx.meetingId, { type: "done", meetingId: ctx.meetingId, at: Date.now() });
    return { ok: true, minutesId: saved.minutesId };
  } catch (e) {
    const message = (e as Error).message;
    runBus.publish(ctx.meetingId, { type: "error", message, at: Date.now() });
    await prisma.meeting.update({
      where: { id: ctx.meetingId },
      data: { status: "failed", stage: "FAILED", error: message },
    });
    await audit(ctx, "agent.failed", { message }, ctx.meetingId);
    return { ok: false, error: message };
  } finally {
    running.delete(ctx.meetingId);
  }
}

function statusFor(stage: AgentStage) {
  switch (stage) {
    case "PREPARING":
      return "transcribing";
    case "SUMMARIZING":
      return "summarizing";
    case "EXTRACTING":
      return "extracting";
    case "REVIEWING":
      return "reviewing";
    case "DONE":
      return "done";
    default:
      return "failed";
  }
}

function buildSummarizePrompt(turns: { idx: number; participant: { displayName: string }; text: string }[]) {
  const body = turns.map((t) => `#${t.idx} ${t.participant.displayName}: ${t.text}`).join("\n");
  return `你在做会议转写压缩。请把下面的转写压缩成要点，每行格式：[#idx,...] 要点。不要编造内容。\n\n${body}`;
}

/**
 * 说话人归属解析 —— 对应 issue #23
 *
 * 两条路径：
 * - voiceprint：有音频且声纹可用时，按声纹聚类 + 声纹库认领身份；认不出的标 needs_review
 * - label：没有音频/声纹不可用时，退回「原始标签 → 参会人」的直接映射（不硬猜身份）
 */
async function resolveSpeakers(args: {
  audioPath: string | null;
  turns: { speakerLabel: string; startMs: number; endMs: number }[];
  tenantId: string;
  sourceIsMock: boolean;
}): Promise<{
  mode: "voiceprint" | "label";
  engine?: string;
  speakers: {
    label: string;
    userId: string | null;
    displayName: string;
    confidence: number;
    needsReview: boolean;
  }[];
  labelMap: Map<string, string>;
}> {
  const { getEmbedder } = await import("@/lib/voice/embedder");
  const { clusterSpeakers, buildLabelMapping } = await import("@/lib/voice/cluster");
  const { getGallery } = await import("@/lib/voice/store");

  const embedder = getEmbedder();
  const voiceprintEnabled = process.env.VOICEPRINT_ENABLED !== "0";

  // 云 ASR 已返回原生 speaker_id 时，直接用它的分段结果，不再做声纹聚类。
  // 原因：声纹聚类的目的是「猜出谁和谁不同」，而这里已经有权威答案了。
  const asrProvider = process.env.ASR_PROVIDER ?? "mock";
  const hasNativeDiarization =
    asrProvider === "qwen" &&
    process.env.DASHSCOPE_DIARIZE !== "0" &&
    new Set(args.turns.map((t) => t.speakerLabel)).size > 1;

  if (hasNativeDiarization) {
    const labels = [...new Set(args.turns.map((t) => t.speakerLabel))].sort();
    return {
      mode: "voiceprint",
      engine: "qwen-diarization",
      speakers: labels.map((label, i) => ({
        label: `speaker_${i}`,
        userId: null,
        // 云服务只告诉我们「是不同的说话人」，不告诉是谁——如实标注
        displayName: `说话人 ${String.fromCharCode(65 + i)}`,
        confidence: 0.9,
        needsReview: true,
      })),
      labelMap: new Map(labels.map((l, i) => [l, `speaker_${i}`])),
    };
  }

  if (voiceprintEnabled && args.audioPath) {
    try {
      // 每段话轮提一次声纹（真实服务可以按时间窗切，离线兜底用整文件+窗口种子）
      const segments: { speakerLabel: string; embedding: number[] }[] = [];
      let embedFailed = 0;
      for (const t of args.turns) {
        try {
          const emb = await embedder.embed(args.audioPath, t.startMs, t.endMs);
          segments.push({ speakerLabel: t.speakerLabel, embedding: emb });
        } catch {
          // 单段太短/静音属于常态，跳过而不是整场失败
          embedFailed++;
        }
      }
      if (embedFailed > 0) {
        console.warn(`[voiceprint] ${embedFailed}/${args.turns.length} 段声纹提取失败（片段过短或静音）`);
      }
      // 提取到的片段太少，聚类没有意义——直接退回标签映射
      if (segments.length < 2) {
        console.warn(`[voiceprint] 有效声纹片段仅 ${segments.length} 段，跳过聚类`);
        throw new Error("有效声纹片段不足");
      }
      const gallery = await getGallery(args.tenantId);
      const speakers = clusterSpeakers(segments, { gallery });
      return {
        mode: "voiceprint",
        engine: `${embedder.name}+gallery(${gallery.length})`,
        speakers: speakers.map((s) => ({
          label: s.label,
          userId: s.userId,
          displayName: s.displayName,
          confidence: Math.max(0, Math.min(1, s.confidence)),
          needsReview: s.needsReview,
        })),
        labelMap: buildLabelMapping(speakers),
      };
    } catch (e) {
      console.warn(`[voiceprint] 聚类失败，退回标签映射：${(e as Error).message}`);
    }
  }

  // 退回：原始标签直接映射
  const mapped = mapParticipants(args.turns as never, 0.6, args.sourceIsMock ? "mock" : "real");
  return {
    mode: "label",
    speakers: mapped.map((p) => ({
      label: p.speakerLabel,
      userId: null,
      displayName: p.displayName,
      confidence: p.confidence,
      needsReview: p.needsReview,
    })),
    labelMap: new Map(mapped.map((p) => [p.speakerLabel, p.speakerLabel])),
  };
}

/**
 * 构造抽取 prompt。
 * 规则部分来自 Skill（可配置），只有「输出格式」和「转写正文」写在这里，
 * 因为格式是系统契约，换 Skill 不应该换 Schema。
 */
function buildExtractPrompt(
  turns: { idx: number; participant: { displayName: string }; text: string }[],
  skillPrompt: string,
) {
  const body = turns.map((t) => `#${t.idx} ${t.participant.displayName}: ${t.text}`).join("\n");
  return `你是会议纪要抽取器。只输出 JSON，不要解释。

${skillPrompt}
## 输出格式（必须严格遵守）
{"overview":"","decisions":[{"content":"","sourceTurnIdx":0}],"actionItems":[{"content":"","owner":"","dueAt":"","sourceTurnIdx":0}],"risks":[{"content":"","severity":"low|medium|high","sourceTurnIdx":0}]}

owner 与 dueAt 不知道就留空字符串，不要编。sourceTurnIdx 必须来自下面的 #编号。

## 会议转写
${body}`;
}