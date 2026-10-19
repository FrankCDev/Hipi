# 内置文件工具与持久授权决策草案

日期：2026-10-19。第 1–9 节保留实施前的设计与验收要求；当前实现、验证证据及尚未关闭的限制见第 10 节。设计矩阵不等于已全部验收。

## 1. 问题与最小决策

目前人工文件编辑已经经过 FileAuthority，但 PiWorkspace 使用空扩展 registry，真实模型没有文件工具。仅把 FileService 包成工具会把“允许用户看目录”误变成“允许 Agent 将内容发送给模型”，也没有逐次写审批与崩溃核对。

建议第一条生产纵切仅支持已存在的 UTF-8 文本文件：`hipi_files_list`、`hipi_files_read`、`hipi_files_save`。不支持新建、删除、shell、任意绝对路径、任意 Node 插件。数据路径为模型 → Durable ToolTask → 可信授权 broker → 当前 FileAuthority；人工编辑与 Agent 共用文件服务，但权限目的分开。

示例：用户选择目录用于手动编辑 → 单独允许本会话将该目录的名称和文件内容发送到指定模型 → Agent 读取 r1 → 提出保存 r2 → 展示目标、差异与 r1 → 用户批准这一次写入 → 再验授权和版本 → 写入 → 核对结果 → 模型总结，工作台保留用户 dirty 草稿。

## 2. 已核实的公开 API 与限制

以本工作树 `@earendil-works/pi-durable` 1.3.0 源码为证据；文档历史基线为 `1402973a9dbe8c627341e04c9744c54953e285ca`，本环境没有可用 Git 元数据，不能声称当前 checkout 就是该 SHA。没有读取凭据、调用真实模型或访问用户文件。

| 能力 | 公开 API / 源码证据 | 实施含义 |
| --- | --- | --- |
| 注册工具 | [index.ts](../../packages/durable/src/index.ts)、[define.ts](../../packages/durable/src/harness/define.ts)、[registry.ts](../../packages/durable/src/harness/registry.ts)：`createRegistry()`、`defineTool()`、`defineExtension()`、`registry.install(extension)` | registry 初始只有内置任务，没有文件工具；应用持有 registry，不开放 renderer 任意注册 |
| 参数及执行 | [ToolRegistration / ToolExecutionApi](../../packages/durable/src/harness/types.ts)：TypeBox parameters、`execute(args, api, context)`、`api.commit`、`api.taskId`、`api.callId` | schema 拒绝未知字段，执行身份取 api 与宿主绑定，不能信任模型参数中的身份 |
| hook | 同上 `hook(ToolTask, { beforeTool })`；返回 `{ block }` 或 `{ arguments }`；HookApi 只有读取与 memo | 没有内建 approve/reject/pending API；应用自己持久化审批。HookApi 没有 commit/watch，等待必须经宿主私有 broker 使用 Harness 公开 API |
| 恢复 | [ToolTask](../../packages/durable/src/harness/tool.ts) 的 call / execute 两阶段 | call 阶段校验、hook 后先提交 intent 再执行；恢复 execute 阶段跳过 beforeTool。只把 gate 放 hook 会漏掉安全重放 |
| 重放 | ToolRegistration `replay: "safe" | "unsafe"`，默认 unsafe；恢复须记录及当前定义都 safe 才重跑 | 首版 save 显式 unsafe；list/read 可 safe，但 execute 必须每次重新查权限。unsafe 中断返回 interrupted，不保证未修改文件 |
| 持久记录 | `defineDocFamily`、`Harness.commit`、`tx.doc`、`tx.task`、`Harness.watchDoc`、`snapshot` | session-scoped 授权/操作记录保留审计；不要放只活到任务结束的 task docs，不另建数据库生命周期 |
| 任务/取消 | `Harness.getTask/inspect/abortTask/abortSubmission`；[types.ts](../../packages/durable/src/types.ts) `abortRequested` | cancel mark 是拒绝新操作的依据，不能用 UI running 或 paused 布尔值替代；查询不应启动 scheduler |
| 工具可见性 | `Conversation.configure({ tools, modelTools })`，`callers` | tool 名称选择不是授权。首版 callers 仅 model，后续 nested calls 也必须过同一 broker |
| 模型上下文 | `GenerationHooks.beforeRequest` 每次尝试执行；[model-provider.ts](../../packages/work-runtime/src/model-provider.ts) 统一生产模型调用 | 工具结果会进入后续模型请求，撤销与模型变更还需要出站 gate；不能只禁止后续 read |

