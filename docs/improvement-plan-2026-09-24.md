# Oran Code 功能改进计划（2026-09-24）

> 来源：对 pi / ZCode / deepseek-harness 三个 Agent 项目的对比分析（见 2026-09-24 会话），
> 用户从中选定 8 项功能，本文档为代码边界审计后的可行性结论与分阶段 TODO。
> 审计范围：`packages/oran-code/src`，行号基于审计当日工作区版本，实施时以实际代码为准。

## 一、八项功能可行性总表

| # | 功能 | 现状 | 主要改动点 | 工作量 | 风险 |
|---|------|------|-----------|--------|------|
| 1 | 后台命令 + 超时晋升 | `run_command` 基于 `exec` 回调模型，无后台能力 | `process.ts` 改 spawn 流式模型；新增 JobManager（照抄 `subagent/background.ts` 骨架）；新增 `job_output`/`job_kill` 工具 | 2–3 天 | 中：进程底座重写 |
| 2 | web_fetch / web_search | 无任何 web/HTTP 工具；运行时依赖仅 4 个（刻意零依赖） | `tools/index.ts` 新增 `registerWebTools`；自写轻量 HTML 剥离（不可引 cheerio 类依赖）；HTTP 复用 `skills.ts` 的 redirect/timeout 模式 | 1–2 天 | 低 |
| 3 | microcompact + 输出压缩管线 | 历史 tool 结果只有"超阈值 offload"，无"早期结果占位清除"；bash 输出无 ANSI 清洗/聚合 | microcompact 插入 `offloadUnlocked` 候选循环；输出后处理挂 `ToolRegistry.invoke` 截断逻辑**之前** | 1–2 天 | 低：layering 已明确 |
| 4 | 截断保护 | **真缺口**：finishReason=length 时，若截断点恰落在 JSON 可解析处，语义残缺的 tool call 会被正常执行 | `turn-requester.ts` 收尾处判 `length/max_tokens` + 新增 `TruncatedToolCallsError`（登记进不可重试白名单） | ~0.5 天 | 低 |
| 5 | Spill 升级 | **已实现 80%**：全文落盘 + 占位含路径 + read_file 提示均存在（`persistToolResult`/`buildToolReplacement`） | 占位提示升级为 grep/search 语义；预览行数/字节参数化；可加过期清理策略 | ~0.5 天 | 低 |
| 6 | 错误分类 | 已有三分支（abort / 不可重试 4xx+contract / 退避重试）+ Retry-After 遵守 + trace 落 `model_retry` step | `retry` 事件 payload 扩结构化 `category` 字段（`rate_limit/network/http4xx/empty/protocol`） | ~0.5 天 | 低 |
| 7 | 压缩公式化 | 触发已是 `W − O − headroom` 形态，缺 `W×0.8` 档；保留量为固定 12k tokens/5 条；**无重复压缩锚点**（摘要的摘要） | 触发公式加一行 `Math.min(window*0.8, threshold)`；`selectRecentRawMessages` 改百分比+透传 window；锚点需 metadata 记录覆盖边界 + 增量摘要提示词 | 2–3 天（锚点占大头） | 中：摘要契约变更 |
| 8 | 对话级 rewind | 只有文件级 `/undo`（SnapshotStore，HEAD 一致才回滚）；无消息↔taskId 映射 | 简单版：复用 `session-reset` 逻辑截断通路，session-store 零改动；完整版：user 消息补 `metadata.taskId` + `SnapshotStore.restoreBefore()` | 简单 0.5–1 天；完整 +2–3 天 | 中：冲突语义需定义 |

## 二、重构决策：拆 `context/ 目录，其余不重构

**结论：本次只做一次重构 —— 把 `context-manager.ts`（1188 行）拆为 `src/context/` 目录。**

