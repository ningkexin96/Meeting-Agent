// 用 TTS 生成的中文语音测试真实 ASR（自动重采样）
import { readFileSync } from "node:fs";
import { parseWavHeader, normalizeToDashScope } from "../lib/asr/audio";
import { transcribePcm } from "../lib/asr/dashscope";

async function main() {
  const buf = readFileSync("storage/speech-test.wav");
  const info = parseWavHeader(buf);
  console.log(`原始音频: ${info.sampleRate}Hz / ${info.channels}ch / ${info.bitsPerSample}bit / ${info.durationMs}ms`);

  const { pcm, durationMs, converted } = normalizeToDashScope(buf);
  console.log(`规整后: 16000Hz / 1ch / 16bit / ${durationMs}ms${converted ? "（已转换）" : ""}`);

  console.log("\n开始识别…");
  const t0 = Date.now();
  const turns = await transcribePcm(pcm, durationMs);
  console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，识别 ${turns.length} 段：\n`);
  for (const t of turns) {
    console.log(`  [${t.beginMs}-${t.endMs}ms] ${t.text}`);
  }

  const fullText = turns.map((t) => t.text).join("");
  console.log("\n完整文本：");
  console.log("  " + fullText);
}

main().catch((e) => {
  console.error("失败:", e.message);
  if (e.detail) console.error(e.detail);
  process.exit(1);
});