现状入口：[pi-workspace.ts](../../packages/work-runtime/src/pi-workspace.ts)、[文件契约](../../packages/work-runtime/src/files/contracts.ts)、[FileAuthority](../../packages/work-runtime/src/files/service.ts)、[文件宿主](../../packages/work-runtime/src/files/host.ts)。FileAuthority 的 root grants 是内存 Map，重启重新 grant 得到新 rootId；无持久 OS 权限，也不是跨进程原子 CAS。其最终 rename 前已有授权与 ifMatch 检查，但没有 Agent 授权回调。现有 [history.ts](../../packages/work-runtime/src/history.ts) 仅投影 user/assistant text，工具调用及结果还需专门投影。

## 3. 两种授权与持久事实

1. **文件根许可**：宿主 picker/可信配置授予 principal + workspace + rootId + writable。仅它允许 FileAuthority 操作；不会自动授予 Agent 上下文权。
2. **Agent 上下文许可**：明确说明“此会话可列举并读取所选范围，目录名称、内容以及衍生摘要可能发送给所选 provider/model”。范围包含 storeId、workspaceId、conversationId、rootId、路径范围、模型引用、用途、期限、授权版本、宿主 grant generation。授权命令只能来自经认证的用户通道，不能来自工具或文件内容。
3. **逐次写许可**：每个 save 必须有独立审批，绑定 taskId、callId、有效输入 submissionIds/receipts、工具定义版本、完整规范化参数摘要、目标 root/path、ifMatch、拟写入内容 SHA-256、授权版本与有效期。只确认某路径或 UI bool 不足够。

建议三个 session doc families：`hipi.agent-context`、`hipi.tool-approval`、`hipi.file-operation`，以及有界审批索引。均使用 Durable 同一提交线。审批记录表达 `pending | approved | rejected | expired | invalidated | consumed`；操作记录表达 `prepared | executing | confirmed | conflict | unknown | observed_match`。这些是权限和副作用事实，不是第二套 Task 状态机。记录 schemaVersion、序号和保留预算；预览正文限额且按敏感工作内容存储，日志仅记摘要与稳定错误码。

任务归属从 PI 实际记录取得；普通模型调用可在同一事务读 LiveDoc.run.inputs 并核对 ToolTask 与 generation owner 链，立即持久记录对应 submission 集合，再关联现有 ReceiptDoc。不能用“最新请求”或当前 run.taskId 猜测；PI 一轮可能承接多个输入，显示集合而不假装唯一请求。不能证明归属则拒绝写授权。

重启后旧 rootId 未重新验证即不可用。最小实现使旧待批/已批许可失效，重新选择根并明确授权；不得仅按绝对路径相同恢复许可。已 executing 的操作保持 unknown，不因许可失效伪装成未执行。恢复只读核对也须在重新确认根身份及核对访问权后进行。

## 4. 最小 registry、端口和命令 DTO

以下是建议的新接口，不是声称现有 API 已具备。内部端口留在 work-runtime，浏览器契约不导出 Harness、文件绝对路径或原始 FileAuthority。

```ts
// 工具参数：workspace/conversation/principal 均由可信调用身份绑定。
type ListArgs = { rootId: string; path: string; cursor?: string };
type ReadArgs = { rootId: string; path: string };
type SaveArgs = ReadArgs & { text: string; ifMatch: string };
// 不允许模型传 approvalId 来选择别人的许可。
type Invocation = { taskId: string; callId: string; conversationId: string };
interface AgentFilePort {
  list(call: Invocation, args: ListArgs): Promise<FilePage>;
  read(call: Invocation, args: ReadArgs): Promise<FileText>;
  save(call: Invocation, args: SaveArgs): Promise<FileSaveEvidence>;
}
type AuthorizeContext = Scope & {
  requestId: string; rootId: string; paths: string[];
  model: ModelReference; expiresAt: number; disclosureVersion: number;
};
type DecideToolApproval = Scope & {
  requestId: string; approvalId: string; expectedApprovalRevision: number;
  argumentsDigest: string; decision: "approve" | "reject";
};
type RevokeContext = Scope & { requestId: string; grantId: string; expectedRevision: number };
type QueryApprovals = Scope & { cursor?: string };
```

