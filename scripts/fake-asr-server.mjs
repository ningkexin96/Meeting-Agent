// 本地假 ASR 服务 —— 用于在没有真实 ASR 时验证适配器链路
// 支持两种上游格式：
//   POST /v1/audio/transcriptions  → OpenAI verbose_json（含 segments）
//   POST /transcribe               → FunASR 风格（含 utterances + spk）
//
// 用法：node scripts/fake-asr-server.mjs [port]
// 然后：.env 里设 ASR_PROVIDER=real ASR_KIND=openai ASR_BASE_URL=http://127.0.0.1:8899/v1
import { createServer } from "node:http";

const PORT = Number(process.argv[2] ?? 8899);

// 固定返回，单位是秒（OpenAI 风格）与毫秒（FunASR 风格）
const SEGMENTS = [
  { start: 0, end: 9.2, text: "今天主要对一下纪要功能的上线节奏。" },
  { start: 9.6, end: 21.4, text: "我倾向先上线录音上传和离线转写，实时能力往后放。" },
  { start: 21.8, end: 34.0, text: "后端压力不大，主要问题是音频存储和清理策略。" },
  { start: 34.4, end: 47.1, text: "可以先用本地目录，但文档里要写清楚这是临时的。" },
  { start: 47.5, end: 62.3, text: "前端时间紧，纪要页先做字段级编辑，富文本下个迭代。" },
  { start: 62.7, end: 78.9, text: "还有一个风险，没有声纹库，外部参会者可能识别不准。" },
];

const UTTERANCES = SEGMENTS.map((s, i) => ({
  text: s.text,
  start: Math.round(s.start * 1000),
  end: Math.round(s.end * 1000),
  spk: String(i % 2),
}));

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const body = await readBody(req);

  if (req.method !== "POST") {
    res.writeHead(405).end("method not allowed");
    return;
  }

  // 记录收到了多大的音频，证明适配器确实把文件传过来了
  console.log(`[fake-asr] ${url.pathname} 收到 ${body.length} 字节`);

  if (url.pathname === "/v1/audio/transcriptions") {
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        task: "transcribe",
        language: "zh",
        duration: 78.9,
        text: SEGMENTS.map((s) => s.text).join(""),
        segments: SEGMENTS.map((s) => ({ ...s, no_speech_prob: 0.05 })),
      }),
    );
    return;
  }

  if (url.pathname === "/transcribe") {
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({ utterances: UTTERANCES }),
    );
    return;
  }

  res.writeHead(404).end("not found");
});

server.listen(PORT, () => {
  console.log(`[fake-asr] listening on http://127.0.0.1:${PORT}`);
  console.log(`  OpenAI 风格 : POST /v1/audio/transcriptions`);
  console.log(`  FunASR 风格 : POST /transcribe`);
});