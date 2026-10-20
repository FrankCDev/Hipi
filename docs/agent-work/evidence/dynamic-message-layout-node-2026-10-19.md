# 动态消息布局：Node 受控行为证据

日期：2026-10-19。范围：真实安装的 `@tanstack/react-virtual 3.14.21` / `virtual-core 3.19.6`，不修改生产组件、不新增依赖。

## 结果与重要限制

[定向测试](../../../apps/hipi-work-ui/test/workbench/conversation/conversation-dynamic-layout.test.ts) 12/12 通过，其中一项是**已知不理想行为的 characterization**，不能把全部通过解释为生产验收完成。

发现候选发布阻断风险：某行首次实测高度恰等于估计值，后来该行跨越视口顶边并增长时，库仍将其视为首次测量，补偿整个高度增量，可能把正在阅读的内容向下拖动。Node 已分别经 `resizeItem` 和 `measureElement` 入口复现；真实 DOM、实际 ResizeObserver 与应用组件是否触发仍需独立浏览器验证。

最小轨迹：100 行，估计高度 100，视口高度 600，scrollTop 2025；第 20 行起点 2000，视口相对位置 −25。先测量该行 100，再测量 500。实际 scrollTop 2425、相对位置 −425；理想的已测行增量语义应保留 2025、−25。

安装包 `node_modules/@tanstack/virtual-core/src/index.ts` 对应路径：

- 1950–1966：`measureElement` 缓存元素后委托 `resizeItem`，不会提前缓存尺寸。
- 2003–2049：只有 `delta !== 0` 才写入尺寸缓存。
- 2012–2025：首次测量按 `itemStart < scrollOffset` 补偿；已测行只在整行位于视口上方且非向上滚动时补偿。

这说明公开测量入口也经过同一逻辑，不仅是直接调用 resizeItem 的差异。但结构化元素 double 不能证明真实浏览器故障。未修改供应商文件，也未掩盖现状为修复成功。

## 已覆盖的受控行为

- 稳定 ID 的上方行展开 100→350、折叠 350→40，scrollTop 补偿且同一阅读行像素位置不变。
- 已有非零尺寸记录、跨越视口顶边的行增长/缩小，不拖动阅读位置。
- 底部连续 streaming 增长及缩短，包括滚动容器尺寸尚未提交导致的临时 clamp，提交后距底为零。
- 非底部 streaming 与 append 不跟随。
- partial→final 同 count、不同 key，显式捕获底部意图后跳到最新；非底部不跳转。这模拟组件策略，不证明 React effect 顺序。
- prepend 与已有行 resize 两种先后顺序、同次 sizer 提交前两次测量交错，随后新插入行重测，稳定 key 与相对像素位置不变。
- 800→1200 宽度观测后注入换行高度变化，阅读锚点不变。Node 不会自行换行，尺寸由测试提供。

模型使用公开选项、`resizeItem`、`measureElement`、`setOptions`、滚动命令、可见项读取，以及 React adapter 使用的导出生命周期入口 `_didMount` / `_willUpdate`。受控 rect/offset 回调、可钳制 scrollTop 和提交后的 scrollHeight 替代浏览器。断言验证可见 key、相对位置、滚动写入和距底，不依赖库私有缓存内容。

## 小规模计时样本

命令（从 `apps/hipi-work-ui`）：`node --test test/conversation-dynamic-layout.test.ts`。

- Node v24.19.0；Linux 6.18.55；AMD EPYC 9V74 80-Core Processor；运行环境报告 9 个逻辑 CPU。
- 单进程、2000 行、每样本 40 次确定性高度变化；1 次预热，5 次计时。
- 2026-10-19 此次实测每 40 次更新耗时：2.516、2.708、2.175、2.250、3.206 ms；中位数 2.516 ms。
- 最多返回 17 个虚拟行；每次更新都验证阅读锚点。
- 计时包含受控提交、可见行查询和断言，不包含创建模型、React、Markdown、CSS layout/paint、真实 ResizeObserver、网络或 Electron。宿主可能共享资源，不代表独占硬件或最低配置。
- 未设时间通过阈值，不将五个样本外推为 p95、帧率、用户交互延迟或产品性能预算。

## 验证范围

定向 Node 测试和该文件 Biome 检查已执行。另以独立严格 TypeScript 命令检查测试文件，因为 UI tsconfig 只包含 src/vite.config。全仓 `npm run check` 由主任务统一执行，避免并行全仓格式化。

未运行完整测试、生产 build、Electron、付费模型、三平台图形验收。本证据不替代组件浏览器 harness；底部意图、真实换行、选择区、滚动方向与 ResizeObserver 时序仍需在真实组件验证。

## 测量策略修复的独立复验

随后独立装配 [MessageMeasurementPolicy](../../../apps/hipi-work-ui/src/features/workbench/conversation/message-measurement-policy.ts)，通过真实 Virtualizer.measureElement 入口注入测量：

- 首次100、随后500的跨顶边行保持 scrollTop2025 / 相对位置−25。
- 上方展开与折叠、prepend同时重测、变宽后重测仍保留锚点。
- 底部streaming连续增量与缩短保持距底零；同count不同key的final捕获底部意图后仍跟随；非底部保持2025。

上述新增两项为修复后正确行为回归；裸库的已知限制 characterization 继续保留，用于区分供应商现状与应用适配结果。时序、选择区与方向策略另由策略定向测试和组件浏览器测试负责。本轮基准仍测裸库受控布局，不包含该适配策略开销。

该目录无 Git 元数据，git diff --check 不可用；测试/报告相对链接已检查存在，未冒称 Git 检查通过。
