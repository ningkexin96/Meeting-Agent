// 双音源实时转写端到端验证
//
// 目的：证明「麦克风（speaker_0）」和「系统播放音 / 会议对方（speaker_1）」
// 两路音频能被同一条 WebSocket 分别识别、分别落库，不会串话。
//
// 做法：用 Windows SAPI 生成两段**内容不同**的中文语音，
// 各自转成 16kHz 单声道 PCM，加 1 字节轨道头后交替推流到 /api/live/ws，
// 最后检查每个 speakerLabel 拿到的是不是对应那段话。
//
// 运行：node scripts/test-dual-source.mjs

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";

const ORIGIN = process.env.APP_ORIGIN ?? "http://127.0.0.1:3210";
const SESSION_COOKIE = "ma_session";

const MIC_TEXT = "我方这边测试麦克风识别正常";
const SYS_TEXT = "对方讲话内容是线上会议的远端音频";

function wavToPcm16k16m(wavPath) {
  const buf = readFileSync(wavPath);
  // 解析 RIFF，找到 fmt 与 data
  let pos = 12;
  let fmt = null;
  let data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === "fmt ") {
      fmt = {
        channels: buf.readUInt16LE(pos + 10),
        sampleRate: buf.readUInt32LE(pos + 12),
        bits: buf.readUInt16LE(pos + 22),
      };
    } else if (id === "data") {
      data = buf.subarray(pos + 8, pos + 8 + size);
    }
    pos += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error(`WAV 解析失败：${wavPath}`);
  if (fmt.bits !== 16) throw new Error(`只支持 16bit，实际 ${fmt.bits}`);

  let samples = new Int16Array(data.buffer, data.byteOffset, Math.floor(data.byteLength / 2));
  // 立体声 → 单声道
  if (fmt.channels === 2) {
    const mono = new Int16Array(samples.length / 2);
    for (let i = 0; i < mono.length; i++) mono[i] = (samples[i * 2] + samples[i * 2 + 1]) / 2;
    samples = mono;
  }
  // 重采样到 16kHz（线性插值，与 pcm-processor.js 同一算法）
  if (fmt.sampleRate !== 16000) {
    const ratio = fmt.sampleRate / 16000;
    const out = new Int16Array(Math.floor(samples.length / ratio));
    for (let i = 0; i < out.length; i++) {
      const p = i * ratio;
      const i0 = Math.floor(p);
      const a = samples[i0] ?? 0;
      const b = samples[i0 + 1] ?? a;
      out[i] = a + (b - a) * (p - i0);
    }
    samples = out;
  }
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
}

function synth(text, outPath) {
  // 用 SAPI 朗读并直接存成 WAV（16kHz 16bit 单声道）
  const ps = `
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SetOutputToWaveFile('${outPath.replace(/\\/g, "\\\\")}')
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,
  [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
  [System.Speech.AudioFormat.AudioChannel]::Mono)
$s.SetOutputToWaveFile('${outPath.replace(/\\/g, "\\\\")}', $fmt)
$s.Rate = -1
$s.Speak('${text}')
$s.Dispose()
`;
  execFileSync("powershell", ["-NoProfile", "-Command", ps], { stdio: "inherit" });
}

/** 取一个登录用户的 cookie（测试脚本用已有会话，避免动数据库） */
function loadCookie() {
  const cookie = process.env.MA_COOKIE;
  if (!cookie) {
    throw new Error("请设置环境变量 MA_COOKIE（浏览器里登录后的 ma_session cookie 值）");
  }
  return cookie;
}