理由（审计实证）：
1. 四类职责已混在一个类里：估算（~180 行）/ offload+spill（~230 行）/ LLM 压缩（~450 行）/ 恢复+归档（~120 行）；
2. 本次功能 3（microcompact）、5（spill）、7（压缩公式+锚点）恰好各落一个模块，不拆则全部叠进同一文件，且 microcompact 需与 offload/recent 保留做语义协调，review 互相干扰；
3. 外部调用点仅 4 处（`turn-requester.ts`、`tool-executor.ts`、`session-command-handlers.ts`、`session.ts`），保留 `ContextManager` facade 对外零破坏；
4. 面试手册把 `context-manager.ts` 作为单文件阅读项（手册 L1371）并详列其阈值——拆分后一次性更新手册即可。

目标结构：

```
src/context/
  manager.ts     — ContextManager facade + 锁 + CONTEXT_LIMITS
  estimator.ts   — estimateTokens / resolveContextWindow / usageAnchor
  pruner.ts      — microcompact（新）+ offload 遍历与配额 + selectRecentRawMessages
  spill.ts       — persistToolResult / buildToolReplacement / 读回路径约定
  compaction.ts  — compact 流程 / requestSummary / extractSummary / 锚点 metadata
```

**其余功能均不需要架构级重构**：
- 后台命令的 `process.ts` exec→spawn 属于单文件内部重写，不是重构；
- rewind 简单版复用现成 `session-reset` 通路；
- web 工具、截断保护、错误分类均为新增点状代码。

**明确不做**（防范围蔓延）：bash 输出管线挂 `tools/registry.ts`，属于 tools 层，不得顺手塞进 `context/`；不重写 session-store；不动 subagent 体系。

## 三、分阶段 TODO

每个 Stage 完成标准：编译验证通过（`pnpm build` / `tsc`）+ 相关既有测试不回归（遵循 AGENTS.md，不做全量测试）。

### Stage 0 — context/ 拆分（零行为变化重构）
- [ ] 按"二"的结构搬迁代码，`context-manager.ts` 改为 re-export facade
- [ ] 编译通过；既有 context 相关测试原样通过（不改测试即证明零行为变化）
- [ ] 手册暂不更新（行为未变，口述口径仍成立），只需在 §8 阅读路线登记新路径

### Stage 1 — 截断保护 + 错误分类（两个独立小项）
- [ ] 截断保护：`turn-requester.ts` 在 `streamResponse` 收尾判 `finishReason==="length"/"max_tokens"` 且有 completedToolCalls 时，抛 `TruncatedToolCallsError`（新类型，加入 `streamWithRetry` 不可重试白名单），controller 侧为所有 call 合成"未执行"记录（复刻 `controller.ts:427-444` 的 finalTurn 模式）
- [ ] 错误分类：`retry` 事件 payload（`types.ts:409`）增加 `category` 字段，分类逻辑集中在 `turn-requester.ts:288-335`
- 依赖：无；可与 Stage 0 并行

### Stage 2 — 后台命令 + 超时晋升
- [ ] `process.ts`：exec → spawn(shell:true) 重写，手动拼接输出 buffer，settle/promote 状态机；`killProcessTree`、路径包含校验、Windows 诊断保留复用
- [ ] 新增 `src/controller/job-manager.ts`：照 `subagent/background.ts` 骨架（Map + 并发上限 + AbortController + notified 标记）；stdout 快照防抖落盘照 `subagent/state-store.ts` 模式
- [ ] 通知回收：挂现有 `runtimeReminders` 钩子（`session.ts:834`）+ 收尾落账（`session.ts:882-890`），TUI 零改动
- [ ] `run_command` 加 `run_in_background` 参数 + 超时晋升；新增 `job_output`/`job_kill` 工具（permissionLevel 3，kind command）
- 面试卖点：POSIX 进程组杀现有 bug 顺手修（`exec` 未设 `detached:true`，`-pid` 不可靠）

