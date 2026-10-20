# 长期容量与会话归档

2026-10-19。状态：核心实现与定向验证进行中，不是 RC 验收结论。本文区分已落盘结构和后续性能/迁移门禁，配合 [RC 跟踪](RC-TRACKER.md)。

## 1. 问题与最小路线

原限制是累计使用次数：Catalog 存全部 conversations/requests；单会话 grants 32、commands 256、approvals 64，provider sessions 64。重启使授权失效，再授权仍占新槽，日常使用最终永久耗尽。直接放大数组会放大提交、重启和扫描成本。

现在采用两条独立路径：

- 权限事实、审计页、live 集合全部在同一 PI 存储中原子提交，不进入 root SQL。
- root catalog.sqlite 保存工作区/会话目录和可重建的内容搜索投影，并独立保存项目文件夹关联、置顶展示元数据及其命令回执；PI 是会话元数据和全部执行事实的唯一权威。目录变更日志用于修复目录投影，不是任务状态机，也不能用来证明消息搜索覆盖率。

PI submission、task、entry 继续决定执行和答案。未知效果和未决请求不得按年龄或配额静默删除。

生产 Hipi 的全部四处工作库连接明确使用 WAL + `synchronous=FULL`，包括目录读取所用的可写/可迁移存储入口；通用 Chord 默认仍为 NORMAL，独立只读档案不执行写 PRAGMA。[连接级策略测试](../../packages/work-runtime/test/sqlite-durability.test.ts)在实际创建的 native 连接上检查，而非另开连接猜测。FULL 可能增加提交延迟，不为测试降级；它不等于三平台断电资格、跨库原子性或外部效果 exactly-once。

## 2. 已实现的存储边界

### 会话与请求

[conversation-directory.ts](../../packages/work-runtime/src/conversation-directory.ts)定义：

- WorkspaceHeaderDoc：workspaceId/name、generation、nextOrdinal、changeSeq、activeCount、initialized。没有历史数组。
- ConversationMetaDoc：按 publicId 点查，包含 durableId、稳定 ordinal、title、revision、createdAt、archivedAt。新记录有创建时间；旧记录为 null，不伪造历史。
- DirectoryCommandDoc：按 owner/workspace/requestId 的确定性键保存 digest、method、首次完整 Conversation 结果。key 不含 method，跨目录方法复用 requestId 仍冲突。
- DirectoryChangeDoc：单调 seq → publicId/revision。仅 create/rename/archive/restore 写入；权限、submit 和文件效果落盘没有 root 索引依赖。
- ConversationDeliveryDoc：有界未决 receipt keys。提交先核对已存在 ReceiptDoc，再检查新准入；累计完成次数不再占配额。
- SubmissionReceiptDoc：submissionId → receiptId/requestKey 直接绑定。submit 返回后的落盘窗口内，工具可在同一 PI commit 从该会话有界未决集合核对 submissionByRequest 并补齐绑定，不扫描历史请求。
- WorkspaceLiveDoc：每个会话分别记录 broker/receipts/cancellation 引用；各 owner 同事务只更新自己字段。恢复只检查仍有 live 引用的会话。

[pi-workspace.ts](../../packages/work-runtime/src/pi-workspace.ts)只用公共 PI API。归档的 task 检查按 pending/running/waiting/sleeping/completing 逐类 limit=1 查询，避免扫描历史终态任务。Tx 没有 scanSubmissions/scanDocuments，因此通过 live receipt keys 和 submissionByRequest 核对。没有读取或修改 PI 私有 SQL 表。

### 权限与审计

[agent-tools.ts](../../packages/work-runtime/src/agent-tools.ts)及权限存储 helper 采用逐 GrantDoc/CommandDoc、既有 ApprovalDoc/OperationDoc、每页最多 64 ID 的审计页和小型 head。事实、页及 live 集合在同一次 PI commit 写入。

