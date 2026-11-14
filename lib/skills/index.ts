// Skill 定义与加载 —— 对应架构文档「Skill 沉淀机制」
//
// 背景：原来抽取用的 prompt 直接写死在 lib/agent/pipeline.ts 里，
// 所有会议都是同一套规则。但周会关心「进度和阻塞」，客户沟通关心「需求和承诺」，
// 复盘关心「经验和改进项」——规则应该可配置，而不是写死在代码里。
//
// Skill = 一组「结构 + 关注点 + 示例」的声明，运行时拼进 prompt。
// 放在 skills/*.ts 里，加一个文件就多一种会议类型，不用改 pipeline。

import type { MinutesDraft } from "@/lib/tools";

export type SkillId = string;

export type Skill = {
  id: SkillId;
  name: string;
  description: string;
  /** 参与的角色说明，用于 UI 展示 */
  bestFor: string[];
  /** 抽取时关注什么 */
  focus: string[];
  /** 给模型的额外约束 */
  constraints?: string[];
  /** 概述怎么写 */
  overviewGuide: string;
  /** 少样本示例，显著提升真实模型的结构化质量 */
  examples?: { input: string; output: Partial<MinutesDraft> }[];
  /** 是否为默认 Skill */
  isDefault?: boolean;
};

const registry = new Map<SkillId, Skill>();

export function registerSkill(skill: Skill) {
  registry.set(skill.id, skill);
}

export function getSkill(id: SkillId | null | undefined): Skill {
  if (id) {
    const hit = registry.get(id);
    if (hit) return hit;
  }
  // 没指定就用默认
  for (const s of registry.values()) {
    if (s.isDefault) return s;
  }
  // 兜底：注册表为空时返回一个最小定义，保证流程不崩
  return {
    id: "fallback",
    name: "通用纪要",
    description: "通用会议纪要抽取",
    bestFor: [],
    focus: ["决议", "待办", "风险"],
    overviewGuide: "用 3-5 句话概括会议的主要结论。",
  };
}

export function listSkills(): Skill[] {
  return [...registry.values()];
}

/**
 * 把 Skill 拼成 prompt 片段。
 * 注意：这里只产出「规则部分」，转写正文由调用方拼接，
 * 避免每次改动正文格式都要动 Skill。
 */
export function buildSkillPromptPart(skill: Skill): string {
  const lines: string[] = [];

  lines.push(`## 会议类型：${skill.name}`);
  lines.push(skill.description);
  lines.push("");

  lines.push("## 抽取重点");
  for (const f of skill.focus) lines.push(`- ${f}`);
  lines.push("");

  lines.push("## 概述要求");
  lines.push(skill.overviewGuide);
  lines.push("");

  if (skill.constraints?.length) {
    lines.push("## 硬性约束");
    for (const c of skill.constraints) lines.push(`- ${c}`);
    lines.push("");
  }

  if (skill.examples?.length) {
    lines.push("## 示例");
    for (const ex of skill.examples) {
      lines.push(`输入片段：${ex.input}`);
      lines.push(`输出：${JSON.stringify(ex.output)}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}