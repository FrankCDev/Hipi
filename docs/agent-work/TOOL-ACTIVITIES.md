# 工具活动与成果入口

日期：2026-10-19。本文记录当前源码行为与现有测试的覆盖边界，不代表真实桌面 GUI、三平台或生产就绪验收通过。授权操作另见[工具授权](TOOL-AUTHORIZATION.md)，文件边界见[文件服务](FILE-SERVICE.md)与[工作台](WORKBENCH.md)。

## 1. 用户看到什么

会话中的“工具活动”摘要显示上次读取的一个活动：优先取当前页仍在执行的任务，否则取首项。它不是完整任务进度，也不统计整个会话的成功率。打开“查看活动”后，可以刷新本页、回首页、读下一页、展开已保留输出，以及查看有文件引用的当前文件。

活动卡分别显示执行状态、工具结果、来源、取消请求、文件影响与可用的证据标识。内置文件工具有中英文名称，未知扩展保留工具名；原始工具 / 活动、授权和回执标识按需展开。没有受控的成果打开回调时，不显示文件操作按钮；不会把工具输出拼成 URL 或直接打开宿主路径。

## 2. 两段扫描，不是全局时间线

[getToolActivities 的 Storage 实现](../../packages/work-runtime/src/activities/storage.ts)先扫描 `tasks`，再扫描 `entries`：

1. `tasks`：当前 Durable 会话的 `pi.tool` 任务，按任务 ID 降序。
2. `entries`：当前会话可见的条目，按条目 ID 降序；只投影工具结果，跳过已经由本地 `pi.tool` 任务表示的结果。包含继承结果，以及没有对应本地工具任务的直接生成结果。

每次最多扫描 16 个任务或条目。因此结果页可以为空但仍有 `nextCursor`，不能把空页当作历史结束。两个区段不是按发生时间混排；任务 ID、条目 ID、执行时间也不是同一个排序维度。

首次读取分别记录任务和条目的上界；后续游标沿用该成员边界（`membershipFence`），不会把后来插入的记录加到同一轮翻页中。记录的当前状态仍会变化，因此该边界不是事务一致快照。刷新首页重新取上界，带游标刷新本页沿用原边界。

分支会话只枚举自己的任务与分支可见条目，不追溯父会话任务的后续状态。继承结果标记 `inherited`，执行状态为 `unavailable`，不能据此推定原任务是否完成。没有持久结果条目的嵌套任务也可能显示“执行已完成 / 工具结果不可用”。

游标绑定 store、工作区、公开会话 ID、Durable 会话 ID、generation 和读取种类；文本游标还绑定活动、结果条目与偏移。错误作用域拒绝为 `INVALID_REQUEST`，generation 变化为 `CURSOR_STALE`。这些游标是读取位置，不授予访问权限。

## 3. 执行结束、结果成功、副作用确认分别判断

例如，同一张卡可以同时显示“执行已完成”和“工具结果：错误”。这是合法事实组合，不应合并成绿色成功状态。

- `phase` / `outcome`：Durable 任务的执行阶段与结束原因。`terminal` 只表示执行结束；`completed` 也不保证工具返回成功。
- `toolResult`：从关联的持久工具结果判断 `success`、`error` 或 `unavailable`。无证据时不能根据任务完成补出成功。
- `effect.status`：独立的文件操作证据。`prepared`、`executing` 尚未确认；`conflict` 为版本冲突；`confirmed` 为已记录确认；`unknown` 仍是未知。
- `observed_match`：当前内容与预期匹配，但原始写入尚未确认。不能包装为 `confirmed`、自动重试成功或 exactly-once 证明。
- `abortRequested`：已请求取消，不证明外部修改回滚。

授权的记录状态与是否超过有效期也是不同字段。读取时可以算出 `expired`，但不会改写授权状态、触发核对或消耗授权。当前卡片只展示授权标识及记录状态，并未单独展示 `expired` 字段。

## 4. 只读投影与权限边界

[应用核心](../../packages/work-runtime/src/core.ts)将两个活动读取方法直接路由到 [StoreCatalog](../../packages/work-runtime/src/store-catalog.ts)，经独立 Storage 读取工作区和会话元数据；不进入打开执行工作区的 Harness 路径，不恢复 provider、调度工具或写入操作确认。Storage 在 `finally` 关闭。这里的“只读”指业务读取不提交执行状态，不声称 SQLite 文件以 OS 只读模式打开，或整个 runtime 启动绝不写 catalog。