### Stage 3 — web_fetch / web_search
- [ ] `tools/web-tools.ts`：`web_fetch`（permissionLevel 0，kind readonly，cacheable:false，maxOutputChars 声明），HTTP 层抄 `skills.ts:430-440`（AbortSignal.timeout + 手动 redirect），错误用 `provider/errors.ts` 的 `boundedError`
- [ ] HTML→文本：自写轻量剥离（script/style 剔除、标签折叠、实体解码、链接保留），**零依赖**；README 注明这是刻意的依赖纪律
- [ ] `web_search`：provider 无关的可配置端点（settings 配置 search endpoint/key，无配置则工具不出现在 schema 或返回明确错误），`deferred: true` 经 `search_tools` 激活以省 schema 体积
- [ ] `TOOL_SEARCH_ALIASES` 补别名（手册 L159/L174 口径要联动）

### Stage 4 — microcompact + 输出压缩管线 + spill 提示升级
- [ ] microcompact：在 `context/pruner.ts` 新增确定性 pass——最近 N 条 tool 结果保原文，更早的 ≤32KB 结果替换为 `[Old tool result content cleared]`；**>32KB 仍走 offload 保路径**（两机制不重叠）；复用 `replacements` Map 冻结语义，同一 id 只有一条终态替换文本
- [ ] 输出管线：`types.ts` `ToolDefinition` 加可选 `postprocess` 字段；在 `registry.ts:88-98` 截断**之前**执行（先清洗再限量）；run_command 注册：strip ANSI + 测试输出聚合（pytest/Jest/vitest 汇总行提取，v1 保持简单启发式）
- [ ] spill 升级：`buildToolReplacement` 提示改为 grep/search 语义 + `CONTEXT_LIMITS.previewBytes/previewLines` 参数化

### Stage 5 — 压缩公式化
- [ ] 触发：`shouldAutoCompact` 加 `Math.min(window * 0.8, threshold)`
- [ ] 保留量：`selectRecentRawMessages` 阈值改 `window * 0.16`，透传 window（改签名+唯一调用点），固定 token 数作下限兜底
- [ ] 增量锚点：summaryMessage 的 `metadata` 写入覆盖边界（最后覆盖消息标识）；`compactUnlocked` 识别上一条 context-summary 锚点，只对锚点后新消息请求增量摘要（`buildSummaryRequest` 加"已有摘要+新增对话"分支提示词）
- 依赖：Stage 0 完成后做（代码已就位在 context/compaction.ts）

### Stage 6 — 对话级 rewind
- [ ] 简单版先做：`/rewind [N]`（`commands.ts` action + `session-commands.ts` case + `session.ts` port），找到第 N 个 `User message:\n` 索引截断 conversation → `persistTuiSession()` 自动走 `session-reset`；TUI 复用 `/session` 选择器基建；截断点只落在完整 tool 链外
- [ ] 完整版：`persistQueuedUserMessage()` 给 user 消息写 `metadata.taskId`；`SnapshotStore.restoreBefore(sessionId, taskId)`（复用 HEAD/包含性/conflict 校验 + `restoreEntry`，链式标记后续 manifest 为 undone）；选择器逐 turn 列出 will-revert 的 changedPaths + 二次确认
- 已知限制（写进命令 help 与手册）：rewind 只能作用于最后一次 compaction-boundary 之后；只读 turn 无快照，文件恢复取"最近的前一个 mutating 任务的 preTree"
- 依赖：无硬依赖，建议排在 Stage 2 之后（后台 job 也写 session 事件，先稳定事件流）

### Stage 7 — 面试手册更新（全部改造完成后执行）
更新顺序（行号为 2026-09-24 版本）：
1. **§8 阅读路线（L1367-1375）**：`context-manager.ts` → `context/` 目录各文件；新增 `job-manager.ts`、`web-tools.ts`、`snapshot.ts`（restoreBefore）
2. **§3 架构表（L87-99）**：Context Manager 行改写；工具栈行加后台 job/web 工具； SnapshotStore 行加 rewind
3. **§4.2/4.3 代码证据（L156-162、L192-197）**：工具数量口径从"18 个内置"更新；CONTEXT_LIMITS 阈值与压缩公式的新实测值；旧口径按手册既有惯例标注"作废，不得再引用"（参考 L154/L162 模板）并注明提交哈希
4. **§5 Q7（L531-567）**：压缩触发公式/保留 16%/增量锚点的新口径；Q8 后台任务池区分"subagent 池"与"shell job 池"
5. **§5.5 口述稿**：5.5.3（压缩）、5.5.4（后台）、5.5.7（undo 扩展为 undo/rewind 两级）
6. **§7 P0 清单（L1318-1334）** 与 **§9 STAR（L1411）**：最终口径同步
7. **§6/§10**：自测项加"说明 rewind 简单/完整两级语义与 compaction 边界限制"
8. 新手册增加一条"已知边界"：web 工具 HTML 抽取为零依赖自写实现，能力弱于 readability 类库（这是面试可以主动讲的取舍）

