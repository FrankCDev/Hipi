# 会话领域、工作区与持久化边界

日期：2026-10-19。状态：工程设计提案，待评审与实现验证；不是已经交付的能力或首版范围承诺。上游证据固定为 `1402973a9dbe8c627341e04c9744c54953e285ca`。本文补充[架构决策](../ARCHITECTURE.md)的领域语义，不另造 Durable 执行引擎。

## 1. 问题与设计结论

仅划分 UI、IPC、应用核心和 Durable adapter，还不能回答“两个窗口同时发消息”“关闭再打开”“改模型后旧工具用哪个配置”等产品问题。必须先定义身份、持久事实及操作语义。

例如：窗口 A 的发送已落盘，但回执丢失；窗口 B 重开相同聊天。若每窗口创建一个 runtime，可能出现重复执行或同库多写。若把每个聊天都当 Durable Session，又会无意拆开原生 fork、子代理和原子提交边界。

本文推荐：工作区拥有工作区运行实例；聊天对应 Conversation；用户意图以 requestId/receiptId 跟踪，分发到 Durable 后关联 SubmissionId；run 是多轮执行的派生概念；Task 是 Durable 执行单元。所有窗口通过同一个应用核心访问，不能自己打开存储。命令接收协议与[运行时设计 §4](RUNTIME-AND-RECOVERY.md#4-命令回执丢失回包不等于丢失工作)一致。

## 2. 状态标记与实施前决策

- **已有约束**：UI 只依赖 AppClient/DTO；核心与 Electron、HTTP 解耦；Durable 是执行事实单一权威；凭据不进入普通存储。
- **本设计推荐，待评审**：每工作区一份 SQLite/storage 和一个 Harness；以 requestId/receiptId 跟踪命令交付、以 SubmissionId 追踪已分发输入；普通发送为 follow-up；运行中不允许改变执行环境及工具配置；归档是产品元数据。
- **待验证**：三平台数据库适配、宿主单写锁、恢复时配置版本解析、大历史规模、附件存储、迁移与清除能力。没有测试通过前不能标记为已实现。
- **首版范围建议**：标题筛选、分页历史、空闲归档与恢复；用户 fork UI、全文搜索、跨工作区移动和永久删除后置，保留底层分支关系。后台代理和历史导出另行评审；以上仍不是交付承诺。

## 3. 术语与身份

### 3.1 Workspace：用户工作的上下文

工作区记录稳定 `workspaceId`、名称、环境引用、受控文件根引用、权限策略引用、存储定位和配置版本。文件根是环境中的资源，不用 renderer 提供的任意绝对路径作为授权依据。目录移动或暂不可用不能改变工作区身份；需要重新定位时显式核对。

一个工作区可有多个聊天，用户可在多个窗口查看同一工作区。工作区不是 OS 沙箱；上游 `NodeExecutionEnv` 的 `cwd` 只是相对路径基点，仍接受绝对路径及 `~`，没有根目录权限约束。权限判断必须在宿主/受控环境实现。

同一个真实目录重复打开时默认定位到已有工作区，而非静默创建第二个。若产品允许两个工作区共享目录，应显式标识共享文件系统和冲突风险；二者的聊天、权限选择和数据库不同不代表磁盘隔离。环境身份应反映实际文件系统，避免把同一文件伪装成互不关联的写入目标。上游文件队列只串行同进程、相同环境 ID 和规范路径的 `edit`/`write`，不锁住 `bash`、外部编辑器或其他进程；跨 Harness/进程的文件冲突处理不能未经验证就宣称成立。

证据：[Node 路径解析](../../../packages/durable/src/env/node.ts) 第 78–93 行；[Environment](../../../packages/durable/README.md#environment)；[工具文件写入队列](../../../packages/durable/src/tools/file-mutation-queue.ts)。

### 3.2 Conversation：聊天与历史分支

产品聊天一对一映射一个 Durable Conversation。用户新聊天使用 ownerless ownership；子代理聊天可以由某个 Task 拥有。**历史父子关系与执行所有权是两条不同关系**：fork 的 `parent` 指向历史来源；`owner` 决定取消传播与空闲等待。

产品元数据包括标题、创建时间、归档时间、标签和展示类型；推荐存为最小 `app.conversation` document，与创建 Conversation 在同一 Durable commit 初始化。历史继承及运行态仍使用上游记录，不复制。标题等不需回溯的字段选 latest；fork 元数据采用明确初始化规则，不能误继承“已归档”或父聊天标题。

对外 ID 是不可推断的应用标识，作用域至少包含连接身份、workspace 和 conversation。上游 ID 在一个 Session 中有意义，不能假设跨库全局唯一。adapter 负责映射，不向 UI 暴露句柄。

证据：[ConversationRecord / ownership](../../../packages/durable/src/types.ts) 第 363–404 行；[创建 hook 与自定义 document](../../../packages/durable/README.md#your-own-state)。

### 3.3 Session / Harness：内部运行实例

Durable Session 拥有一个 mutation line、多个 Conversation、Entry、Task、Submission 和 Document。Harness 在 Session 上增加模型与工具调度。它既不是登录会话，也不是窗口生命周期，也不等于每个聊天。

建议的层级是：一个独立 Node Agent 运行服务进程管理多个已打开工作区；每个工作区运行实例持有一份 storage 和一个 Harness，其中承载多个 Conversation。同一工作区的多个窗口共享该实例，不为每个窗口或聊天重复创建 Harness。这里的“实例”是进程内逻辑对象，不意味着独立 OS 进程、Docker 容器或安全边界；每工作区一份 storage/Harness 仍是待评审、待验证的建议。工具和插件按负载与信任级别使用必要的独立工作进程；权限沙箱另行设计与验证。

Chord Context 是调用级取消与遥测上下文；模型 context 是由历史计算出的模型输入；provider session identity 用于供应商缓存亲和。这三者也不能叫同一个产品 session。provider identity 每 Conversation 持久化，fork/子聊天获得新身份，不用于产品鉴权。

证据：[规范 §1](../../../packages/durable/docs/spec.md#1-terms-and-invariants)、[概念](../../../packages/durable/README.md#concepts)、[恢复](../../../packages/durable/README.md#persist-and-resume)。

### 3.4 CommandReceipt、Submission、run、turn、Task 与 Entry

- CommandReceipt：产品命令的持久交付回执。requestId 是首次发送前生成、重试复用的 wire 意图标识；receiptId 是可跨窗口/重启查询的回执标识。accepted 可以尚无 SubmissionId，不代表模型已经启动。
- Submission：一次已被 Durable 持久接受的输入或被动写入。是分发后输入执行阶段的稳定锚点；产品回执到 dispatched 后才关联它。
- run：从输入到最终回答的一组模型轮次；steer 可以加入当前 run，多个输入可能由同一个回答结算。
- turn：一次模型响应及其工具调用。
- Task：持久状态机，例如 `pi.generation`、`pi.tool`、`pi.compaction`；不是独立的产品聊天。
- Entry：不可变历史记录；流式 partial 位于可变 `pi.live`，终态回答成为 Entry。不要每个 token 建一条消息。

特别注意：`pi.live.run.taskId` 会在 generation 间交接，**不是稳定 runId**。首版使用 requestId/receiptId 作为公开稳定入口，分发后关联 Submission；内部 run 展示从 `pi.live` 推导。只有明确需要稳定跨轮 run 引用时，才增加薄关联记录，并验证创建/交接/恢复的一致性，不建立第二套 run 状态机。

证据：[LiveState](../../../packages/durable/src/harness/live.ts) 第 80–116 行；[startRun / handOver](../../../packages/durable/src/harness/generation.ts) 第 744–762 行。

## 4. 存储粒度 ADR：建议每工作区一个 storage

### 4.1 候选比较

1. **每聊天一个库**：独立备份与故障边界直观，但天然 fork、子代理和跨聊天原子提交只能留在同一库；“一个库一个聊天”最终会变成“一个库一个聊天树”。聊天列表、资源引用和全局运维复杂，打开很多库也有成本。
2. **每工作区一个库，推荐**：同工作区聊天、fork、子代理天然共存；权限与环境配置边界清楚；单库失败影响一个工作区。代价是共享提交线、工作区内数据增长和多个工作区 Harness 的资源管理。
3. **整个应用一个库**：最简单的全局扫描与原子提交；但所有工作区共享故障、迁移和提交边界，备份、导出及将来远程工作区定位更难。权限仍不能由数据库粒度替代。

选项 2 是设计建议，尚无负载测试支持性能优越性。数据规模和并发测量后才能锁定；不因“可能很多工作区”提前引入分布式服务。

### 4.2 数据所有权

- 应用级目录：只定位 workspace、storage 和最近打开记录；不存另一份任务状态。目录持久化介质待实现选定，不要求立即新增 SQL 数据库。
- 工作区 storage：Durable 原生记录与最小产品 documents。`app.workspace` 保存非秘密配置引用；`app.conversation` 保存列表元数据；有界 receipt/intent documents 保存交付、去重及映射事实，不复制执行状态。
- 附件资源区：以资源 ID 管理持久文件；与运行库建立引用。它不能借用临时工具输出文件的寿命。
- 搜索索引：若实现，为可重建投影；不是历史权威，故障不得阻断已保存历史读取。
- UI 缓存和窗口状态：可以丢弃重建；输入草稿若要跨重启保留，单独定义保存策略，不能伪装成已经发送。

工作区库置于应用数据区，通过 workspaceId 定位，不默认把私密聊天放进项目 Git 目录。storage path 与 fs root 分离。项目移动不会移动数据库；备份/迁移显式处理二者。

### 4.3 原子边界与单写所有者

每 storage 同时只有一个应用 runtime owner，所有窗口与 IPC/HTTP 入口经它访问；宿主单实例只能作为一层防护，不能替代针对存储真实路径的独占检查。锁必须覆盖别名路径、进程崩溃和陈旧占用，具体跨平台机制待验证。锁失败拒绝写入并定位已有 owner，不抢开第二个 Harness。

Durable commit 可同时写 Entry、Document 和 Task，但不能把外部文件操作或远端请求变成数据库事务。工作区目录登记与库创建也不是自动跨存储原子操作：创建先分配 workspaceId，建立库与身份元数据，再登记可用目录；重启可发现并修复未完成登记，不能默默丢弃孤立库。

关闭最后一个窗口不删除工作区、聊天或停止执行。runtime 空闲可按资源策略关闭，必须确认没有活跃/睡眠/后台工作需要它继续提供服务；未来唤醒由明确宿主负责。退出与恢复策略由运行时设计约束。

证据：[Storage](../../../packages/durable/README.md#storage) 第 753–776 行：SQLite WAL/NORMAL、单进程 ownership、无跨进程锁。进程崩溃可恢复不等于断电不丢最近提交。

## 5. 用户操作及生命周期

### 5.1 创建、打开与发送

创建聊天的单个用例完成授权、配置解析、Conversation 创建和产品元数据初始化。打开聊天只读快照/分页历史并订阅，**不能因为查看就 resume**。打开已归档聊天仍可读取，是否重新发送需先明确恢复归档状态。

发送流程：验证作用域及载荷 → 同一接收事务内核对幂等键/fingerprint 并保存 intent → 返回 accepted CommandReceipt → 重新校验并原子登记 dispatching 与 mapped requestId → 分发器调用 Durable submit → 保存 dispatched 与 SubmissionId 映射。accepted 只表示产品已持久接收，UI 显示“已接受，待交付”；Durable 的 queued/placed/结算状态仅在关联后展示。回包丢失显示待确认，按原 requestId 或 receiptId 查询，不自动产生新意图。

这是可恢复的接收与分发协议，不宣称 intent、dispatching 标记、submit 和映射属于单事务。若映射未保存而分发可能发生，重启首先以原 mapped requestId 只读查询 Submission：已存在则补映射、保留已执行事实，并对后续效果重新授权；确认不存在且没有旧 owner 或在途分发，才检查最新权限/配置及撤回要求后决定 dispatch、suppressed 或 rejected。无法只读判定时进入 reconciliation_required，不能用盲目 submit 代替查询。公开 Storage/Tx 的 submissionByRequest 提供查询基础；owner 安全串行访问、查询不意外启动 scheduler 及存储回退识别仍须 spike 验证。分发器不得绕过 payload 冲突检查，也不得对 suppressed intent 继续发送。撤权不能抹掉已发生的执行，也不能成为重启时重新发起未授权工作的理由。

普通发送推荐固定 follow-up；steer 是明确的“补充当前执行”操作；reject 是明确要求仅空闲时发送的 API 选项。服务端持久接收顺序是多窗口并发的裁决顺序，同一 Conversation 的分发器保序，不承诺用户时钟顺序。按模式处理的 inbox 不等于所有事件严格 FIFO：展示型 write 可立即落历史，steer 与 follow-up 在不同边界放置。

两窗口重试同一命令复用相同 requestId；两个不同意图即使文字一样也可分别接受。不要按文本去重。产品去重作用域统一为 `(storeIdentity, principalId, workspaceId, commandKind, requestId)`；conversation 目标与语义载荷、协议版本进入 fingerprint，同键改目标也必须冲突。principal 来自认证连接。Durable requestId 仅在 conversation 内去重，源码只检查重复提交的 type，**不保证同键不同内容冲突**；产品接收事务必须原子比较并登记 fingerprint，分发使用完整 scope 对应的稳定内部键。公开 wire 统一叫 requestId，不另引入 commandId 同义字段。分片/留存及崩溃窗口按运行时设计验证。

证据：[admitSubmission](../../../packages/durable/src/harness/submissions.ts) 第 170–244 行；[忙碌聊天](../../../packages/durable/README.md#busy-conversations)。

### 5.2 状态投影

先区分产品 receipt 的六态 accepted/dispatching/dispatched/rejected/suppressed/reconciliation_required 与 Durable 状态。dispatching 表示尝试已持久登记，可能已进入 Durable；suppressed 仅在确认没有已接收 Submission 或在途分发时表示已原子禁止交付，用户文案可显示“已撤回”。不能拿它冒充已分发输入或外部效果被撤销。receipt 的状态机只管理交付，执行结果从关联的 Durable 记录读取。

输入 Submission 原生状态：queued → placed → done，或 queued/placed → unanswered（带原因）。write 则 queued → done 或 unanswered。应用显示保留原因，不把全部 unanswered 映射为“取消”。

Task 原生状态包含 pending、running、waiting、sleeping、completing、terminal；终态 outcome 包含 completed、failed、aborted、orphaned、faulted。UI 业务完成不由“最后一个 Task completed”推断，应读取 Submission 结算及成果验收信息。tool 返回 isError 仍可能是 completed Task，不能仅看 Task outcome 判断工具业务成功。

“断线”“重连中”是客户端连接状态；“blocked/restart_limit”是调度诊断；“等待用户许可”需要真实授权请求支撑。它们不能覆盖或伪造 Durable 持久状态。映射应允许同时显示“执行中，当前窗口断线”。

证据：[SubmissionRecord / TaskState](../../../packages/durable/src/types.ts) 第 459–645 行；[Tool 规范](../../../packages/durable/docs/spec.md#84-tool)。

### 5.3 取消、关闭与恢复

- 取消等待：停止本客户端等待/订阅，不改变 intent、Submission 或 Task。
- 撤回未分发 intent：以 receiptId 为固定目标，在 owner 的每意图串行控制线上原子将 accepted 改为 suppressed，分发器不得再提交。dispatching 时先只读核对原 mapped requestId，并确认无旧 owner/在途分发；已有 Submission 则按实际阶段撤回，无法判定则保持待核对，不能为了查找而调用 submit，也不能因缺少映射就声称撤回成功。
- 撤回已分发的排队输入：使用关联的 Submission.abort；若已 placed，返回 already_placed，不能假装撤回成功。撤回与 dispatch 的竞争必须由 owner 协调并给出确定回执或待核对状态。
- 停止当前聊天执行：Conversation.abort 会撤回 queued inputs、取消普通所有权范围任务并等待空闲；queued writes 保留。不是“只取消一个 Submission”。UI 文案必须说明范围。
- 后台子树默认不随上述取消；需要停止后台工作时使用明确操作和范围，不偷偷升级为全量取消。
- 关窗：释放订阅，运行继续与否由宿主生命周期策略决定，不能绑定浏览器 AbortSignal 来停止执行。
- 重启：先打开 storage 并 inspect，核对 accepted intent、取消状态和 dispatch 映射，再依据恢复策略启动调度；恢复保持原 receipt 与已分发 Submission 身份。工具 replay unsafe 中断后不盲重放；外部效果可能已发生，UI 可显示“执行中断，外部结果未确认”。

取消无法撤销已经发生的文件写入或外部发送。安全重放依赖工具显式 replay 策略和外部幂等/核对能力；Durable 不自动提供端到端 exactly-once。

证据：[Conversation / Harness API](../../../packages/durable/src/harness/types.ts) 第 704–834 行；[恢复工具执行](../../../packages/durable/docs/spec.md#84-tool)。

## 6. 配置生效边界

配置至少区分工作区默认、Conversation 选择、每次请求实际解析值和工具执行授权。模型、思考级别、工具/扩展名称、指令及 cwd 可存在 `pi.agent`；模型凭据仅通过 credential reference 在宿主解析，不写入该文档、Entry 或导出。

上游语义并非“整轮冻结”：准备模型请求时固定模型/提示词/所提供工具；下个请求重新解析；工具与 hook 在 phase 开始解析，环境在使用时构建。因此改 cwd 或卸载扩展可能影响模型已经生成的工具调用。registry 的实现代码本身不持久化，重启只保存名字不足以证明同版本恢复。

首版推荐保守规则：Conversation 有活跃执行、未分发 intent 或未处理 inbox 时，修改 cwd、模型、扩展/工具选择和指令先拒绝，要求用户完成/撤回待处理工作并停止执行后再修改；配置操作提供 expectedRevision，两个窗口不能静默覆盖。不要自动取消任务来帮用户完成配置变化。紧急权限撤销优先于配置稳定性：可信 broker 的新调用/效果授权校验边界之后不再授予撤销能力；已授句柄、在途请求和 Node 插件直达 OS I/O 不能据此保证被阻断。对在途工作尽力取消并核对实际效果；未经过 broker 的代码须由隔离或禁用控制风险。

每个配置版本记录实际 provider/modelId、工具与扩展版本/完整性引用、环境引用和策略版本；它用于解释与恢复校验，不复制模型执行状态。运行时升级后无法满足旧版本时标记阻塞并给出升级/重试选择，不能悄悄换实现。只记录版本并不能实现冻结，仍需验证 registry/环境解析确实匹配。

证据：[Per-Conversation Agent](../../../packages/durable/README.md#per-conversation-agent)、[Reload](../../../packages/durable/README.md#reload)、[工具意图持久化](../../../packages/durable/docs/spec.md) 第 3435–3458 行。

## 7. 历史、模型上下文、分支与资源

### 7.1 历史与上下文分开读取

聊天历史使用 fork-aware entries 分页；模型 context 使用 context()。active view 不能当完整历史。reset 与 compaction 改变模型看到的内容，旧 Entry 仍在 storage；“清空上下文”不是“删除聊天记录”。压缩展示摘要、覆盖范围和失败情况，不能删除用户原文来制造节省空间的假象。

用户 fork UI 与编辑旧消息重跑建议后置；领域保留原生分支关系。将来交付时，编辑旧消息推荐创建 fork 后续跑，而不是改写不可变 Entry。fork 继承父历史到指定 Entry，并获取当时 agent 与新的 provider identity；运行态、inbox、授权及外部副作用不能作为已执行事实复制。指定 Entry 必须对该聊天可见且有权限。跨 storage fork 不是上游现成能力，需单独设计导出/复制语义。

### 7.2 归档、删除和搜索

首版建议提供标题筛选、分页历史及空闲归档/恢复；全文搜索、永久删除和跨工作区移动后置。归档只改变产品列表元数据，不删除历史，也不隐含取消。仅允许空闲且无未分发 intent/待处理 inbox 时归档；若有后台工作，明确展示并要求先处理。解除归档保留原身份。

源码公开接口未发现完整的 Conversation 删除/级联清除 API；不可承诺调用一个 remove 就永久删除。永久删除需要单独定义：fork 祖先引用、子代理、附件引用、搜索索引、备份与保留策略；不能直接删父历史破坏子分支。实现未完成前 UI 不提供“永久清除成功”假象。

历史检索也不是 `search.ts` 的现成聊天全文搜索：该文件是工具 BM25 搜索。若交付聊天搜索，应指定工作区/归档/分支范围，索引不可变 Entry 和必要元数据，返回源 Conversation/Entry 定位。索引权限与源数据一致；索引落后显示状态并可重建。

### 7.3 附件与成果生命周期

资源元数据最低包括 resourceId、工作区、来源、媒体类型、大小、内容摘要、存储引用和引用者；外部文件路径不是稳定附件内容。区分“导入的不可变附件”与“随项目变化的文件引用”，发送时让用户知道采用哪一种。

导入需要大小/类型/总配额检查，文件成功持久化后才发布可用引用；跨文件与数据库提交用暂存及可恢复清理流程，不虚构原子性。上传取消或进程崩溃留下的暂存可回收；被 Entry/fork 引用的附件不可被临时目录清理误删。删除采用引用/保留策略，必须处理分支共享。配额达到时拒绝新导入并保留草稿，不删除既有历史。

工具 spill/temp 输出只作临时诊断，若成为交付成果需显式提升为持久资源。秘密不得进入附件元数据或日志；预览、导出与未来 HTTP 下载均重新检查资源授权。

证据：[entries / context / fork 接口](../../../packages/durable/src/harness/types.ts) 第 741–754 行；[reset 与 compaction](../../../packages/durable/README.md#reset-and-handoff)；[工具搜索实现](../../../packages/durable/src/search.ts)。附件生命周期为产品新增设计，非已验证上游能力。

## 8. 多窗口读模型与不变量

1. accepted 只在 intent commit 成功后发布；dispatched 才有执行关联。Durable commit 成功之前不发布“已执行”事实；乐观气泡只是待确认意图。
2. 一个 storage 只有一个写 owner；窗口、连接和 AppClient 不是 owner。
3. requestId/receiptId 是公开命令入口；SubmissionId/TaskId/EntryId 不混用；run 当前 taskId 不能作稳定 run 标识。未分发 intent 取消与已分发 Submission 撤回分别处理。
4. 客户端缓存键包含连接/身份/workspace/conversation；换连接清理旧订阅，不能串数据。
5. Entry 不可变；流式消息 revision 来自运行时投影。相同消息 ID 不意味着相同 partial 版本。
6. 快照与增量来自同一订阅边界；带 epoch/revision 的 DTO 由 adapter 定义，缺口或跨 epoch 就重新快照，不能自行拼补旧状态。
7. 慢消费者允许快照替换；不把订阅当永久事件日志。关闭订阅释放资源，不关闭工作区。
8. 每个状态只有一个权威；应用元数据不能改写 Durable lifecycle，Query 缓存不能回写执行事实。
9. 文件根、storage 根、provider session、Chord Context、模型 context 分别建模。
10. 凭据在宿主安全存储；会话只持非秘密引用。导出默认排除凭据及敏感诊断。

Chord/上游 watch 已提供快照与后续提交、100 待交付帧上限和溢出重置；产品 adapter 必须保留其语义，不承诺无限重放，也不能依赖 public subscribe 永不跳版本。证据：[Watching a Conversation](../../../packages/durable/README.md#watching-a-conversation)、[Chord public subscriptions](../../../packages/chord/README.md#public-state-subscriptions)。

## 9. 关键用户故事与验收

以下均为待实施验收，不是本轮测试结果。使用确定性假模型和可控工具，不需要付费服务。

1. **两个窗口并发发送**：A/B 发不同命令，应用按持久接受次序生成两个回执并对同一 Conversation 保序分发；忙碌时按声明模式排队；同命令重试仅一个 receipt 和一个 Submission；同 scope/key 改内容或 conversation 均冲突。断开 A 不改变 B 所见执行事实。
2. **落盘后回包丢失**：分别在 intent 提交后、submit 提交后映射保存前杀掉连接/runtime；重开用原 requestId/receiptId 得到原回执与最终原 Submission；只出现一条用户输入。未分发 intent 可原子取消；与 dispatch 竞争时返回准确结果或待核对，不从映射缺失推断未执行。额外 failpoint：submit 成功但映射未写入时崩溃，恢复前撤权或取消；先只读找回原 Submission，保留事实并限制后续效果，不盲 submit、也不直接 reject 掩盖已执行。对确认不存在的键拒绝新越权 dispatch；读结果不确定时保持待核对。
3. **多窗口重开**：两个窗口共用一个 storage owner；重建最新快照及分页历史，不因打开页面启动调度；partial 不重复拼接，旧 epoch 增量被拒绝。
4. **同目录工作区**：符号链接、路径大小写及平台别名按真实环境核对；重复打开可定位现有工作区；明确创建共享目录工作区时提示共享效果，权限与并发写测试不能把两个数据库当隔离。
5. **运行中改配置**：活跃或有 intent/inbox 时修改被明确拒绝；空闲修改原子完成、revision 冲突可见；后续运行用新配置；重启缺失旧插件版本不会静默换实现；撤销权限后 broker 不授予新的被撤能力，在途/旁路效果单独核对而非承诺消失。
6. **分层停止**：cancelWait 不改变交付或执行；未分发 intent 取消后不再 dispatch；已分发 withdraw 在 placed 竞争时返回 already_placed；Conversation.abort 清理普通范围并保留 queued writes，不错误停止后台子树。
7. **分支与压缩**：fork 具有正确历史截点和配置；压缩前原文仍可分页读取；父归档不破坏分支；上下文 reset 不被显示为永久删除。
8. **副作用中断**：在外部效果成功、结果提交前崩溃，unsafe 工具不重做且状态不声称效果未发生；safe 工具只有经过幂等/核对验证才允许重放。
9. **附件崩溃与配额**：导入各阶段注入崩溃，重启不出现可见悬空引用；临时孤儿可回收；共享分支附件仍可读取；超限保留用户草稿。
10. **长历史与慢窗口**：构建长聊天和大量工具输出，慢窗口最终收敛到新快照，订阅/缓存有界；分页不遗漏/重复，模型上下文不等于整个聊天常驻内存。预算由测量决定。

## 10. 首轮需要锁定的问题

开始实现前评审：storage 粒度；workspace 重复目录规则；单写 owner 与锁方案；普通发送/steer 和取消范围；整轮配置变更策略；回执幂等及同键冲突原子实现；归档/删除边界；附件留存和额度；恢复时配置版本要求。

最小验证优先完成“同工作区双窗口发送 → 丢回执 → 杀 runtime → 恢复 → 原请求结算”，并证明不是靠新增第二套任务表实现。然后验证配置变更、分支历史、慢订阅和附件失败。数据库迁移、删除和长期负载须有独立验收；文档通过不代表这些能力完成。