读取校验工作区身份、会话映射和 generation。任务结果必须匹配当前会话、任务和 call ID；授权、grant、文件操作记录必须相互匹配作用域与标识，否则拒绝返回。摘要不会包含工具参数、拟写入正文、原文件正文、完整任务记录或内部异常。

这是可重建的持久事实投影，不是新建一套执行状态，也不是权限沙箱。活动 API 不接受 `resume`、`reconcile`、宿主路径或调用方指定分页大小。当前文件访问权限在成果打开链路重新校验，不能由旧活动记录代替。

## 5. “读取已保留原文”的准确含义

[输出投影](../../packages/work-runtime/src/activities/projection.ts)只提取持久工具结果的文本内容；图片等非文本内容不在此入口返回。它不重新运行工具、不读工具参数、不恢复被截掉的输出，也不是日志或原始全量输出导出。

诊断必须有可确认的序列化来源，才可从末尾移除：按保存的诊断记录重建精确的 `<harness>` 文本并匹配末块，不靠字符串前缀猜测。工具自己输出的同名标签仍保留；诊断边界缺失或不匹配时，文本不可用，避免把内部异常当成用户原文。

每段最多 8192 UTF-8 字节，按完整 Unicode 字符切分，游标拒绝落在 UTF-16 代理对中间。UI 用转义后的纯文本 `<pre>` 展示，非 HTML、Markdown 或可执行终端内容；上一段被下一段替换，不累积整段输出。上游截断会单独提示，当前入口无法恢复缺失部分。

`retainedOutputOnly: true` 表示接口只返回已持久化的工具输出，不表示该输出曾被截断；未截断输出同样为 `true`。截断事实由活动的 `outputTruncated` 单独表达。契约拒绝 `false`，[ActivitySession](../../apps/hipi-work-ui/src/features/tool-activities/activity-session.ts)也拒绝不符合此边界或活动 ID 不匹配的返回值。本次修正了先前将该字段误设为截断标记的接缝，并加入真实 SQLite 冷读到 UI 会话的回归。

## 6. 成果入口打开当前文件

[成果导航](../../apps/hipi-work-ui/src/features/workbench/files/artifact-navigation.ts)使用受控引用：`rootId`、相对路径、操作 ID、状态及可选 `expectedRevision`。契约要求引用的操作 ID、状态与文件影响一致，禁止任意绝对宿主路径和越级路径。引用不等于授权，也不保证文件仍存在。

打开步骤：

1. 先走工作台未保存内容保护。用户取消离开时，不清空输入，也不读取成果。
2. 用户决定离开后，再次检查当前工作区和会话，丢弃旧会话的延迟回调。
3. 清理原编辑状态、打开文件面板，将引用交给 [EditorSession](../../apps/hipi-work-ui/src/features/files/editor-session.ts)。异步读取前复制目标与来源标识，避免后续对象变动改换目标。
4. 重新 `listRoots`，确认当前工作区内的 root，读取其当前可写权限，再 `readText`。已撤销或跨工作区 root 拒绝读取，不自动选择目录、创建授权或扩大写权限。[文件服务](../../packages/work-runtime/src/files/service.ts)还在读取前后检查 principal、工作区及 grant 有效性。
5. 返回的是当前授权文件，不是该操作发生时的历史字节快照。记录的 `expectedRevision` 只作来源比较，不被冒充为编辑保存基线。

[文件面板](../../apps/hipi-work-ui/src/features/files/file-workbench.tsx)提示当前读取版本与记录证据匹配、已变化或缺少版本；这不是持续文件监视。Diff 默认以本次编辑读取为基线，主动比较后以刚读到的磁盘内容对比本地输入，不是 Agent 该次操作的完整历史 Diff。成果入口走文本编辑读取，不自动切换为 Office / PDF 预览，仍受文件大小、编码与资源限制。

dirty 输入、保存进行中或写入结果未知都属于受保护状态。版本冲突保留本地输入；取消保存保留结果未知，不能解释为回滚。比较、显式采用磁盘版本、再次保存是独立动作；这些编辑器操作不把活动记录中的 `unknown` / `observed_match` 改成成功。

## 7. 刷新、失败与资源限制

[活动组件](../../apps/hipi-work-ui/src/features/tool-activities/tool-activities.tsx)的当前策略：

