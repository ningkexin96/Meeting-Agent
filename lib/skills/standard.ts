// 内置 Skill：标准会议纪要（默认）
// 适用：一般讨论会、对齐会、跨部门同步

import type { Skill } from "./index";

export const standardMinutes: Skill = {
  id: "standard",
  name: "标准会议纪要",
  description: "适用于大多数会议：对齐信息、形成决议、明确待办。",
  isDefault: true,
  bestFor: ["对齐会", "讨论会", "跨部门同步"],

  focus: [
    "明确拍板的决定（含取舍理由），而不是讨论过程中的各种可能性",
    "有明确负责人或截止时间的行动项",
    "可能影响交付的风险、阻塞、依赖",
  ],

  overviewGuide:
    "用 3-5 句话概括：会议要解决什么问题、达成了什么结论、接下来谁做什么。" +
    "写结论，不要复述过程。",

  constraints: [
    "决议必须是会上明确拍板的，讨论中提到的可能性不算",
    "待办的 owner 必须来自原文，原文没提就留空，不要推测",
    "风险要写清楚「会导致什么后果」，而不只是「有风险」",
  ],

  examples: [
    {
      input: "#1 张伟：我倾向先上线离线转写，实时能力往后放。这个事今天就定下来。",
      output: {
        decisions: [
          { content: "先上线离线转写，实时转写能力放到后续迭代", sourceTurnIdx: 1 },
        ],
      },
    },
    {
      input: "#3 李娜：我这周四之前能给到初版。",
      output: {
        actionItems: [
          { content: "给出转写视图初版", owner: "李娜", dueAt: "本周四", sourceTurnIdx: 3 },
        ],
      },
    },
  ],
};