async function createMeeting(cookie) {
  // 该接口是 multipart 表单（可带音视频文件），不能发 JSON
  const fd = new FormData();
  fd.append("title", "双音源验证");
  const res = await fetch(`${ORIGIN}/api/meetings`, {
    method: "POST",
    headers: { cookie: `${SESSION_COOKIE}=${cookie}` },
    body: fd,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`创建会议返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`创建会议失败：${JSON.stringify(data)}`);
  return data.id;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const tmp = mkdtempSync(path.join(tmpdir(), "dualsrc-"));
  const micWav = path.join(tmp, "mic.wav");
  const sysWav = path.join(tmp, "sys.wav");
  console.log("1. 合成两段测试语音（内容不同，便于核对归属）…");
  synth(MIC_TEXT, micWav);
  synth(SYS_TEXT, sysWav);
  const micPcm = wavToPcm16k16m(micWav);
  const sysPcm = wavToPcm16k16m(sysWav);
  console.log(`   mic ${(micPcm.length / 32000).toFixed(1)}s / sys ${(sysPcm.length / 32000).toFixed(1)}s`);

  const cookie = loadCookie();
  const meetingId = await createMeeting(cookie);
  console.log(`2. 会议 ${meetingId}，连接 WebSocket…`);

  const wsUrl = `${ORIGIN.replace("http", "ws")}/api/live/ws`;
  const ws = new WebSocket(wsUrl, { headers: { cookie: `${SESSION_COOKIE}=${cookie}` } });

  const results = [];
  let sessionId = null;
  let readySources = [];

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("识别服务 20s 未就绪")), 20000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "start", meetingId })));
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === "session") sessionId = m.sessionId;
      if (m.type === "ready") {
        readySources = m.sources ?? [];
        clearTimeout(timer);
        resolve();
      }
      if (m.type === "source-error") console.log(`   [source-error] ${m.speakerLabel}: ${m.message}`);
      if (m.type === "result" && m.isFinal) results.push(m);
      if (m.type === "error") {
        clearTimeout(timer);
        reject(new Error(m.message));
      }
    });
  });

  await ready;
  console.log(`3. 就绪，上游音源: ${JSON.stringify(readySources)}`);
  if (!readySources.includes(0) || !readySources.includes(1)) {
    throw new Error(`两条上游会话没有全部启动：${JSON.stringify(readySources)}`);
  }

  // 4. 交叉推流：两路交替，每 100ms 一包，模拟真实双源同时说话
  console.log("4. 交替推流（轨道头 0=麦克风，1=系统音）…");
  const chunk = 3200; // 100ms @16k/16bit
  const total = Math.max(micPcm.length, sysPcm.length);
  for (let off = 0; off < total; off += chunk) {
    for (const [id, pcm] of [
      [0, micPcm],
      [1, sysPcm],
    ]) {
      if (off >= pcm.length) continue;
      const slice = pcm.subarray(off, Math.min(off + chunk, pcm.length));
      const frame = Buffer.allocUnsafe(slice.length + 1);
      frame[0] = id;
      slice.copy(frame, 1);
      ws.send(frame);
    }
    await sleep(95);
  }

  ws.send(JSON.stringify({ type: "stop" }));
  await new Promise((resolve) => {
    ws.on("message", (raw) => {
      if (JSON.parse(raw.toString()).type === "stopped") resolve();
    });
    setTimeout(resolve, 20000);
  });
  ws.close();

  // 5. 核对
  console.log("\n5. 识别结果：");
  const bySpeaker = { speaker_0: [], speaker_1: [] };
  for (const r of results) {
    (bySpeaker[r.speakerLabel] ??= []).push(r.text);
    console.log(`   [${r.speakerLabel}] ${r.text}`);
  }
  const micAll = bySpeaker.speaker_0.join("");
  const sysAll = bySpeaker.speaker_1.join("");

  const checks = [
    ["麦克风轨道有识别结果", bySpeaker.speaker_0.length > 0],
    ["系统音轨道有识别结果", bySpeaker.speaker_1.length > 0],
    ["麦克风轨道不是对方的话", !micAll.includes("远端") && !micAll.includes("线上会议")],
    ["系统音轨道不是我方的话", !sysAll.includes("我方")],
    ["麦克风轨道命中「麦克风」", micAll.includes("麦克风") || micAll.includes("测试")],
    ["系统音轨道命中「对方」", sysAll.includes("对方") || sysAll.includes("远端")],
  ];

  console.log("\n6. 断言：");
  let failed = 0;
  for (const [name, ok] of checks) {
    console.log(`   ${ok ? "✓" : "✗"} ${name}`);
    if (!ok) failed++;
  }

  rmSync(tmp, { recursive: true, force: true });
  console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`\n失败：${e.message}`);
  process.exit(1);
});