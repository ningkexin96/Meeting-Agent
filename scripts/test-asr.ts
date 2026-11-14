// ASR 适配器测试 —— 对应 issue #22
// 起一个本地假 ASR 服务，验证两种上游格式（OpenAI / FunASR）都能被正确解析成 AsrTurn[]
// 用法：pnpm test:asr
import { spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const PORT = 8899;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
function ok(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? " — " + extra : ""}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 准备一个假音频文件（内容不重要，假服务不看内容，只看字节数）
  const dir = path.join(process.cwd(), "storage");
  await mkdir(dir, { recursive: true });
  const audioPath = path.join(dir, "test-sample.wav");
  await writeFile(audioPath, Buffer.alloc(4096, 1));

  // 启动假 ASR 服务
  const server = spawn(process.execPath, ["scripts/fake-asr-server.mjs", String(PORT)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => process.stdout.write(`    [server] ${d}`));
  await sleep(1200);

  const { transcribeWithRemoteAsr } = await import("../lib/asr/real.ts");

  console.log("== OpenAI 风格上游 ==");
  process.env.ASR_PROVIDER = "real";
  process.env.ASR_KIND = "openai";
  process.env.ASR_BASE_URL = `${BASE}/v1`;
  process.env.ASR_MODEL = "whisper-1";
  process.env.ASR_TIMEOUT_MS = "10000";

  const turns = await transcribeWithRemoteAsr(audioPath);
  ok("返回话轮数 > 0", turns.length > 0, `${turns.length} 条`);
  ok(
    "秒 → 毫秒换算正确",
    turns[0].startMs === 0 && turns[1].startMs === 9600,
    `第2条 startMs=${turns[1]?.startMs}`,
  );
  ok("文本非空", turns.every((t) => t.text.length > 0));
  ok("no_speech_prob 映射为置信度", Math.abs(turns[0].confidence - 0.95) < 0.01, `conf=${turns[0].confidence}`);
  ok("时间单调递增", turns.every((t, i) => i === 0 || t.startMs >= turns[i - 1].startMs));

  console.log("== FunASR 风格上游 ==");
  process.env.ASR_KIND = "funasr";
  process.env.ASR_BASE_URL = BASE;

  const funTurns = await transcribeWithRemoteAsr(audioPath);
  ok("返回话轮数 > 0", funTurns.length > 0, `${funTurns.length} 条`);
  ok("毫秒坐标直接使用", funTurns[1].startMs === 9600, `startMs=${funTurns[1]?.startMs}`);
  ok(
    "speaker 标签归一化",
    funTurns.every((t) => /^speaker_\d+$/.test(t.speakerLabel)),
    [...new Set(funTurns.map((t) => t.speakerLabel))].join(","),
  );

  console.log("== 错误处理 ==");
  process.env.ASR_BASE_URL = `http://127.0.0.1:${PORT}/nope`;
  let threw = false;
  try {
    await transcribeWithRemoteAsr(audioPath);
  } catch {
    threw = true;
  }
  ok("上游 404 时抛出 AsrError", threw);

  console.log("== 降级逻辑 ==");
  const { transcribeWithFallback } = await import("../lib/asr/index.ts");
  process.env.ASR_PROVIDER = "real";
  process.env.ASR_KIND = "openai";
  process.env.ASR_BASE_URL = `http://127.0.0.1:${PORT}/nope`;
  process.env.ASR_FALLBACK_TO_MOCK = "1";
  const fallback = await transcribeWithFallback(audioPath, { allowFallback: true });
  ok("失败时降级成功", fallback.usedFallback === true, fallback.adapter);
  ok("降级后仍有话轮", fallback.turns.length > 0, `${fallback.turns.length} 条`);
  ok("保留了失败原因", Boolean(fallback.error));

  process.env.ASR_FALLBACK_TO_MOCK = "0";
  let noFallbackThrew = false;
  try {
    await transcribeWithFallback(audioPath, { allowFallback: false });
  } catch {
    noFallbackThrew = true;
  }
  ok("关闭降级时抛出 AsrUnavailableError", noFallbackThrew);

  server.kill();
  await sleep(300);
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  // 显式用 exitCode + 延迟退出：Windows 上子进程与父进程同时析构会触发 libuv 断言
  process.exitCode = fail === 0 ? 0 : 1;
  setTimeout(() => process.exit(process.exitCode), 200).unref();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});