// 声纹聚类测试 —— 对应 issue #23
// 用法：pnpm test:voice
import { clusterSpeakers, cosine, centroid, buildLabelMapping, normalize } from "../lib/voice/cluster";

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

/** 造一个「基准向量 + 微扰」的向量，模拟同一个人的不同片段 */
function person(base, noise) {
  const v = base.map((x, i) => x + Math.sin(noise * (i + 1)) * 0.06);
  return normalize(v);
}

const DIM = 64;
const ALICE = Array.from({ length: DIM }, (_, i) => Math.cos(i * 0.37) + 1.5);
const BOB = Array.from({ length: DIM }, (_, i) => Math.sin(i * 0.71) - 0.5);
const CAROL = Array.from({ length: DIM }, (_, i) => Math.cos(i * 1.13 + 2) * 1.2);

console.log("== 向量基本运算 ==");
ok("同向量余弦为 1", Math.abs(cosine([1, 2, 3], [1, 2, 3]) - 1) < 1e-9);
ok("正交向量余弦为 0", Math.abs(cosine([1, 0], [0, 1])) < 1e-9);
ok("质心维度正确", centroid([[1, 0], [0, 1]]).length === 2);
ok(
  "维度不一致时抛错",
  (() => {
    try {
      cosine([1, 2], [1, 2, 3]);
      return false;
    } catch {
      return true;
    }
  })(),
);

console.log("== 无人脸库：聚类 + 未知标记 ==");
const segs = [
  ...Array.from({ length: 3 }, (_, i) => ({ speakerLabel: "spk_0", embedding: person(ALICE, i) })),
  ...Array.from({ length: 2 }, (_, i) => ({ speakerLabel: "spk_1", embedding: person(BOB, i + 10) })),
  ...Array.from({ length: 1 }, (_, i) => ({ speakerLabel: "spk_2", embedding: person(CAROL, i + 20) })),
];
const noGallery = clusterSpeakers(segs, { threshold: 0.72 });
ok("识别出 3 个说话人", noGallery.length === 3, `实际 ${noGallery.length}`);
ok("全部标为未知", noGallery.every((s) => s.displayName.startsWith("未知参会者")));
ok("全部待复核", noGallery.every((s) => s.needsReview));
ok("按发言量排序（主讲人最多在前）", noGallery[0].segmentCount === 3, `top=${noGallery[0].segmentCount}`);

console.log("== 有声纹库：认领身份 ==");
const gallery = [
  { userId: "u-alice", displayName: "张伟", embedding: centroid([person(ALICE, 0), person(ALICE, 1)]) },
  { userId: "u-bob", displayName: "李娜", embedding: centroid([person(BOB, 10), person(BOB, 11)]) },
];
const withGallery = clusterSpeakers(segs, { threshold: 0.72, gallery });
const alice = withGallery.find((s) => s.userId === "u-alice");
const bob = withGallery.find((s) => s.userId === "u-bob");
ok("认出 张伟", Boolean(alice), alice?.confidence?.toFixed(3));
ok("认出 李娜", Boolean(bob), bob?.confidence?.toFixed(3));
ok("声纹库外的 Carol 仍为未知", withGallery.some((s) => !s.userId));
ok("认出的人不标待复核", alice && !alice.needsReview);
ok("未认出的人标待复核", withGallery.filter((s) => !s.userId).every((s) => s.needsReview));

console.log("== 同一人被 ASR 拆成两个标签 ==");
const splitSame = [
  { speakerLabel: "spk_0", embedding: person(ALICE, 0) },
  { speakerLabel: "spk_7", embedding: person(ALICE, 1) },
  { speakerLabel: "spk_1", embedding: person(BOB, 10) },
];
const mergedSame = clusterSpeakers(splitSame, { threshold: 0.72 });
ok("相似标签被合并，只剩 2 个说话人", mergedSame.length === 2, `实际 ${mergedSame.length}`);
const map = buildLabelMapping(mergedSame);
ok(
  "spk_0 与 spk_7 映射到同一标签",
  map.get("spk_0") === map.get("spk_7"),
  `${map.get("spk_0")} / ${map.get("spk_7")}`,
);
ok("spk_1 映射到不同标签", map.get("spk_1") !== map.get("spk_0"));

console.log("== 边界情况 ==");
ok("空输入返回空数组", clusterSpeakers([]).length === 0);
const single = clusterSpeakers([{ speakerLabel: "a", embedding: person(ALICE, 0) }]);
ok("单人会议可用", single.length === 1 && single[0].needsReview);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);