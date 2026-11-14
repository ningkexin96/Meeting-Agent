// 重置演示数据库：删表重建 + 写入演示数据
//
// 用法：node scripts/reset-db.mjs
//
// ⚠️ 这个操作会删除整个数据库文件里的所有数据。
// 作为唯一入口，它先做安全检查，通过后才调用 prisma db push --force-reset。
//
// 保护：
//   1. 只允许本地 SQLite 文件库（DATABASE_URL 必须是 file:）
//   2. 库中若存在非演示账号，必须显式设置 SEED_FORCE=1
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

const DEMO_EMAIL_DOMAIN = "@demo.dev";

async function main() {
  const url = process.env.DATABASE_URL ?? "";

  if (!url.startsWith("file:")) {
    console.error(
      `\n✗ 拒绝执行：DATABASE_URL 不是本地 SQLite 文件（当前：${url || "未设置"}）。\n` +
        "  db:reset 会删除整个数据库，只允许在本地演示库上执行。\n",
    );
    process.exit(1);
  }

  // 探测现有数据（库可能还不存在，忽略连接错误）
  const prisma = new PrismaClient();
  let foreign = [];
  try {
    const users = await prisma.user.findMany({ select: { email: true } });
    foreign = users.filter((u) => !u.email.endsWith(DEMO_EMAIL_DOMAIN));
  } catch {
    // 表还不存在或库为空，视为安全
  } finally {
    await prisma.$disconnect().catch(() => {});
  }

  if (foreign.length > 0 && process.env.SEED_FORCE !== "1") {
    console.error(
      `\n✗ 拒绝执行：数据库里有 ${foreign.length} 个非演示账号（例如 ${foreign[0].email}）。\n` +
        "  继续会连同这些数据一起删除。\n" +
        "  确认要清空，请执行：SEED_FORCE=1 pnpm db:reset\n",
    );
    process.exit(1);
  }

  console.log("✓ 安全检查通过，开始重建演示数据库…");
  execSync("prisma db push --force-reset", { stdio: "inherit" });

  // 复用 seed 的脚本（它自带同样的保护，此处库已空，会直接通过）
  execSync("tsx prisma/seed.ts", { stdio: "inherit" });
  console.log("✓ 演示数据库已重置完成");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});