// 删除会议 —— 对应 issue #30
//   DELETE /api/meetings/[id]
//
// 权限：meeting:delete（仅 owner）。删除会连带清掉转写、纪要、实时会话与语义索引，
// 属于不可逆操作，因此比"编辑纪要"更严格。
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { DeleteError, deleteMeeting } from "@/lib/meeting/delete";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard("meeting:delete");
  if (!g.ok) return g.response;

  const { id } = await params;
  if (!id) return NextResponse.json({ error: "缺少会议 id" }, { status: 400 });

  try {
    const result = await deleteMeeting(
      { tenantId: g.session.tenantId, userId: g.session.userId },
      id,
    );
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof DeleteError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    console.error("[meeting:delete] 未预期错误", e);
    return NextResponse.json(
      { error: `删除失败：${(e as Error)?.message ?? "未知错误"}` },
      { status: 500 },
    );
  }
}