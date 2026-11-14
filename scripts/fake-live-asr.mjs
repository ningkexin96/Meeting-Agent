// 假实时 ASR：按请求体里「第几片」返回不同内容，模拟边说边出转写
// 用法：node scripts/fake-live-asr.mjs [port]
//
// 判定分片序号的依据是音频字节数哈希——真实场景里是音频内容不同，
// 这里用「每次请求递增」来近似，保证连续上传的片能拿到不同句子。
import { createServer } from "node:http";

const PORT = Number(process.argv[2] ?? 8901);

// 故意让句子跨片：奇数片以未结束的句子结尾，用来验证跨片拼接
const SENTENCES = [
  "今天主要对一下纪要功能的上线节奏",
  "，先上线离线转写。",
  "这个事今天就定下来",
  "，实时能力往后放。",
  "张伟你负责把文档补一下。",
  "还有一个风险，没有声纹库可能不准。",
  "纪要页先做字段级编辑",
  "，富文本下个迭代。",
  "下周一再对一次进度。",
  "所有写入都走统一的保存接口。",
];

let counter = 0;

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

  // 每片返回一句（按全局计数器轮转），单片时长 4 秒
  const idx = counter++ % SENTENCES.length;
  const text = SENTENCES[idx];
  const segments = [{ start: 0.2, end: 3.6, text, no_speech_prob: 0.05 }];

  console.log(`[fake-live-asr] ${url.pathname} ${body.length}B → "${text}"`);

  if (url.pathname === "/v1/audio/transcriptions") {
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({ task: "transcribe", text, segments }),
    );
    return;
  }

  res.writeHead(404).end("not found");
});

server.listen(PORT, () => {
  console.log(`[fake-live-asr] listening on http://127.0.0.1:${PORT}`);
});