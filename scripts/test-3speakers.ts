// 实测：三人对话能否被正确分离
import { readFileSync } from "node:fs";
import { normalizeToDashScope, buildWavHeader } from "../lib/asr/audio";
import { transcribeWithDiarization } from "../lib/asr/diarization";

async function main() {
  const key = readFileSync(".env", "utf8")
    .split("\n").find((l) => l.startsWith("DASHSCOPE_API_KEY="))
    ?.replace(/^DASHSCOPE_API_KEY="|"$/g, "").trim();
  if (!key) { console.error("无 key"); process.exit(1); }
  process.env.DASHSCOPE_API_KEY = key;

  const wav = readFileSync("storage/meeting-3speakers.wav");
  const { pcm, durationMs } = normalizeToDashScope(wav);
  console.log(`音频时长: ${(durationMs / 1000).toFixed(1)}s`);
  console.log("真实说话人: 张伟(Huihui) / 王强(Kangkang) / 李娜(Yaoyao)，交替 6 段\n");

  const standard = Buffer.concat([buildWavHeader(pcm.length, 16000, 1, 16), pcm]);
  const turns = await transcribeWithDiarization(standard, 16000);

  console.log(`识别出 ${turns.length} 句：`);
  const speakers = new Set();
  for (const t of turns) {
    speakers.add(t.speakerId);
    console.log(`  [speaker_${t.speakerId}] ${t.beginMs}-${t.endMs}ms  ${t.text}`);
  }

  console.log(`\n=== 结果 ===`);
  console.log(`检测到说话人数: ${speakers.size}（真实 3 人）`);
  console.log(speakers.size === 3 ? "✅ 人数正确" : speakers.size < 3 ? "⚠️ 少了" : "⚠️ 多了");
  console.log(`\n注意：speaker_id 只是编号，无法对应到具体是谁。`);
}

main().catch((e) => { console.error(e); process.exit(1); });