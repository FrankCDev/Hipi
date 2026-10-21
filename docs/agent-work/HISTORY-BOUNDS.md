# 历史分页与文本边界

2026-10-21 更新。本文保留最初协议 2 的问题背景，并记录当前连续历史窗口实现；不是当前协议版本声明。源码与定向测试已实现，尚未通过真实 Electron 或浏览器像素与滚动验收。

## 本次修复的问题

此前 `parseSnapshot` 用 `LIMITS.submissions * 2` 推导消息数量上限。合法的生成中断会额外保留 assistant 条目，因而一次提交并不总对应两条消息。历史达到上限时会被传输契约拒绝。

另一个独立问题是单条消息允许的长度与整个帧的一 MiB UTF-8 字节限制并不等价。JSON 转义、多字节文字、多个消息和传输信封均消耗字节；仅提高消息数量上限不能修复长回复导致的断连。`getReceipt.answer` 和实时 partial 也必须一起处理。

PI 的 `ConversationView.entries` 是活动上下文，不是完整历史。压缩或 reset 后，不能依靠这个数组提供完整的历史翻页。

## 已实现的边界

- 保留提交准入配额、历史分页配额和传输字节配额三个独立约束。
- 通过公共 `Conversation.entries(query, limit, cursor, context)` 获取有界的历史页；固定上界与下一 entry/model 位置，避免同一 entry 包含多个消息时漏项。
- 快照明确包含最新历史窗口及旧历史 continuation。页面显示的预览须注明长度与截断事实，不静默丢弃历史。
- 超长消息提供有界文本块读取，按原内容精确重建；实时 partial 使用明确标识的预览，不能将预览持久化成最终回答。
- 文本偏移单位与 Unicode surrogate 边界明确。所有响应在加入 HTTP/SSE/IPC 信封后验证实际序列化字节数。
- 游标使用应用自有的可验证位置，或原样往返 PI 的 opaque Cursor；不得解析或重建 PI 私有游标格式。
- 根据请求所属 conversation 查询条目，不能通过全局 entry lookup 绕过会话可见性。
- UI 保持历史页与最新流独立；切换存储、会话或取消后，迟到请求不能改写当前视图。空页仍可能有 continuation，不能据此判定会话无历史。

协议版本从 1 升到 2；需要同时更新服务端与 UI，旧协议显式拒绝，不假装兼容。目录与回执持久化 schema 未因此更改，提交语义摘要继续使用原有语义版本，不因传输版本变化而把同一个请求误判为内容冲突。

当前预算为每页最多 32 条消息、每条预览 2048 UTF-16 单位、实时预览 16384 单位、原文块 32768 单位，每次扫描最多 64 条 entry / 256 个 model slot。整个 JSON 内容另按真实 UTF-8 字节校验，并为外层信封保留 1024 字节。这些是当前实现限额，不是无限规模性能保证。

`getHistory` 返回有固定历史上界的 continuation；`getMessageText` 返回消息身份、实际 offset、下一 offset 与总长度。如果请求恰好落在 surrogate pair 中间，实际 offset 只会向前规范化一单位，返回完整字符；其他非法 offset 拒绝。客户端核对身份、总长及规范化边界，不接受任意偏移变化。回执 answer/reason 也带长度及截断标记。

UI 以 800px 接近范围选择较近的可读取历史边界；普通本地会话无需先产生一次用户滚动。正常状态没有“更早 / 更晚 / 继续扫描 / 释放容量”transport 按钮。消息继续使用 TanStack Virtual 的稳定 key、动态测量与现有 scroll intent；本次只增加只读 viewport demand，不增加第二个滚动 owner。完整 turn 是一个测量行，但容量 pin 根据真实 message child 几何和焦点计算，不把一个巨大 turn 的全部成员误当作可见内容。选区存在时保留冻结内容并暂停读取，拖拽、搜索初始定位和隐藏窗口也暂停需求。清除保护后重新评估边界。离开底部不自动跟随；最终回答替换 stream 行仍保留替换前的底部意图。

每个挂载会话独立持有旧页 fence 和最新观察，一次最多一个读取。短 live gap 找到交集后原子接合；gap staging 超预算则保留旧窗口，转成 newer 边界 replay，不能直接把远端最新消息拼到旧尾部。断线取消读取并保留当前视图，恢复连接后继续可验证的需求；真实读取错误停止自动读取并提供重试。空页的 continuation 自动推进，每 16 页 yield 后按仍有效的需求继续，不要求用户理解扫描批次。有限 cursor 集合配合常数空间周期检测，避免很长 cursor 环绕过集合上限。

虚拟 DOM 不等于无限历史或无限内存保证。预览预算仍为 2048 条 / 4 Mi UTF-16 文本单位，主窗口预留五个 contract 页给最新观察、捕获的 replay fence 与前后相邻 staging（搜索模式使用初始窗口）；run result 元数据另有自己的限制。加载时只从远离需求的一端淘汰未受保护内容，不删除持久数据。连续窗口不能跨越 pinned 内容来制造空间：若安全淘汰受选区或焦点阻挡，诚实保留容量状态，保护释放后自动恢复，没有“释放旧内容”按钮。

搜索窗口以原始 opaque page 身份恢复被淘汰的两端。普通 `getHistory` 只有向旧 cursor，因此向新回看或恢复被淘汰的旧边界，需要从捕获的 latest fence 串行 replay 到当前边界 ID。该过程只保留常数相邻页 staging，保持旧视图直到候选可接合；30 秒 replay 超时、cursor 无进展或边界消失是可重试错误，不跳到最新、不假装历史已完整。极长会话的反向 replay 可能较慢，尚未具备与参考相同的双向随机读取性能。切换 scope、断线或卸载取消读取与计时器。

消息原文 transport 分块由独立的连续 document owner 管理，不再将首页、前页、后页暴露为正文交互。复制和搜索只依赖经过验证的原文状态；预算不足与未完成不能冒充完整正文。该资源池与历史预览窗口是不同预算，不能把预览窗口有界说成整个 DOM、AST 或进程内存有界。

依赖审查：两个 TanStack 包均为 MIT，官方 registry 元数据无安装生命周期脚本，React peer 包括 19；解包体积分别 63,728 与 639,278 bytes（含源码与 source maps，不是生产 bundle 大小）。相较自行实现动态测量 / prepend 补偿，采用官方维护的 [Chat 模式](https://tanstack.com/virtual/latest/docs/chat)；未由此承诺跨平台滚动正确性或安全无漏洞。定向 controller、core 布局模型与 SSR 测试不是真实 scroll / Selection / ResizeObserver 验收；仍需浏览器和三平台 Electron 验证动态高度、字体缩放、选区、原文展开、顶部连续加载及最终回复替换。

旧版 2048 / 32768 单位 Markdown 降级及其 [SSR 测量](benchmarks/markdown/README.md) 是历史实验，不是当前连续 Marked document 渲染行为或性能证明。当前统一 canonical source 渲染仍需真实浏览器与长会话性能验收。

## 回归要求

覆盖超过 128 条合法历史、多个中断片段、同一 entry 的多个 model messages、无可显示消息的中间页、追加期间翻页、重启与压缩/reset 后历史可读、跨会话请求拒绝，以及包含转义字符、中文和 emoji 的超长消息完整重建。HTTP、Node IPC 与 Electron IPC 使用相同契约验证。

此方案限制应用响应和 UI 状态，不证明上游内部内存严格有界：PI 的 watch 仍持有活动上下文，单个 EntryRecord 读取仍会装载整条记录。性能结论必须区分这两层。
