// 声纹库读写 —— 对应 issue #23
import { prisma } from "@/lib/db/client";
import { centroid, normalize, type GalleryEntry, type Vec } from "./cluster";

export async function getGallery(tenantId: string): Promise<GalleryEntry[]> {
  const rows = await prisma.voiceprint.findMany({
    where: { tenantId },
    include: { user: true },
  });
  return rows.map((r) => ({
    userId: r.userId,
    displayName: r.user.name,
    embedding: JSON.parse(r.embedding) as Vec,
  }));
}

/**
 * 注册声纹：同一用户重复注册时取质心更新（而不是覆盖），样本越多越稳。
 */
export async function registerVoiceprint(
  tenantId: string,
  userId: string,
  embedding: Vec,
  source = "registration",
): Promise<{ dim: number; samples: number }> {
  const existing = await prisma.voiceprint.findUnique({
    where: { tenantId_userId: { tenantId, userId } },
  });

  // 注意：existing.embedding 是「一个向量」的 JSON，不是向量的数组。
  // 重复注册时要把「旧质心」和「新向量」当作两个样本求质心。
  if (embedding.length === 0) throw new Error("声纹向量为空");
  let nextEmbedding: Vec;
  if (existing) {
    const prev = JSON.parse(existing.embedding) as Vec;
    if (prev.length !== embedding.length) {
      throw new Error(
        `声纹维度不一致：已有 ${prev.length} 维，新的 ${embedding.length} 维。` +
          `请先删除旧声纹，或确认 VOICEPRINT_DIM 没有变化。`,
      );
    }
    nextEmbedding = centroid([prev, normalize(embedding)]);
  } else {
    nextEmbedding = normalize(embedding);
  }

  const row = await prisma.voiceprint.upsert({
    where: { tenantId_userId: { tenantId, userId } },
    create: {
      tenantId,
      userId,
      embedding: JSON.stringify(nextEmbedding),
      dim: nextEmbedding.length,
      samples: 1,
      source,
    },
    update: {
      embedding: JSON.stringify(nextEmbedding),
      dim: nextEmbedding.length,
      samples: (existing?.samples ?? 0) + 1,
      source,
    },
  });

  await prisma.user.update({ where: { id: userId }, data: { voiceprintId: row.id } });
  return { dim: row.dim, samples: row.samples };
}

export async function deleteVoiceprint(tenantId: string, userId: string) {
  await prisma.voiceprint.deleteMany({ where: { tenantId, userId } });
  await prisma.user.update({ where: { id: userId }, data: { voiceprintId: null } });
}

export async function listVoiceprints(tenantId: string) {
  const rows = await prisma.voiceprint.findMany({
    where: { tenantId },
    include: { user: true },
    orderBy: { updatedAt: "desc" },
  });
  return rows.map((r) => ({
    userId: r.userId,
    name: r.user.name,
    email: r.user.email,
    dim: r.dim,
    samples: r.samples,
    updatedAt: r.updatedAt,
  }));
}