active grant IDs、pending approval IDs、未核对 operation IDs 与历史分别存放。过期/撤销/失效授权释放 active 名额，但完整事实、sourceGrantId 和依赖仍在。SessionBindingDoc 按 provider sessionId 点查，替代累计 64 项数组；正反绑定检查及 fork 不继承许可的安全语义保留。

命令永久保留，不设时间回放窗口，不维护时钟淘汰状态。新命令保存首次完整结果供审计；旧命令原本只有引用，迁移保留引用，不伪造首次 active/approved 快照。权限命令重试仍返回当前权威对象，不重新执行；保存的历史结果不是当前许可。只读 getAgentCommandResult/getConversationCommandResult 用于未知响应核对。

审计 cursor 绑定持久 workspace generation、会话和遍历位置，固定首次 upper ordinal。复制整个数据库仍是同一数据身份；root 路径/store identity 的校验另行负责。响应同时受项数和实际 JSON 字节限制；完整 proposal 一次一项，不能因 64-ID 索引页就返回 64 个完整大对象。

完整权限语义见 [工具授权](TOOL-AUTHORIZATION.md)。

### 当前文档的增量重建链

小型当前集合仍可能有很长的修改历史。后续复核发现：没有 `checkpointWhen` 时，PI 从最新 base 后物化全部 delta，因此仅限制数组项数不足以限制冷读取成本。当前本地目录、权限、回执与工具包文档每 32 次变更写入一次 checkpoint，后续当前值最多回放 31 个 delta。

这是 PI 原生 session-scoped current-only 文档的存储压实：其内部旧 delta 会被替换，并非保存全部内部 revision；这些文档原本就不提供 historical-at 读取。独立的命令结果、目录变更、审计页、工具包安装原文及业务状态仍保留。只读路径不会为了压实而写入；旧版本留下的长链仍需首次变更后才建立新 checkpoint，不能据此承诺升级后第一次冷读已严格有界。

[文档 checkpoint 回归](../../packages/work-runtime/test/document-checkpoints.test.ts)使用真实 SQLite 验证 131 次更新中的冷物化 tail、独立业务审计保留、旧长链下一次变更压实，以及元数据重开不恢复未决模型执行。[工具包 checkpoint 回归](../../packages/work-runtime/test/extension-checkpoint.test.ts)另验证 100 次 disabled 安装后的分页、原文及各类包文档当前值。该机制没有改写 PI 上游全部文档，也不约束单条 entry 的物化大小或整个进程 RSS。

## 3. 目录投影与崩溃顺序

[StoreCatalog](../../packages/work-runtime/src/store-catalog.ts)保留单 owner 锁，root schema 当前为 8。schema 2 引入 conversations 索引和 directory_checkpoints；schema 3 增加旧程序拒绝打开的安全屏障；schema 7 增加权威置顶状态及不可变命令回执，schema 8 增加独立可重建搜索投影，仍使用原 catalog.sqlite。置顶不是可丢弃的目录/搜索缓存，搜索重建不能修复或清空损坏的置顶事实。

1. PI 同事务写会话元数据、DirectoryCommand 首次结果、DirectoryChange 和 head。提交失败时均不可见。
2. 目录列表读取 workspace header，通过公共 Storage 点查未消费日志和当前 metadata，每批最多 64 条。
3. root 单 SQL transaction upsert 索引并推进 checkpoint。中断则批次全回滚或全提交，重试按 revision 幂等应用。
4. PI 已成功、目录投影失败时，命令仍可通过只读 requestId 查询。列表返回错误，不伪装成空列表。撤权、取消和效果确认不经过投影，不能被其故障阻断。

缺 checkpoint、generation 不匹配或当前 checkpoint 下索引数量不符时，清空受影响的可重建索引并从持久目录日志重建；PI 数据不删除。缺失 root identity 且已有 workspace.sqlite 时拒绝 STORE_MISMATCH，不静默分配新 storeId。实际损坏的 SQLite 数据库报错，不降级为空店。

