// 生成一段测试用 WAV —— 用于验证 ASR 链路能跑通（不含真实语音，只验证协议）
// 用法：node scripts/make-test-wav.mjs [秒数]
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const seconds = Number(process.argv[2] ?? 3);
const SAMPLE_RATE = 16000;

// 生成一段 440Hz 正弦波（能被识别服务"听到"，但不是语音）
const frames = SAMPLE_RATE * seconds;
const pcm = Buffer.alloc(frames * 2);
for (let i = 0; i < frames; i++) {
  const v = Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE) * 0.3 * 32767;
  pcm.writeInt16LE(Math.round(v), i * 2);
}

const header = Buffer.alloc(44);
const byteRate = SAMPLE_RATE * 1 * 2;
header.write("RIFF", 0, "ascii");
header.writeUInt32LE(36 + pcm.length, 4);
header.write("WAVE", 8, "ascii");
header.write("fmt ", 12, "ascii");
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22);
header.writeUInt32LE(SAMPLE_RATE, 24);
header.writeUInt32LE(byteRate, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write("data", 36, "ascii");
header.writeUInt32LE(pcm.length, 40);

const dir = path.resolve("storage");
mkdirSync(dir, { recursive: true });
const out = path.join(dir, `test-tone-${seconds}s.wav`);
writeFileSync(out, Buffer.concat([header, pcm]));
console.log(`已生成: ${out}`);
console.log(`格式: ${SAMPLE_RATE}Hz / 单声道 / 16bit / ${seconds}s / ${((44 + pcm.length) / 1024).toFixed(1)}KB`);