- 连接正常、页面可见、弹窗关闭且没有读取错误时，读取首页摘要；会话仍运行时，在本次读取结束后等待 2 秒再读。不是固定实时推送或全历史轮询。
- 摘要文本被选中时跳过刷新，并继续检查选择状态，避免替换用户正在选择的内容。
- 弹窗打开时停止摘要轮询，列表靠手动刷新 / 翻页；首次尚无页时读取。关闭弹窗清除展开文本，恢复满足条件的摘要读取。
- 断线或页面隐藏时取消当前等待；卸载 / 会话切换释放状态，迟到响应由 generation 拦截。取消等待不取消工具，也不保证底层 Storage 立即停止。
- 单个 ActivitySession 最多一个在途读，只保留一页列表和一段输出。每次读有 15 秒等待期限，即使传输忽略 abort，也能结束 UI 等待。
- 失败保留已有证据并提示可能过时，停止自动轮询；重试保留失败的游标 / 活动目标，不显示内部异常。关闭弹窗不会偷偷重试失败的页面读取。

[契约限制](../../packages/work-runtime/src/activities/contracts.ts)另设单次读取 hydration 预算 2 MiB，并检查结果 payload。预算是在 Storage 返回数据后累计序列化大小，不是数据库底层内存分配上限；超过预算返回 `CAPACITY_EXCEEDED`，不静默裁剪成“全部成功”。这些数值是实现限制，不是经真实负载验证的性能承诺。单会话 UI 的单在途限制也不等于整个服务器只有一个请求。

## 8. 验证范围与待验收项

本次阅读源码和下列测试，并修复上述输出标记接缝。已运行活动后端三个测试文件（13 项）与活动 UI 测试（10 项），全部通过；runtime / UI TypeScript 检查及修改文件的定向 Biome 检查通过。成果编辑、导航与其他编辑会话测试在此列出覆盖范围，本次未重新运行。未运行构建或真实 GUI；根目录完整检查由主任务统一记录。文档另检查相对链接；当前源码目录不含 Git 元数据，普通 `git diff --check` 不可用，使用 `git diff --no-index --check /dev/null <文档>` 检查新增文档空白。

| 现有测试 | 覆盖行为 |
| --- | --- |
| [活动 Storage / 投影](../../packages/work-runtime/test/tool-activities.test.ts) | SQLite 只读业务访问、完成与工具错误分离、诊断来源、分支可见性、两段去重、分页上界、游标作用域、Unicode 分段、授权过期与 unknown / observed_match、hydration 拒绝 |
| [活动 runtime](../../packages/work-runtime/test/tool-activities-runtime.test.ts) | 确定性 faux provider 的真实运行时文件授权 / 保存 / 成果投影，重启后冷读不增加 provider 调用；未截断输出经真实 SQLite、JSON 参数序列化与结果契约校验进入 ActivitySession，拒绝错误输出标记；不是付费真实模型、真实 HTTP / IPC 或 GUI 验收 |
| [活动契约](../../packages/work-runtime/test/tool-activity-contracts.test.ts) | 状态维度、额外字段拒绝、读取参数限制、文本预算、成果引用关联与路径约束 |
| [活动 UI](../../apps/hipi-work-ui/test/tool-activities.test.tsx) | 会话单在途、替换而非累积、迟到响应、15 秒超时、显式重试、输出校验、静态渲染转义与状态文案、中英文 key；不是挂载浏览器轮询与焦点实测 |
| [成果编辑](../../apps/hipi-work-ui/test/artifact-editor.test.ts) | 当前 root 权限、当前版本与历史来源分离、撤销 / 异域拒绝、复制引用、dirty 保护、取消 / dispose / 重新激活竞争 |
| [成果导航](../../apps/hipi-work-ui/test/workbench/files/artifact-navigation.test.ts) | 取消离开保留输入，工作区 / 会话切换拒绝旧回调，受控来源传递 |
| [编辑会话](../../apps/hipi-work-ui/test/file-editor-session.test.ts) | 冲突与未知写入保护、迟到响应、只读 / 超限保存拒绝、显式采用比较版本且不自动保存 |

仍需在目标桌面环境验证活动弹窗键盘 / 焦点、选中文本、页面隐藏与断线恢复、长内容与主题缩放、dirty 成果跳转及三平台文件权限行为。静态标记、mock 客户端或文档检查不能替代这些验收。
