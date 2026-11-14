import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();
const rows = await p.voiceprint.findMany({ include: { user: true } });
console.log("声纹记录：");
for (const r of rows) console.log(`  ${r.user.name} dim=${r.dim} samples=${r.samples}`);

// 清掉调试脚本留下的脏数据（dim 不是 64 的）
const bad = rows.filter((r) => r.dim !== Number(process.env.VOICEPRINT_DIM ?? 64));
if (bad.length) {
  await p.voiceprint.deleteMany({ where: { id: { in: bad.map((b) => b.id) } } });
  console.log(`已清理 ${bad.length} 条维度和 ${
    process.env.VOICEPRINT_DIM ?? 64
  } 维不一致的脏声纹`);
}
await p.$disconnect();