## 四、验证纪律（遵循 AGENTS.md）

- 不做全量测试驱动；每个 Stage 以**编译验证**为准（`pnpm build`），涉及 runner 执行路径的 Stage（2/6）补该模块的单测
- Stage 0 重构的验收金标准：**既有测试零修改全绿**
- 推送前走既有的 CI 六步复现（frozen-lockfile 第一）

## 五、遗留决策点（实施前用户确认，默认值已给出）

1. web_search 端点：默认"settings 可配置，无配置则不暴露"——避免内置任何家 API
2. rewind：先交付简单版，完整版视简单版使用反馈再做——默认采纳
3. microcompact 占位符不可找回 vs offload 可找回：按 32KB 分界两套共存——默认采纳（审计建议方案）

---

## 六、实施结果（2026-09-24 完成）

8 个 Stage 全部落地，`pnpm build` 与全量测试通过（405 tests）。与原计划的偏差、以及实施中发现的新事实记录如下。

### Stage 0 — context/ 拆分 ✅
实际结构比计划多一个 `limits.ts`（阈值常量独立成文件，避免 manager ↔ pruner 循环依赖）：
`src/context/{limits,estimator,pruner,spill,compaction,manager}.ts`，`src/context-manager.ts` 降级为 facade。
验收：既有测试**零修改**通过（29 tests，含 context-manager / token-estimate / tool-executor）。

### Stage 1 — 截断保护 + 错误分类 ✅
- 截断保护做成"整条消息判败"而非抛错：`ModelResponse` 增 `truncated` 标记；provider 侧（OpenAI 非流式解析、流末补发；Anthropic 非流式）在截断时**不交工具调用**，requester 侧再丢弃兜底；controller 注入一次"分小步继续"纠偏提醒，连续 3 次（`MAX_TRUNCATION_RECOVERIES = 2`）或最后一轮截断即失败收尾。
  - 发现：截断参数若"恰好 JSON 可解析"会被真正执行的隐患，已由该路径消除；截断 JSON 也不再走重试白耗（此前会重试到耗尽）。
- 错误分类：`classifyModelRetry` 落在 `controller-utils.ts`，新增 `EmptyModelResponseError` / `ToolCallParseError` 便于归类；`retry` 事件与 trace 的 `model_retry` step 都携带 `category`（可选字段，保持既有 fixture 兼容）。

### Stage 2 — 后台命令 + 超时晋升 ✅
- `tools/process.ts`：新增 `startCommand`（`spawn` + shell，POSIX `detached` 独立进程组，输出双缓冲 200k 上限，快照可随时读取）；`executeCommandWithProcessTree` 保留给既有调用方。
- `tools/jobs.ts`：`ShellJobManager`（进程内、无持久化、`process.once("exit")` 统一 killAll）+ `shellJobNotification` 通知文本 + `formatJobOutput`。
- `run_command` 新增 `run_in_background` 与超时晋升；新增 `job_output` / `job_kill`。
- session 侧通知回收复用子代理的两条既有通路（`runtimeReminders` + 任务收尾落账）；TUI 增 `kind: "job"` 区分：footer 显示 `N jobs running`，状态行显示 `[N background job: <cmd>]`。
- **偏差**：`job_output` 定为 `permissionLevel: 0 / kind: readonly / cacheable: false`（审计稿写的是 level 3）；读取作业输出是只读行为，要求审批会妨碍收割。`job_kill` 维持 `level 3 / kind: command`（会审批）。
- 顺手修复：POSIX 下 `exec` 未设 `detached`，`killProcessTree(-pid)` 实际不可靠；`spawn` 化后负 pid 才真正杀掉整棵进程树（与手册 Q3.5 的口径一致）。