新增 `authorizeAgentContext`、`revokeAgentContext`、`listToolApprovals`、`decideToolApproval`、`getFileOperation` 公共命令，复用 AppClient 的身份校验、请求去重和 IPC/HTTP schema。相同 requestId/相同参数返回原回执，不同参数冲突；decision 的比较交换必须检查仍 pending、未到期、任务仍 live 且无 abort mark、宿主 generation 和上下文许可有效。批准不隐式调用 resume；工作区暂停时仍暂停。

组装用 `registry.install(defineExtension({ name: "hipi.files.v1", tools: [...] , hooks: [...] }))`，只注册这三个实现；save sequential/unsafe，读工具有界输出。closure 注入 workspace-bound AgentFilePort；没有 ExecutionEnv、shell、宿主 Models 或任意 path 的转发入口。不要把现有 FileService 原对象交给模型可执行代码。工具版本及参数摘要必须同时被 broker 核对，后置 hook 改参数不能沿用旧批准。

## 5. 审批、写入和恢复时序

1. beforeTool 的 save guard 经私有 broker 创建/读取精确审批记录，停留在 PI call phase 等待。等待使用 Harness.watchDoc 的当前 value + start，避免先读再订阅漏事件；期限 timer、取消、close、watch failure 均清理监听并 fail closed。没有必要新增泛化工作流引擎。
2. 用户决定事务提交后，批准只让该 guard 返回；拒绝、过期或失效返回 block。拒绝记录不能再次被同一次请求批准。崩溃时 call phase 可重新运行，但只能找回原记录，不能生成新批准。
3. Durable 提交 execute intent。save.execute 仍必须检查最终 args 摘要、上下文权、根绑定、工具版本、任务 abortRequested、审批期限和状态。在一个 `api.commit` 中消费许可并持久写入 prepared/executing 意图；重复执行看到 consumed 不再写。
4. 实际受控写入与 revoke/cancel 使用同一操作互斥/授权线性化规则。需要给 FileAuthority 可信写通道增加最终替换前 Agent gate，不能只在调用 saveText 前检查。该 gate 不开放到 renderer；最终 gate 必须重新确认任务、许可和上下文。先消费许可但尚未写期间取消，应阻止 rename；最终写已开始后取消不能承诺撤回，应报告可能已写并核对。
5. 保留 FileAuthority 的 ifMatch、编码、大小、链接与根身份检查。审批期内文件变化返回 conflict，绝不偷偷更新 ifMatch 或沿用批准。保存结果落操作记录，随后工具返回受限摘要与 revision，不将整份写入正文再输出一次。
6. 在 rename 前后、操作确认提交前后都可崩溃。save unsafe 不自动重放；重启扫描 executing 记录：当前 hash 等于拟写 hash 可标 observed_match（当前内容相符，并非证明谁写入）；等于原 hash 也不能证明从未写过，其他 hash 则冲突/未知。没有足够证据一律 unknown。再次写必须是新调用、新版本、新审批。
7. 所有出站模型请求也要检查该会话已经引入的文件上下文许可。撤销、过期、模型变更或宿主 grant 失效后，最保守首版阻止受影响会话继续发送历史内容，要求重新明确授权或无旧文件上下文的新会话。摘要、compaction、重试和恢复请求都算传输；Generation hook 单独不足以覆盖其他模型入口，需统一覆盖/禁用未覆盖入口。撤销不能收回此前已发出的数据。

审批等待不能调用会隐式 resume 的 Submission.wait / Conversation.abort。沿用现有暂停取消的 Harness.abortTask / abortSubmission 路径；continueWorkspace、retryTask、重新 submit 都不能清除授权门。读工具 execute 恢复同样重查 scope 和许可，结果交回模型前再次检查，防读取期间撤权后继续交付。

## 6. 用户可见投影

UI 从持久记录和 PI task/entry 生成 `approval-requested`、`approval-decided`、`tool-started`、`tool-finished`、`file-operation-unknown` 的有界视图，带 taskId/callId/approvalId/operationId、稳定序号及 workspace/conversation。重新连接先快照后增量，缺口重新读取；不会从本地按钮状态恢复授权。

卡片展示工具、目录显示名/相对路径、所选模型、有效期、参数摘要、expected revision、拟写入 Diff 和批准/拒绝。默认不展示绝对路径或工具整段原始参数；内容展开走受鉴权接口。等待审批、已拒绝、冲突、结果未知、已确认分开；取消后写入已发生仍显示证据。人工 dirty buffer 收到资源变更只提示冲突，不刷新覆盖。历史工具卡片需独立于现有 text-only history，拒绝与 interrupted 也必须可见。

## 7. 故障验收矩阵

