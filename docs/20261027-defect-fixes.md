# 2026-10-27 缺陷修复记录

## Node 测试摘要未被进度采集识别

修复前，`extractEvidence()` 只处理 `Tests:` 和数字在前的摘要，无法读取 Node 内置测试的 `ℹ tests / pass / fail` 或 TAP 的 `# tests / pass / fail`。

修复在 `packages/oran-code/src/progress/capture.ts`：

- 去除终端控制字符，识别 Node 的两种摘要格式。
- 使用报告给出的 tests 总数，保留跳过、取消、todo 对总数的贡献。
- 同一输出有多个 Node 摘要时使用最后一组，拒绝不完整或通过加失败大于总数的摘要。
- 保留原有 Vitest/Jest/pytest 解析和测试命令签名，不跨命令比较计数。

## 验证

按仓库约定，本次未运行全量测试套件、未新增持久化测试文件。

- `pnpm build`：通过。
- `pnpm typecheck`：通过。
- 修改文件的 Prettier 与 ESLint 检查：通过。
- 对构建产物执行临时断言：12 组摘要格式、4 组无效或文件级摘要、不同命令签名，全部通过。
- 使用独立评测项目原有 `probes/test-evidence.mjs` 读取 baseline02 第 10 题的真实输出：得到 `testsPassed=3`、`testsTotal=3`，`matched=true`。没有调用模型，没有修改历史批次或原始日志。

这次诊断只验证摘要采集，不代表重新完成 Agent 任务评测，也不能据此更新任务成功率。

README 同时明确：Git Worktree 分离代码工作副本，不提供操作系统级隔离。