### Stage 3 — web_fetch / web_search ✅
- `tools/web-tools.ts`：`htmlToText` 零依赖抽取（剥脚本/样式/注释/`<head>`，块级标签转换行，命名+数字实体解码，空白压缩）；`assertFetchableUrl` SSRF 防护（仅 http(s)、内网/回环/ULA/链路本地拒绝、逐条校验 DNS 解析结果、重定向逐跳复检，最多 5 跳）。
- `web_fetch`：`permissionLevel 2 / kind readonly / cacheable false`，正文上限默认 32,000 字符，可配置 `web.fetchMaxChars`。
- `web_search`：`deferred: true`（省首轮 Schema）；tavily（POST + api_key）或 searxng（GET + `format=json`）两种后端，未配置时返回明确指引。
- 配置：`UserConfig.web`（`enabled/searchProvider/searchEndpoint/searchApiKey/fetchMaxChars/allowPrivateHosts`），含 normalize / merge / save 三段接线。
- **偏差**：`web_fetch` 默认不审批（只读 kind）。取舍理由：内网已由 SSRF 防护挡住，外网抓取是只读 egress；需要更严的团队可用 permission rule 拒掉，shell 里的 `curl` 仍逐次审批。这一点已写进手册的"已知边界"。

### Stage 4 — microcompact + 输出管线 + spill 升级 ✅
- `pruner.ts` 新增 `microcompactConversation`：最近 `microcompactKeepResults = 8` 条之外、且 ≥`microcompactMinBytes = 4_000` 的历史结果先落盘再替换为 `<cleared-tool-result>`（只含字节数 + 路径 + `read_file`/`search_code` 提示，约 200 字节）；落盘失败即保留原文。
- `spill.ts`：`persistSpilledResult`（返回占位文本）重构为 `spillToolResult`（返回相对路径）+ `buildToolReplacement` / `buildClearedReplacement` 两个占位构造器，使两层策略共用同一落盘实现。
- `tools/output-pipeline.ts`：`stripAnsi` + `collapseRepeatedLines`（≥3 连续相同非空行折叠并标注次数）+ `compactShellOutput`；通过 `ToolDefinition.postprocess` 挂在 `ToolRegistry.invoke` 的**截断之前**，清洗抛错时回退原始输出。
- 偏差：原计划的"聚合测试输出"未做——纯启发式摘要一旦猜错就是静默丢信息，v1 只保留无歧义的清洗（这也是与 pi-rtk 那类全量管线的差别）。

### Stage 5 — 压缩公式化 ✅
- 触发：`min(floor(W × automaticWindowFraction 0.8), W − 20k − 13k)`；保留窗口：`max(recentRawTokens 12k, floor(W × recentRawFraction 0.16))`，`selectRecentRawMessages` 新增可选 `contextWindow` 参数（不传保持旧行为）。
- 增量锚点：锚点 = 历史里上一条 `context-summary` 消息（不需要额外索引/指纹）；`readSummaryCarryover` 取出正文与 `metadata.summaryCoverage`，`buildSummaryRequest` 在有携带量时追加 `<existing-summary>` 与"更新而非重写"的指令；`extractSummary` 从旧摘要回收 `<user-message>` 块，保证第 6 节的用户原话跨压缩携带；新摘要的 metadata 继续累计覆盖统计（供恢复消息与下一轮锚点使用）。

