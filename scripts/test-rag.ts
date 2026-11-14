// 语义检索测试 —— 对应 issue #25
// 用法：pnpm test:rag
import { PrismaClient } from "@prisma/client";
import { indexObjects, hybridRecall, cosine } from "../lib/rag/retriever";
import { tokenize, deterministicEmbedder } from "../lib/rag/embedding";

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

const prisma = new PrismaClient();

async function main() {
  console.log("== 分词 ==");
  const toks = tokenize("排期定了吗 deadline 2024");
  ok("中文被切成 bigram", toks.includes("排期") && toks.includes("期定"));
  ok("英文按词切", toks.includes("deadline"));
  ok("数字保留", toks.includes("2024"));

  console.log("== 向量 ==");
  const [v1, v2] = await deterministicEmbedder.embed(["排期结论已定", "排期结论已定"]);
  ok("同文本向量一致", cosine(v1, v2) > 0.999);
  ok("向量已归一化", Math.abs(Math.sqrt(v1.reduce((s, x) => s + x * x, 0)) - 1) < 1e-9);

  console.log("== 准备索引数据 ==");
  const tenant = await prisma.tenant.create({ data: { name: "RAG 测试租户" } });
  const meeting = await prisma.meeting.create({
    data: { tenantId: tenant.id, title: "RAG 测试会议", status: "done", stage: "DONE" },
  });

  const corpus = [
    { id: "obj-schedule", content: "月底发布第一个可用版本，实时转写放到下个迭代。" },
    { id: "obj-frontend", content: "前端时间紧，纪要页先做字段级编辑，富文本下个迭代。" },
    { id: "obj-risk", content: "缺少声纹库，外部参会者可能识别不准。" },
    { id: "obj-storage", content: "音频先用本地目录存储，后续迁移对象存储。" },
  ];

  await indexObjects(
    corpus.map((c) => ({
      tenantId: tenant.id,
      objectType: "decision" as const,
      objectId: c.id,
      meetingId: meeting.id,
      content: c.content,
    })),
  );

  console.log("== 召回 ==");
  const hits = await hybridRecall(tenant.id, "上线时间是什么时候", { limit: 3 });
  ok("召回有结果", hits.length > 0, `${hits.length} 条`);
  ok(
    "语义命中排期那条（问题里没有「排期」二字）",
    hits.some((h) => h.objectId === "obj-schedule"),
    hits.map((h) => h.objectId).join(", "),
  );
  ok("命中标注了来源", hits[0].via.length > 0, hits[0].via.join("+"));

  const kwHits = await hybridRecall(tenant.id, "声纹 识别不准", { limit: 3 });
  ok("关键词也能命中", kwHits[0].objectId === "obj-risk", kwHits[0].objectId);

  console.log("== 排序与融合 ==");
  ok("分数降序", hits.every((h, i) => i === 0 || h.score <= hits[i - 1].score + 1e-9));
  const dual = hits.find((h) => h.via.length === 2);
  ok("存在双路命中的结果（RRF 加权）", Boolean(dual), dual ? dual.objectId : "无");

  console.log("== 无关问题不召回（防幻觉） ==");
  // 这是实测结论的固化：bigram 向量对无关问题也会给出 0.1~0.2 的分数，
  // 必须靠「关键词是否命中」做闸门，否则会把无关内容当依据。
  const unrelated = await hybridRecall(tenant.id, "今天天气怎么样", { limit: 3 });
  ok("完全无关的问题不召回", unrelated.length === 0, `${unrelated.length} 条`);

  const semiRelated = await hybridRecall(tenant.id, "量子计算什么时候上线", { limit: 3 });
  ok(
    "半相关但无关键词命中时保守处理",
    semiRelated.length === 0 || semiRelated[0].via.includes("keyword"),
    `${semiRelated.length} 条`,
  );

  console.log("== 租户隔离 ==");
  const otherTenant = await prisma.tenant.create({ data: { name: "别的租户" } });
  const leak = await hybridRecall(otherTenant.id, "排期", { limit: 5 });
  ok("其他租户查不到本租户数据", leak.length === 0, `${leak.length} 条`);

  console.log("== 幂等 ==");
  const before = await prisma.embedding.count({ where: { tenantId: tenant.id } });
  await indexObjects(
    corpus.map((c) => ({
      tenantId: tenant.id,
      objectType: "decision" as const,
      objectId: c.id,
      meetingId: meeting.id,
      content: c.content,
    })),
  );
  const after = await prisma.embedding.count({ where: { tenantId: tenant.id } });
  ok("重复建索引不产生重复行", before === after, `${before} → ${after}`);

  console.log("== 边界 ==");
  const empty = await hybridRecall(tenant.id, "", { limit: 3 });
  ok("空查询不报错", Array.isArray(empty));

  // 清理
  await prisma.embedding.deleteMany({ where: { tenantId: { in: [tenant.id, otherTenant.id] } } });
  await prisma.meeting.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.tenant.deleteMany({ where: { id: { in: [tenant.id, otherTenant.id] } } });
  await prisma.$disconnect();

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});