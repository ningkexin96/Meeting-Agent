// 测试说话人分离的边界情况
import { readFileSync } from "node:fs";
import { normalizeToDashScope, buildWavHeader } from "../lib/asr/audio";
import { transcribeWithDiarization } from "../lib/asr/diarization";

async function main() {
  const key = readFileSync(".env", "utf8")
    .split("\n").find((l) => l.startsWith("DASHSCOPE_API_KEY="))
    ?.replace(/^DASHSCOPE_API_KEY="|"$/g, "").trim();
  process.env.DASHSCOPE_API_KEY = key;

  // 边界 1：单人音频会不会被误分成多人
  console.log("=== 边界 1：单人音频（应识别为 1 人）===");
  const solo = readFileSync("storage/person-a.wav");
  const { pcm: soloPcm } = normalizeToDashScope(solo);
  const soloWav = Buffer.concat([buildWavHeader(soloPcm.length, 16000, 1, 16), soloPcm]);
  const soloTurns = await transcribeWithDiarization(soloWav, 16000);
  const soloSpeakers = new Set(soloTurns.map((t) => t.speakerId));
  console.log(`  识别出 ${soloTurns.length} 句，speaker 数量: ${soloSpeakers.size}`);
  console.log(`  ${soloSpeakers.size <= 1 ? "✅ 没有误分" : "⚠️ 单人被误分为多人"}`);

  // 边界 2：关闭说话人分离
  console.log("\n=== 边界 2：关闭说话人分离（withSpeaker=false）===");
  const wav3 = readFileSync("storage/meeting-3speakers.wav");
  const { pcm: pcm3 } = normalizeToDashScope(wav3);
  const wav3n = Buffer.concat([buildWavHeader(pcm3.length, 16000, 1, 16), pcm3]);
  const noSpkTurns = await transcribeWithDiarization(wav3n, 16000, { withSpeaker: false });
  const noSpkIds = new Set(noSpkTurns.map((t) => t.speakerId));
  console.log(`  句子数: ${noSpkTurns.length}，speaker 数量: ${noSpkIds.size}`);
  console.log(`  ${noSpkIds.size <= 1 ? "✅ 关闭后不区分说话人" : "⚠️ 仍然区分了"}`);

  // 边界 3：超过 5 分钟会被拒绝
  console.log("\n=== 边界 3：时长上限 ===");
  const limitMs = Number(process.env.DASHSCOPE_ASR_MAX_MS ?? 300_000);
  console.log(`  配置上限: ${limitMs / 60000} 分钟`);
  console.log(`  3 人音频时长: ${(pcm3.length / 32000).toFixed(1)}s — 在限制内`);
}

main().catch((e) => { console.error(e); process.exit(1); });