### Stage 6 — 对话级 rewind ✅（简单版 + 文件联动）
- `/rewind` 列表 → `/rewind N` 截断对话（走既有 `session-reset` 逻辑截断通路，归档原始行保留）；TUI 用 `InkTuiApp.rewindToUserMessage` 同步截断转写区；`message-utils.ts` 新增 `isUserTurnMessage` / `isSteeringMessage` / `userTurnIndices`（steering 插话不算独立轮次）。
- `/rewind N --files`：控制器在 user 消息上写 `metadata.taskId`（打通轮次 ↔ 快照 manifest），`SnapshotStore.restoreBefore(sessionId, taskId)` 做链式回滚——校验 HEAD 未变、链上每个 manifest 都已完成、每个 `postTree` 等于下一个 `preTree`、当前文件仍是链尾状态、条目类型可恢复；通过后恢复 `preTree` 并把该轮及之后的 manifest 标为 `undone`。任一校验失败即拒绝（与 `/undo` 同一条"宁可让用户用 Git 排查"的原则），且**对话不动**。
- **未做**：交互式选择器（用"列表 + 编号"替代）；`/tasks` 列表里 shell 作业的专门面板（只有徽标）。

### 实施中发现、值得记录的两点

1. **手册先于代码说对了**：手册 Q3.5 早就写"Unix 上用 `spawn` + `detached: true` 再杀 `-pid`"，而改造前代码是 `exec` 且未 detached——Stage 2 的 spawn 化让代码第一次与这句话一致。
2. **端到端测试踩到 run 循环语义**：`session.run()` 里第一行 prompt 未结束时写入的第二行会被当作 steering（`submitUserPrompt` 的分支逻辑），所以 rewind 的会话级测试改为"建会话 → 直接驱动端口方法"，避免与主循环时序耦合。

### 第二轮（2026-09-24 同日，继续优化两个候选）✅

**截断保护的文本续写汇聚**（`8fbcf16`）：
- 区分两类截断：`ModelResponse.truncatedToolCalls` 记录被丢弃的调用数（provider 解析层经 `response_complete.droppedToolCalls` 上报，与 requester 兜底层合计）。只有"零调用"的截断算纯文本截断，其文本参与汇聚——带调用的截断文本多半只是前言，混进答案会失真。
- 纯文本截断各段按到达顺序累积；正常收尾时拼在最后一段之前；预算耗尽（或最后一轮截断）时，只要收到过文本就按 `completed` 收尾并把 `[output truncated ...]` 附在结果末尾，一段文本都没收到才仍然 `failed`。
- 续写指令补上"已收到约 N 个字符 / 从断点接着写、不要重述 / 优先分块输出"；每次截断写一条 `model_truncated` trace step（recovery 序号、字符数、丢弃调用数、是否纯文本）。
- 仍未覆盖：截断与成功轮次交错时的汇聚上限（当前只在"连续截断"路径汇聚）、`maxSteps` 耗尽时的汇聚。

**web_search 后端扩展与结果去重**（`f3ce0e9`）：
- 后端从 2 种扩到 4 种：tavily / searxng / brave（`X-Subscription-Token`）/ google（Programmable Search，key + `cx`）；配置新增 `web.searchEngineId`，normalize 接受四个 provider 并对非法值报错；provider 未显式指定时沿用既有推断（配了端点按 searxng，否则 tavily），老配置行为不变。
- 去重按归一化 URL（小写主机、去 www、去尾斜杠、去 fragment、剔除 `utm_*`/`fbclid`/`gclid`/`msclkid`/`mc_cid`/`mc_eid`/`ref` 等跟踪参数、其余 query 排序）：保留先出现的位置与标题，摘要取更长的一条；输出头部标注 `deduped="N"`。
- 仍未覆盖：更多后端（如国内可用端点）、按域名折叠同一站点的多个页面（当前只按页面级 URL 判重）。

### 仍未覆盖（下一阶段候选）

- microcompact / 压缩阈值按真实长会话调参（当前是公式默认值）；
- shell 作业的 `/tasks` 专属面板（持久化恢复倾向不做，与"进程即生命周期"的设计冲突）；
- 截断保护的汇聚上限与 `maxSteps` 耗尽路径；
- web_search 的更多后端与站点级折叠。
