import { describe, expect, it } from "vitest";
import { InkTuiApp } from "../src/tui/ink-app.js";
import type { TuiAppOptions } from "../src/tui/types.js";

/**
 * 渲染提交调度的回归测试:在不启动真实 Ink 的情况下驱动
 * invalidate / flushPendingRender 的真实事件循环时序。
 * 背景:提交窗口(Ink reconciler/stdout 写入期间)内被吞掉的 revision
 * 永远没有提交帧,等待它的 assistant_end waiter 会把运行时事件永久挂起,
 * 表现为任务完成后 TUI 不推进、直到手动停止才显示 Done。
 */

interface RenderInternals {
  renderRevision: number;
  committedRenderRevision: number;
  inkInstance: { rerender: () => void; unmount: () => void } | undefined;
  invalidate: () => void;
}

function makeApp(): { app: InkTuiApp; internals: RenderInternals } {
  const fakeOutput = {
    isTTY: false,
    columns: 80,
    write: () => true,
  } as unknown as NodeJS.WriteStream;
  const options = {
    input: fakeOutput,
    output: fakeOutput,
    getWorkspace: () => "ws",
    getModelLabel: () => "test-model",
  } as unknown as TuiAppOptions;
  const app = new InkTuiApp(options, {
    render: (() => ({ unmount: () => {} })) as never,
  });
  const internals = app as unknown as RenderInternals;
  // 绕过真实 Ink,但保留 rerender/setImmediate 的真实时序。
  internals.inkInstance = { rerender: () => {}, unmount: () => {} };
  return { app, internals };
}

describe("TUI render commit scheduling", () => {
  it("commits revisions bumped inside the ink commit window (regression: assistant_end deadlock)", async () => {
    const { app, internals } = makeApp();
    try {
      internals.invalidate(); // revision 1 进入调度
      await Promise.resolve(); // microtask 捕获 revision 1,进入提交窗口
      internals.invalidate(); // 提交窗口内 revision 涨到 2;修复前这次渲染被吞掉

      const pending = app.flushPendingRender("terminal"); // 注册 revision 2 的 waiter
      await pending; // 修复前:此 promise 永远挂起
      expect(internals.committedRenderRevision).toBe(2);
    } finally {
      app.destroy();
    }
  });

  it("releases boundary waits instead of hanging when a commit never arrives", async () => {
    const { app, internals } = makeApp();
    try {
      // 模拟 revision 已推进但提交帧永远缺失(退化场景)。
      internals.renderRevision = 7;
      const started = Date.now();
      await app.flushPendingRender("terminal");
      expect(Date.now() - started).toBeLessThan(5_000);
      // 兜底路径强制补了一次渲染,committed 应追上 revision
      // (补渲染本身会使 revision 再 +1,因此是 >= 而非精确相等)。
      expect(internals.committedRenderRevision).toBeGreaterThanOrEqual(7);
    } finally {
      app.destroy();
    }
  });

  it("normal commits return immediately without waiting for a frame", async () => {
    const { app, internals } = makeApp();
    try {
      internals.invalidate();
      // normal 类型不注册 waiter,即使 revision 尚未提交也立即返回。
      await expect(app.flushPendingRender("normal")).resolves.toBeUndefined();
    } finally {
      app.destroy();
    }
  });
});