目录列表、getConversation 和 getConversationCommandResult 通过只读 Storage 工作，不打开 Harness、不调用 resume；即使 runtime 配置 resume:true，精确查询也不触发旧任务。超过 16 个历史工作区不等于同时打开所有 Harness。root workspace 注册不再有累计 16 上限；同时打开的 Harness 资源上限仍保留，安全 LRU 由独立实现及测试负责。

会话按稳定 ordinal 排序。listConversations 默认 active，可选 archived/all；游标绑定 storeId、workspace/filter、generation、目录 seq 和最后 ordinal。目录变更后旧游标返回 CURSOR_STALE，调用者重新加载，不使用无上限 OFFSET。

### 迁移与恢复边界

旧 Catalog 有界读取，每会话单独 PI commit 建新 metadata 并调用 broker 权限迁移，再按旧 receipt key 重建未决引用。新 metadata 已存在时不重复计数。全部完成后，最后一个 PI commit 写 initialized 并 retire 旧 hipi.workspace，旧历史仍保留；之后没有数组与新索引双事实。迁移中断时旧 Catalog 仍在，重启可继续。迁移完成前不 resume scheduler。

### 工具包授权的单向版本屏障（schema 3）

以下 schema 3 说明保留其首次引入时的安全动机。当前 runtime 接受正常 root identity.version 1、2、3、5、6、7、8，并在原 root 单 owner 锁内事务升级到 8；schema 4 始终只供非执行恢复档案，普通 runtime 拒绝。升级写入、版本核对或 commit 失败均拒绝打开，不退回旧路径。原 storeId、root 与工作区数据保持不变。

这不是可选的 PI 标记。已交付 protocol 4 源码只接受 catalog schema 1/2，不知道工具包历史披露授权；若仍允许它打开新增工具包历史的数据，旧模型出站路径可能绕过新的授权检查。catalog schema 3 使该旧版本在返回 runtime 前以 STORE_MISMATCH 拒绝。

这是单向数据格式升级，即使只打开目录也会建立屏障。回滚必须停止全部相关进程，恢复升级前离线取得的完整一致备份，包括 root catalog/identity、owner 文件及全部工作区 SQLite 数据和备份时存在的配套文件；必须作为同一备份集合恢复到原 root 路径。不得只替换旧二进制、手动调低 version，或混用不同时点的 catalog 与 workspace 数据。未持有可验证的升级前完整备份时，不应承诺可安全回滚。

[feature-readonly.test.ts](../../packages/work-runtime/test/feature-readonly.test.ts) 的真实 SQLite 回归现验证支持的旧 schema 升级到 8 后保身份及工作区数据库完整字节、未来版本拒绝，以及注入升级写失败时不开 runtime 且释放 owner 锁。[搜索备份回归](../../packages/work-runtime/test/search-backup.test.ts)另验证已有 schema 7 置顶状态和不可变回执在升级到 8 后保留。旧版拒绝测试复现已交付 v4 的版本准入条件；没有运行其旧二进制，不等价于跨版本端到端恢复验证。

当前[离线维护入口](STORE-MAINTENANCE.md)支持 schema 3、5、6、7、8 源库备份及核验，但 restore 只创建新 schema 4 只读档案，不实现上述可执行回滚。完整平台故障资格与跨版本二进制回滚验收仍未完成；临时数据回归不能替代这些门禁。

## 4. Rename / archive / restore

公共 Conversation 包含 scope/title/revision/createdAt/archivedAt。create 增加 requestId；rename/archive/restore 带 requestId、expectedRevision。getConversation 返回当前元数据，getConversationCommandResult 返回保存的首次命令结果，二者不能混淆。

