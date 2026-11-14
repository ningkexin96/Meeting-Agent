# PR 拆分方案（基于实际代码演进）

> 上次规划作废。核查后发现：基线 `03c09e2` 已包含 ASR / 声纹 / 检索的**全部核心实现**，
> 随后的 `cf7ca55` `401bcf4` `430e05c` 只是补测试脚本。
>
> 真正的功能演进从 `6723da6`（实时流式）开始。

## 真实演进路径

```
03c09e2  基线：全套骨架 + mock 转写 + mock LLM + 声纹聚类 + 检索
  ↓
6723da6  实时流式转写（首个真实增量）
  ↓
8145a6e  修复检索误召回
  ↓
134c633  UI 按 Miniclaw 重构
  ↓
e11cbe2  修复运行视图一直转圈
  ↓
c011f34 + 7c3eac0  接入真实大模型 DeepSeek
  ↓
36c9200 + 41ea9c4  实时链路打通 DashScope WebSocket
  ↓
88cc1a1  修复无音频静默注入数据
  ↓
15d806d  可配置 Skill 机制
  ↓
40118c4  登录注册（bcrypt + Session 表）
  ↓
e2cb80b  修复声纹全部识别成同一人
  ↓
e86e055 + 71fd9d8  云原生说话人分离
```

---

## 7 个 PR

| # | 分支 | 标题 | 提交 | 关联 Issue |
|---|---|---|---|---|
| 1 | `feat/01-core` | 核心骨架与基线能力 | `03c09e2` + 三个测试提交 + 文档 | #1 |
| 2 | `feat/02-realtime` | 实时流式转写与增量纪要 | `6723da6` `8145a6e` | #2 |
| 3 | `feat/03-ui` | 按 Miniclaw 重构 UI | `134c633` `e11cbe2` `88cc1a1` | #3 |
| 4 | `feat/04-real-llm` | 接入真实大模型 DeepSeek | `c011f34` `7c3eac0` | #4 |
| 5 | `feat/05-cloud-asr` | 云 ASR 实时链路（DashScope WS） | `36c9200` `41ea9c4` | #5 |
| 6 | `feat/06-skill` | 可配置 Skill 机制 | `15d806d` | #6 |
| 7 | `feat/07-auth` | 认证体系重建 | `40118c4` | #7 |
| 8 | `feat/08-diarization` | 云原生说话人分离 | `e2cb80b` `e86e055` `71fd9d8` | #8 |

文档提交 `a7a861d` `2f0e327` `09ba4c2` `d23b3f9` `97a5468` 并入相应 PR。

---

## 执行方式

1. 从 `03c09e2` 建 `feat/01-core`，用 `git checkout <commit> -- <paths>` 取文件终态
2. 逐个 PR：`git checkout -b feat/0N-xxx feat/0(N-1)-xxx` 后应用该 PR 的文件快照
3. 每个分支推送后创建 PR，正文 `Closes #N`
4. 合并到 main

**关键**：每个分支都是「该功能完成时」的真实可运行状态。