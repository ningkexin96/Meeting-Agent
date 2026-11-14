// 样例会议素材 —— 对应 issue #3 的 seed 与 issue #7 的 mock ASR 数据源
// 一段 12 话轮的「项目周会」，包含决议、待办、风险各若干，便于演示抽取

export type SampleTurn = {
  speaker: string; // speaker_0 | speaker_1 | speaker_2
  startMs: number;
  endMs: number;
  text: string;
  confidence?: number;
};

export const SAMPLE_SPEAKERS: Record<string, { displayName: string; role: "owner" | "member" | "member" }> = {
  speaker_0: { displayName: "张伟（产品）", role: "owner" },
  speaker_1: { displayName: "李娜（前端）", role: "member" },
  speaker_2: { displayName: "王强（后端）", role: "member" },
};

export const SAMPLE_TRANSCRIPT: SampleTurn[] = [
  {
    speaker: "speaker_0",
    startMs: 0,
    endMs: 12_000,
    text: "今天这个会主要对一下会议纪要功能的上线节奏。先说一下背景，客户那边催得比较紧，希望月底能用上。",
  },
  {
    speaker: "speaker_0",
    startMs: 12_500,
    endMs: 26_000,
    text: "我这边倾向的方案是，先上录音上传加上离线转写，实时能力往后放。这个事今天就定下来。",
  },
  {
    speaker: "speaker_2",
    startMs: 26_500,
    endMs: 41_000,
    text: "只做离线的话，后端压力不大。主要问题是音频存储和清理策略，我们现在还没有对象存储，先用本地目录行不行？",
  },
  {
    speaker: "speaker_0",
    startMs: 41_500,
    endMs: 52_000,
    text: "可以，本地目录先用着，但要在文档里写清楚这是临时的，后面要换成对象存储。这个我来盯。",
  },
  {
    speaker: "speaker_1",
    startMs: 52_500,
    endMs: 68_000,
    text: "前端这边时间比较紧，纪要页如果要做成可编辑的富文本，两天肯定做不完。能不能先做字段级编辑，就是待办只改负责人和截止时间？",
  },
  {
    speaker: "speaker_0",
    startMs: 68_500,
    endMs: 79_000,
    text: "可以，先字段级编辑，富文本放到下个迭代。这个决定记一下。",
  },
  {
    speaker: "speaker_2",
    startMs: 79_500,
    endMs: 95_000,
    text: "还有一个风险，说话人分离我们没有声纹库，如果会上有外部参会的人，可能识别不准。我建议低置信度的部分标出来让人工修。",
  },
  {
    speaker: "speaker_0",
    startMs: 95_500,
    endMs: 108_000,
    text: "同意，低置信度必须有人工修正的入口。王强你负责把这部分做成可点击修改的。",
  },
  {
    speaker: "speaker_1",
    startMs: 108_500,
    endMs: 122_000,
    text: "我这周要先把转写视图做出来，按人分色展示，还要支持点引用跳回原话。周四之前能给到初版。",
  },
  {
    speaker: "speaker_0",
    startMs: 122_500,
    endMs: 136_000,
    text: "进度上我提醒一下，如果周五还没看到可以跑通的版本，我们就要砍掉跨会议追问这个功能，保主线。",
  },
  {
    speaker: "speaker_2",
    startMs: 136_500,
    endMs: 150_000,
    text: "另外提醒一件事，模型那边之前出现过输出格式不稳定的问题，结构化的纪要一定要做校验，不能直接写库。",
  },
  {
    speaker: "speaker_0",
    startMs: 150_500,
    endMs: 165_000,
    text: "对，这条是硬要求，所有写入都走统一的保存接口。那就这么定，下周一再对一次进度。",
  },
];

/** 用于「跨会议追问」的历史会议样例（seed 时生成） */
export const HISTORY_TRANSCRIPT: SampleTurn[] = [
  {
    speaker: "speaker_0",
    startMs: 0,
    endMs: 10_000,
    text: "上周对齐过排期，结论是月底发第一个可用版本，实时转写放到下个迭代。",
  },
  {
    speaker: "speaker_1",
    startMs: 10_500,
    endMs: 22_000,
    text: "排期我这边没问题，但如果中间加需求，就要重新评估。",
  },
  {
    speaker: "speaker_0",
    startMs: 22_500,
    endMs: 30_000,
    text: "好，那就按月底这个时间点走，新增需求一律进 backlog。",
  },
];