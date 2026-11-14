// 内置 Skill：研发周会
// 适用：Scrum 周会、迭代同步会
// 特点：重点在「进度 / 阻塞 / 下一步」，而不是决策

import type { Skill } from "./index";

export const weeklyMeeting: Skill = {
  id: "weekly",
  name: "研发周会",
  description: "适用于定期进度同步会：谁做完了什么、被什么卡住、下周做什么。",
  bestFor: ["Scrum 站会", "迭代周会", "项目进度会"],

  focus: [
    "已完成的工作项（要具体到可验收的产出，不要「推进了一下」这种）",
    "阻塞项：谁被什么卡住，需要谁配合",
    "下周计划，以及计划对应的负责人",
  ],

  overviewGuide:
    "用 3-4 句话说明：本周整体进度、主要阻塞、下周重点。" +
    "如果是系统性阻塞（如资源不足、依赖未就绪），要单独点出来。",

  constraints: [
    "「完成了什么」必须是已交付的产出，进行中的不算完成",
    "阻塞项必须写清楚卡在谁/什么上，只写「有阻塞」没有价值",
    "如果会上提到砍需求或调整范围，这是决议，要单独列出",
    "owner 必须是原文提到的名字，不要根据项目分工推测",
  ],

  examples: [
    {
      input:
        "#2 李娜：转写视图初版周四能给到。但详情页的引用高亮我还没做，卡在接口还没定。",
      output: {
        actionItems: [
          { content: "给出转写视图初版", owner: "李娜", dueAt: "本周四", sourceTurnIdx: 2 },
        ],
        risks: [
          {
            content: "详情页引用高亮未完成，因接口未确定被阻塞",
            severity: "medium",
            sourceTurnIdx: 2,
          },
        ],
      },
    },
    {
      input: "#5 张伟：如果周五看不到可跑通的版本，我们就砍掉跨会议追问。",
      output: {
        decisions: [
          {
            content: "若周五仍无可跑通版本，则砍掉跨会议追问功能以保主线",
            sourceTurnIdx: 5,
          },
        ],
        risks: [
          {
            content: "周五前无可跑通版本将导致跨会议追问功能被砍",
            severity: "high",
            sourceTurnIdx: 5,
          },
        ],
      },
    },
  ],
};