全部用临时目录、确定性 faux provider 与测试凭据端口；不调用付费服务。HTTP/IPC 都执行权限与重连契约，文件语义再做三平台验证。

| 注入/攻击 | 必须断言 |
| --- | --- |
| 只有人工 folder grant，无上下文权 | 无文件工具内容发送，list/read/save 均不越权 |
| 伪造 workspace/root/conversation/task；绝对/遍历/UNC/编码路径；额外字段 | 服务拒绝，文件读写计数为零 |
| 指令藏在文件/模型参数；模型伪造 approvalId | 无授权新增，不能借用别人批准 |
| approve 重复、乱序、旧 revision、参数/正文/ifMatch 变更 | 原回执或冲突；最多一次消费、无第二次 write |
| reject/expiry/revoke 后再 approve，重启旧 rootId | 拒绝/失效；无写副作用 |
| 审批等待重启、watch 断线、存储失败 | 只从持久事实恢复；不丢决定、不自动批准，订阅有界释放 |
| approval commit 后 / PI intent 前崩溃 | 不丢持久决定；首版重启许可失效，无自动写 |
| PI execute intent 后 / consume 前崩溃 | unsafe interrupted；无自动重放 |
| consume 后 / rename 前取消或崩溃 | 取消在最终 gate 前阻止写；重启核对、无重复写 |
| rename 后 / operation commit 前崩溃 | unknown → 受权只读 hash 核对；不盲重放、不伪称 exactly-once |
| 用户/Agent 并发写、外部程序改 ifMatch | 冲突，dirty 草稿保留；明确 cooperative-local-files 限制 |
| read 后撤权、换模型、compaction、恢复模型请求 | 未授权文件内容/摘要不再出站；已发数据不宣称可撤回 |
| paused cancel / continue / retry 与 approve 竞态 | cancel mark 与最终 gate 生效，审批不启动 scheduler |
| 输出超限、未知工具、插件重复同名、工具版本变化 | 有界拒绝；不能覆盖核心 guard 或沿用旧许可 |

## 8. 实施分工与扩展关系

1. **契约/权限**：公共 DTO、schema、持久 doc、决定幂等、作用域/模型绑定与审批投影；先冻结数据契约。
2. **运行时/模型**：真实 registry 注入 PiWorkspace、beforeTool 等待、execute 二次 gate、模型出站检查、暂停/取消/关闭资源；不要将测试模型当生产组装。
3. **文件效果**：Agent 专用受控保存入口、最终 gate、operation evidence 和崩溃只读核对；沿用人工 FileService 的既有行为。
4. **UI/验证**：上下文授权、审批 Diff、工具历史和未知结果卡片；确定性 faux provider 跑完“模型 call → 用户审批 → 真临时文件变更 → 工具结果 → 模型回答”，并覆盖矩阵。

首发先交付内置工具闭环，不能据此声称插件生态完成。MCP 将来接入同一 invocation/broker，server 与网络/凭据权限另批；Skills 是不可信方法和上下文，不能授权工具。插件首发扩展面应沿用[扩展设计](design/WORKBENCH-AND-EXTENSIONS.md)选择一个真实、受控、版本固定的官方样例，验证安装/启停/故障/撤权，而非任意可执行插件 loader。Registry 可替换同名工具，必须保留核心命名空间并拒绝碰撞；hook 可删/替换时也不能移除 broker 的硬 gate。

普通 Node 插件或独立进程拥有宿主权限，不是安全沙箱；没有验证过的 OS 能力边界就不开放不可信执行代码。内置 broker 对合作式本地文件提供受控操作保证，不防恶意同用户进程，亦不提供断电持久性或跨进程严格 CAS 承诺。

## 9. 本次验证边界

已阅读 AGENTS、愿景/工程与产品原则、DESIGN-BLUEPRINT、相关扩展设计以及上述公开源码；只新增本文。链接及空白检查属于文档校验，未运行功能测试、构建、真实模型、凭据或用户目录访问。实现完成前必须提交对应行为证据，尤其不能跳过 hook 恢复旁路、模型出站与最终 rename gate。

## 10. 当前实现与验证记录（2026-10-19）

当前代码已由空 registry 改为固定内置文件扩展。实现入口为 [agent-tools.ts](../../packages/work-runtime/src/agent-tools.ts)、[PiWorkspace](../../packages/work-runtime/src/pi-workspace.ts)、[出站模型 facade](../../packages/work-runtime/src/agent-tools/model-gate.ts)及 [公共契约](../../packages/work-runtime/src/contracts.ts)。精确 DTO 以公共契约为准，前文草案示例不用于生成客户端。人工文件许可不授予模型上下文权。

- `hipi_files_read` 每页最多 8 KiB UTF-8，保留 Unicode 边界；后续页带 UTF-16 offset 与原 revision。`hipi_files_save` 最大拟写正文 64 KiB，返回摘要而不回显全文。list 超过 16 KiB 明确失败，不隐藏省略的目录项。
- 授权根 ID 与路径前缀通过有界 JSON prompt section 发现，只包含当前会话与模型的有效 `purpose: "live-files"` grant。metadata 总预算 8 KiB，在授权与构造 prompt 时都检查。内容进入 prompt/工具结果前持久登记依赖。
- PI session 文档保存上下文、审批及文件操作事实；`ProviderDoc.sessionId` 的持久映射在 conversationCreated 同事务创建，老 catalog 在 resume 前补齐并查重。审批通过 `watchDoc` 等待，不启用 scheduler。
- 保存明确 `unsafe`，执行时二次检查参数摘要、任务、call、输入 receipts、grant revision、期限及取消。消费批准后，可信最终文件 gate 与 revoke/cancel 共用会话锁，锁覆盖权限复核与最终 rename；模型网络等待不占该锁。
- 出站 facade 的最终 fetch 检查覆盖生成与 compaction，且同步验证宿主 root 仍有效。单会话撤权不阻止其他会话恢复；新 submit 对失效历史返回 `CONTEXT_AUTHORIZATION_REQUIRED`。
- `authorizeRetainedContext` 是独立的历史内容再次发送许可。输入仅含 scope、requestId、sourceGrantId、指定 model、expiresAt 与 disclosureVersion:1；source 必须是本会话曾授予的原始 live-files grant（允许已失效、撤销或过期），不能从 retained grant 链式派生。服务复制原 rootId/pathPrefixes，拒绝调用方指定或扩大范围；产生 `purpose: "retained-context"` 和 sourceGrantId，沿用 24 小时上限、幂等索引、审计与容量预算。
- 历史许可只让已登记依赖及衍生摘要通过出站 gate；不调用或复活旧 FileAuthority root，不允许列目录、读文件、核对文件或保存，也不出现在当前根发现 prompt。当前文件操作仍需有效 live-files grant、真实宿主 root 和独立逐次写审批。该许可同样在 runtime 重启后失效，旧 requestId 重放仅返回失效状态；需要新明确批准。旧 schema 1 无 purpose 的记录在恢复事务中标记为 live-files 并失效，不恢复任何权限。
- grant 到期检查保留在请求 admission 和最终 locked fetch；有界期限 timer 先持久更新状态，再在会话锁中按每个在途请求记录的实际 model 重验当前依赖及宿主 root。只有依赖不再被有效授权覆盖才中止请求并 best-effort 取消本会话 PI 任务；已续期覆盖或无关 grant 到期不打断现有流。逐次写审批仍绑定原 grant/revision/期限，不随新 grant 自动续期。显式撤销仍保守中止本会话运行，不影响其他会话，也不启动 paused scheduler。关闭释放 timer。新普通 submit 清除先前取消意图，不清除授权依赖、旧审批失效或 PI abort marks。
- `getFileOperation({reconcile:true})` 仅针对 unknown 进行受权只读 hash 核对。`observed_match` 只表示当前内容匹配，不证明由本工具写入，也不允许自动重写。

### 已执行的定向证据

[agent-tools.test.ts](../../packages/work-runtime/test/agent-tools.test.ts) 使用真实 SQLite Durable、faux 模型和临时真实文件，14 项通过：批准写入及最终模型回答、人工 grant 单独无效、拒绝/取消/撤权/待批重启不写、未知结果只读核对、分页和根发现、改摘要/旧 revision/重复决定、过期、消费批准后最终 gate 前取消、A 撤权与 B 恢复隔离、异步检查后宿主撤 root、同目录新 root 不恢复旧历史权限。

[model-gate.test.ts](../../packages/work-runtime/test/model-gate.test.ts) 包含最终 fetch 边界和真实 Harness 的读取、合法 compaction、撤权后再次 compaction/retry 不发送的证据。[agent-contracts.test.ts](../../packages/work-runtime/test/agent-contracts.test.ts) 检查共享 DTO、预算及 HTTP/IPC fail-closed；既有 core/runtime-model/model-provider 定向 41 项通过。runtime TypeScript 与浏览器无 Node 依赖检查通过。完整根检查曾通过；随后并发桌面打包改动出现格式错误，最终全仓结果由汇总验收另行记录。