- rename 只改标题，归档对象也可改名。
- archive 复用会话准入串行与 broker.locked，在同一个 PI commit 中核对 live receipts、LiveDoc、非终态 tasks、待决审批和未核对效果。暂停任务也可能忙，不能只检查 snapshot.running。
- 忙碌返回 CONVERSATION_BUSY，未知效果由 broker 返回核对所需错误。成功时写 archivedAt/revision、使有效授权失效并保留全部审计。
- broker 通过注入 assertConversationActive 在授权和最终工具/模型准入检查归档状态；UI 禁用不能代替可信端检查。
- archived 默认不显示，但可用 archived/all 列表及精确 ID 找回。history、receipt、entry、operation 和 PI durableId 不变，数据库不删除。
- restore 清归档标记并增加 revision，不创建新 PI conversation，不恢复旧授权，不 resume、不自动发送旧请求。旧 archive 请求的重试只回放当时结果，不把已恢复会话重新归档。

## 5. 当前预算与仍待验证的规模

代码中的限制是资源/准入限制，不是历史淘汰策略：

- 每页目录 50 项，传输总帧继续小于 1 MiB。
- 每 workspace 最多 100 个未归档会话；归档空闲会话可释放名额。
- 每会话最多 64 个未决 receipt；完成后准入刷新会释放 live 引用，原 ReceiptDoc 永久可查。
- WorkspaceLive 最多 256 个有未决引用的会话；已有未知/待决不删除，达到上限只拒绝新增。
- 权限 active/pending/effect 名额与历史分开；旧库超过新 live 阈值时保留全部已有记录，只阻止新增副作用，具体上限见权限实现。
- dependencies 的 256 项仍是保留上下文安全边界；不能因授权过期或归档删除依赖，也不能擅自合并为更宽的许可。

尚未实施：全局 scheduler 并发预算重整、磁盘占用 UI/软阈值、自动审计清理。安全 Harness 回收的 canEvict 检查保守保留 observers、scheduled、PI 未决任务/提交、active broker 状态与未知 receipt；关闭后重新打开不得偷偷 resume。没有永久删除历史或自动压缩策略。PI watch/单条 entry 可能完整物化，传输分页不能证明全过程内存严格有界。

## 6. 目前验证与下一步基准

[capacity-archival.test.ts](../../packages/work-runtime/test/capacity-archival.test.ts)使用真实 SQLite 和 faux provider，覆盖：

- create 失回包只读核对首次 ID，重复请求和不匹配 digest。
- 归档恢复保持历史/回执/身份，旧命令结果不被当前状态覆盖。
- accepted/暂停请求拒归档，取消后保留 cancelled 回执。
- 55 个会话的 50+5 分页、过滤与 stale cursor。
- root 投影写入失败时 PI 命令及取消可用，索引缺行可重建。
- 单会话 65 次已完成提交，旧回执可查。
- 旧目录迁移中断/重启、原 durableId 不变、旧数组权威退休。
- root identity 丢失时拒绝生成新身份。
- 精确元数据和目录命令查询在 resume:true 下也不调用 provider。
- 真实 SQLite 的空闲可回收、observer/有效授权/暂停请求不可回收，撤权及取消后的回收判断。

权限 owner 的容量测试另覆盖 140 次授权/撤销、65 次真实提案逐次拒绝、70 个 provider session、旧 64 个 unknown 的保留迁移。执行结果按本轮实际日志汇总；测试数量不能替代 RC 门禁。

[小规模目录基准](benchmarks/capacity-2026-10-19.md)已记录 10/100/1,000 个空历史会话的实测与环境限制，其源码早于本轮 checkpoint 改动，不当作新版性能证明。后续仍需加入长消息与工具审计，测冷/热目录第一页、尾页、单条授权/撤权、rename/archive/restore、空闲回收前后 RSS、DB/WAL 字节。记录 OS/CPU/RAM/Node/SQLite、源码及锁文件摘要、p50/p95/max。默认小规模，较大规模显式参数；不调用付费服务、不读取用户文件。

性能候选目标尚未测得：目录第一页 p95 < 150 ms、元数据变更 p95 < 100 ms；历史增长 10 倍时单条提交不应随历史线性增长。跨库真实进程 kill、磁盘满、断电、三平台、长期 RSS 和实际 UI 交互仍需后续证据；当前异常注入和 SQLite 测试不能代替它们。
