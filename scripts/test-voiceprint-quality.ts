// 验证新声纹算法的区分能力
import { spectralEmbedder } from "../lib/voice/embedder";
import { voiceprintSimilarity } from "../lib/voice/similarity";

function cos(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] ** 2;
    nb += b[i] ** 2;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

async function main() {
  console.log("=== 不同说话人（Huihui vs Kangkang）===");
  const a = await spectralEmbedder.embed("storage/person-a.wav");
  const b = await spectralEmbedder.embed("storage/person-b.wav");
  const crossSim = voiceprintSimilarity(a, b);
  console.log(`  张伟 vs 李娜: ${crossSim.toFixed(4)}`);

  console.log("\n=== 同一人的不同片段 ===");
  const a1 = await spectralEmbedder.embed("storage/person-a.wav", 0, 1500);
  const a2 = await spectralEmbedder.embed("storage/person-a.wav", 1500, 3000);
  const selfSim = voiceprintSimilarity(a1, a2);
  console.log(`  同一人片段1 vs 片段2: ${selfSim.toFixed(4)}`);

  console.log("\n=== 判定 ===");
  console.log(`  跨人相似度: ${crossSim.toFixed(4)}`);
  console.log(`  同人相似度: ${selfSim.toFixed(4)}`);
  const gap = selfSim - crossSim;
  console.log(`  区分度(同人-跨人): ${gap.toFixed(4)}`);
  console.log(gap > 0.1 ? "  ✅ 能有效区分" : gap > 0.03 ? "  ⚠️ 勉强能区分" : "  ❌ 仍然区分不开");

  // 建议阈值
  const suggested = (crossSim + selfSim) / 2;
  console.log(`\n  建议判定阈值: ${suggested.toFixed(2)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });