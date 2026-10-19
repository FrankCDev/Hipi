# Hipi Work runtime

第二阶段的本地应用核心：受鉴权连接握手、持久工作区/会话目录、创建工作区与会话、持久接收输入、PI 执行与流式观察、原请求查询、断线与进程重启恢复。执行事实来自 PI Durable，使用文件 SQLite；测试替换的是模型，不是存储或执行引擎。

本包还不是生产发布：运行入口必须显式选择 deterministic 或 openai。确定性验收模式不注册外部工具、不消耗模型额度；OpenAI 模式可能产生费用，凭据只通过模型设置输入并保存在宿主内存，重启清空。真实供应商、长历史、权限代理、迁移和三平台发行仍需独立验收。

## 模块边界

| 模块 | 责任 |
| --- | --- |
| `src/contracts.ts` | 浏览器安全 DTO、版本、输入与响应校验、稳定错误码、订阅终态 |
| `src/core.ts` | 应用用例、WorkspacePort、取消等待；不导入 Node、PI、Electron 或 HTTP |
| `src/pi-workspace.ts` | 公开 PI API 适配；交付回执与执行状态分离 |
| `src/history.ts` | 公开 fork-aware 历史分页、受控文本预览与原文块查询 |
| `src/store-catalog.ts` | 根目录持久身份与有界工作区登记、创建中断恢复、无 Harness 的会话目录读取 |
| `src/node.ts` | 私有数据目录、SQLite owner lease、显式模型注入与关闭 |
| `src/transport-http.ts` | 仅 127.0.0.1 的本地鉴权服务、固定 Origin/Host、有限消息/连接 |
| `src/transport-http-client.ts` | 浏览器安全 AppClient；令牌不进入 URL 或本地存储 |
| `src/transport-ipc.ts` | 真实受控 Node child IPC；不是 Electron preload |
| `src/testing.ts`、`test/` | 显式确定性模型、故障注入与测试 fixture |
| `src/dev-server.ts` | 显式选择 deterministic / openai 的本地组装入口 |

UI 只依赖公共 `contracts` 和 `http-client` exports。持久事实不回写 UI 缓存；停止观察只释放本客户端，不取消已接收的工作。`onStatus` 报告连接、主动释放、过期、断线与源端故障，重新观察取得新快照。

## 从干净源码运行

要求 Node 24.19.0（本次实际验证版本）、npm 11.9.0。本包使用 Node TypeScript strip-only 和 `node:sqlite`；其他 Node/OS 组合不据此宣称通过。

在仓库根目录：

```sh
npm ci --ignore-scripts
npm run hydrate:model-data
npm run check:model-data
node --conditions=source packages/work-runtime/src/dev-server.ts \
  --provider deterministic \
  --origin http://127.0.0.1:5173 \
  --data /absolute/private/hipi-work-data
```

源码包不包含模型 JSON；即使使用 deterministic，也须先完成上述 hydration 和校验。缺文件、数据过期、网络失败与离线准备见[根目录诊断](../../README.md#development)。新建会话时显式选择 `faux-1 · faux`；会话保存模型引用，不隐式采用宿主默认值。

第二个终端运行：

```sh
npm run dev --workspace=@hipi/work-ui -- --port 5173 --strictPort
```

打开 `http://127.0.0.1:5173`，将服务端终端显示的 API 地址与临时 token 填入连接面板。令牌只用于当前本地进程，不写入数据目录或浏览器持久存储。不要将服务暴露到公网；Origin 必须与页面完全匹配。启动日志显示允许的 UI Origin；5173 被占用时 Vite 明确失败，不应自行换到 5174。若明确改 UI 端口，必须同时改服务端 `--origin`。HTTP 诊断只输出稳定错误码，每分钟最多 16 条，不记录 token、请求内容或路径。数据目录应位于本机私有应用数据位置，不放项目 Git 目录、同步盘或网络盘。若默认 npm cache 不可写，可指定 `--cache /absolute/writable/npm-cache`。

`openRuntime(directory, { models, model, ... })` 是显式模型依赖注入点；没有隐式假模型默认值。`openTestRuntime` 才安装确定性 provider。当前验收只覆盖该无工具 provider，不把“接口可注入”当成真实供应商的安全、配额或恢复验收。

## 连接身份与目录

- `handshake({})` 返回 `{protocolVersion: 3, storeId}`，经过与所有请求相同的 HTTP token/Origin/Host 验证或继承 IPC 通道。它不创建工作区、不打开 Harness、不开始执行。协议 1/2 客户端应与服务端一起升级；持久目录与回执 schema 不因这一传输变更而修改。
- HTTP/IPC client 锁定首次验证的 storeId，每个后续调用和观察都发送 expectedStoreId，服务端在用例执行前核对。同 URL 换后端返回 `STORE_MISMATCH`；原 client 不能自动换身份。新连接需要新 client 与重新握手。
- 根 `catalog.sqlite` schema v1 保存随机 storeId 与规范数据根路径；URL、端口、token 和进程不是持久身份。复制/移动到不同规范路径会拒绝启动，不自动改 ID。当前未提供迁移或恢复身份重建工具；不得手动删 catalog 来绕过该保护。相同绝对路径的跨主机克隆、备份回退检测尚未实现，不能作为受支持的同时运行方式。
- 根 owner 锁覆盖 catalog 与 workspace 生命周期。创建顺序是 pending 登记 → PI 初始化 → ready 登记；中断保留原目录和 pending，显式同 ID/同名可继续。重启扫描最多 64 个根目录条目，发现第一阶段工作区或已提交但未 ready 的 PI 元数据，修复登记。已登记库丢失时拒绝重新创建空库。
- `listWorkspaces({})` 返回最多 16 个已 ready 工作区；`listConversations({workspaceId})` 返回最多 16 个会话。会话标题与公共 ID 直接读取公开 PI Storage document，不复制执行状态、不打开 Harness、即使 host 的 resume 为 true 也不因列表读取执行工作。Storage 打开可能执行上游 schema 初始化，不宣称是物理只读 SQLite 连接。
- 创建会话还没有幂等回执；失回包后应刷新目录核对，不自动重发创建命令。提交输入仍按原 requestId 查询/重试。

## 接收与恢复

- 同一工作区、受信任本机 owner、命令种类及 requestId 对应一个回执文档。目标、文本及协议语义参与摘要；同键改文本或会话被拒绝。
- 接收事务落盘后才返回 `accepted`；它不是“模型已完成”。交付经过 `dispatching`，PI 接收后写 `dispatched` 与 Submission ID。
- 交付标记、PI submit、映射保存是三个可恢复步骤，不宣称跨步骤单事务。重开先通过公开 `Tx.submissionByRequest` 查原映射，再决定是否继续交付；不会用 submit 冒充查询。
- 握手和目录查询不启动调度。打开工作区或读取具体快照/回执时会初始化 Harness，是否恢复由宿主显式 `resume` 策略决定；验收宿主选择 `resume: true`，检查模式可选择 false。固定模型测试不会重放外部工具副作用。
- 一个回执一份文档；最多 16 个工作区，每个工作区目录索引最多 16 个会话、每会话 64 次输入，输入最多 4096 字符。去重证据不清理、不允许旧键静默重用；达到限额拒绝新输入。
- 同键并发重试只持有一个待交付闭包。执行结果和回答只从原生 Submission/Entry 读取，不维护第二套任务表。
- PI 可能把被中断的生成保留为 assistant Entry；DTO 以 `interrupted: true` 标识该片段，不把它当最终答案。最终结果从原 Submission 的 done/answer 确认，不按 assistant 消息数量推断执行次数。
- 独立 SQLite `BEGIN EXCLUSIVE` owner lease 持有本机 OS 锁；规范化数据根、拒绝工作区 symlink。不会根据 PID 或心跳超时抢占。只有确认 Harness 关闭后释放锁；关闭失败保留锁并允许重试，无法确认启动清理时保守留到进程退出。

## 验证命令

只运行指定文件，不触发上游付费或环境相关 e2e：

```sh
node --conditions=source --test \
  packages/work-runtime/test/core.test.ts \
  packages/work-runtime/test/catalog.test.ts \
  packages/work-runtime/test/identity.test.ts \
  packages/work-runtime/test/transport.test.ts \
  packages/work-runtime/test/transport-runtime.test.ts \
  packages/work-runtime/test/dev-server.test.ts
npm run check
```

干净 checkout 的上游全仓类型检查需要生成模型目录；若提示缺目录，先运行官方 `npm run hydrate:model-data`，再运行 `npm run check`。该步骤获取公共模型元数据，不调用模型推理，不修改生成的 TypeScript 源码。仅本包检查可运行 `npm run check --workspace=@hipi/work-runtime`。

根 `check` 包括本包严格类型与浏览器 bundle 边界检查，以及 UI 严格类型检查。没有执行全量 `npm test` 或 `npm run build`。

## 尚未验收的边界

- 应用快照已改为最新历史页和明确标识的实时预览，`getHistory` 与 `getMessageText` 提供更早消息和完整原文块；回执回答与失败原因同样有界。详见[历史边界](../../docs/agent-work/HISTORY-BOUNDS.md)。epoch/version 仍不是持久事件日志，不提供增量重放。PI 的 `Conversation.watch()` 和单条 entry 读取内部仍可能装载完整数据，不能据此宣称整个运行时内存严格有界。
- SQLite 使用上游 WAL/NORMAL；进程崩溃测试不等于断电持久性证明。跨平台文件锁、损坏/磁盘满、备份/迁移尚未验证。
- HTTP 是单用户本地协议，不是公网服务或多租户鉴权。IPC 是 Node child 实际通道，不代表 Electron sender/preload、utilityProcess 与桌面窗口已经验收。
- Electron 内嵌 Node/SQLite/PI 探针与真实 Electron host 分开记录，见 `../../experiments/electron-host/README.md`。
- `cancelExecution` 请求取消会话执行，`continueWorkspace` 显式继续工作区；二者不提供工具权限或副作用回滚。`cancelWait` 明确只停止等待。输入恢复与模型生成可重复的保证不能推广成外部副作用 exactly-once。
- 创建会话暂未具备提交回执式去重；已持久工作区和会话可由经鉴权的新浏览器连接发现；归档/删除与迁移不在本轮接口内。模型目录、会话模型及凭据管理通过受校验的接口提供；模型供应商的真实鉴权与计费行为仍需独立验收。