历史重授权回归另覆盖真实临时文件读取后 SQLite close/reopen：同目录新 root 和新的 live-files grant 仍不能发送旧历史；明确 retained 授权后普通回答与 compaction 可继续，旧 root 工具仍拒绝。覆盖伪造 source、retained 链式 source、跨会话 source、错误 model/session、24 小时限制、重复 requestId 参数冲突、取消后新提交、历史许可再次重启失效、旧 pending 写审批不复活，以及历史许可撤销/过期后 compaction 与 retry 零额外 provider 调用。测试仅使用 faux/fake fetch，不读取用户文件或付费凭据。

### 必须保留的限制与后续工作

1. **重启后的历史上下文**：宿主 FileAuthority 根仍是进程内随机身份；重新选择同目录及新 live-files 授权不恢复旧历史。现在可通过独立 retained-context 明确允许旧内容/摘要再次发送指定模型，也可新建无旧文件上下文的会话。没有 root 重绑定、路径匹配复活或历史内容删除/脱敏能力；fork 不继承授权，不能借用父会话 source grant。
2. **容量验证边界**：权限历史已改为逐条 PI family 与固定 64 项 ID 审计页，不再因累计 32 次授权、256 次命令、64 次审批或 64 个 provider session 耗尽。依赖 256 项安全边界保留；大规模历史的延迟、内存、磁盘与三平台容量仍未验收，不能从小规模回归推断长期性能。目录及提交配额的最新状态见[容量设计](CAPACITY-AND-ARCHIVAL.md)。
3. **故障矩阵尚未全部验收**：unknown 用真实 rename 后丢确认注入；待批 restart 用 close/reopen。尚未执行 rename 临界区 SIGKILL、断电、三平台真实安装/文件语义、所有存储失败与 watch 断线组合测试。不宣称 exactly-once、OS 沙箱、跨进程严格 CAS 或完整生产长期可靠性。
4. **边界未扩张**：没有 shell、新建/删除文件、任意 Node 插件、凭据或真实付费模型验证；通用工具历史事件投影与完整插件生态仍是独立后续工作。重复决定返回同一审批的当前持久状态，不产生第二份批准或第二次写入。

### 权限容量实现与迁移

[authorization-store.ts](../../packages/work-runtime/src/agent-tools/authorization-store.ts) 保存逐条 grant、command、provider session 绑定与审计页。新建事实、序号、页索引及 live 集合在同一 PI commit 更新。active grants 最多 32 项，pending/approved 最多 8 项，新副作用的 unresolved 配额为 32；旧库合法的最多 64 个未知效果全部保留并阻止新增副作用，不截断记录。confirmed/conflict 释放 live 效果槽；observed_match 仍保留。恢复只读取 live 集合，使旧授权与审批失效。

历史授权每页最多 64 项且检查实际 JSON 字节预算，完整审批每页一项。当前有效授权、待决审批独立读取有界集合；审计游标固定首次 upper ordinal，绑定目录持久 generation、workspace、conversation 与种类，拒绝跨店/跨作用域复用。完整复制同一数据库保留其身份，不被视为新 store。索引仅定位记录，读取结果仍核验记录归属与当前权限状态。

新权限命令永久保存首次完整结果快照供审计，相同 requestId 重试返回当前权威对象，不恢复旧 active/approved 状态。只读 `getAgentCommandResult` 按本会话原 requestId 点查 method 与当前权威结果；不存在返回 null，不创建记录、不重放命令。旧命令迁移仅保留已有 digest/kind/resultId，不编造首次快照。旧数据迁移、索引与 live 集合建立以及旧数组退休在同一会话事务内完成，失败回滚；调度开放顺序由工作区迁移控制。

[agent-capacity.test.ts](../../packages/work-runtime/test/agent-capacity.test.ts) 的 4 项真实 SQLite/faux 回归通过：140 次授权与撤销（280 个命令）、65 次真实保存提案逐次拒绝后继续、70 个 provider session、旧 64 个 unknown 的原子迁移/失败回滚。另验证历史分页不混入后来新增、跨 store 游标拒绝、active 32 配额、只读结果不存在不产生记录，以及新命令首次快照与当前撤销状态分离。原 retained-context、短 TTL 重叠续期、最终 dispatch 和最终保存 gate 定向回归保持通过；未运行大规模性能基准。
