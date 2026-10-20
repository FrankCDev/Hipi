# Hipi Work 1.0 RC 执行与验收跟踪

2026-10-20。状态：已授权推进，尚未达到 RC。本文记录执行基线及盘点，不是功能通过证明。

## 1. 授权与决定边界

用户明确要求“全部功能对接、1.0 RC”，并指示“不用再等我确认，你帮我做所有决定，只管推进完成为止，1.0 RC”。因此，普通产品与工程取舍由项目负责人决定并记录，不再以旧阶段文档中的待评审措辞停止实施。此次授权不等于已经实现，也不扩展为无限功能、全部上游接口或任意 UI 插件兼容。

实际凭据输入、持久访问权限、付费服务、安全权限变更、永久删除等继续遵守各自确认边界。不得从普通工程授权推断可读取环境秘密或自动使用付费模型。用户已批准向 `dot/develop` 提交并推送；尚无 Release 发布授权。本文不改写 [AGENTS.md](../../AGENTS.md) 的命令规则。具体构建、安装脚本及测试执行依据实际授权另行记录，不以本文替代。

首发执行方向：本地单用户、多工作区、受限多任务；Electron 薄宿主和独立 runtime；核心不依赖 Electron；同一 AppClient 经 IPC 和受控 loopback HTTP 工作。真实模型优先官方 OpenAI 的公开接口/API key 路径，不读取 ambient auth，不承诺任意兼容服务。文件编辑使用 CodeMirror 方向；预览只读；扩展选择明确受控的首发扩展面，不以任意 Node 代码或 UI 代码加载冒充安全插件生态。具体协议、扩展格式与版本由对应实现决策记录确定。

## 2. 状态和证据规则

- 实现状态：已有基础、部分、缺失、实施中；只描述盘点时源码。新代码合入后更新，不能由计划直接改为完成。
- 验证状态：passed / failed / blocked / not_run。每个结果绑定实际构建、平台、adapter、命令或步骤及证据。
- 确定性模型验证真实 PI/SQLite，不验证真实供应商；Node IPC 和 peer doubles 不验证 Electron；SSR/受控尺寸不验证 DOM、IME、布局或网络。
- 历史证据不可充当最新工作树重新验证。本地源码工作区无 Git 元数据时，以源码清单/摘要和锁文件关联构建；远端提交另行记录，不伪造本地 `git diff --check` 成功。

### 当前状态（2026-10-20，覆盖下方历史检查点）

- 最新已核实的冻结检查点为 `04340446293a257475c6fdbff9893ab002bd1bdb`，分支 `dot/develop`，[CI run 39352844552](https://github.com/FrankCDev/Hipi/actions/runs/39352844552)。这是**整体 UI 重设计之前**的构建：两个 macOS 任务成功；Ubuntu 22 基础 GUI、严格长历史及真实维护闭环通过，但文件工作台场景失败；Windows 源码验证和 Ubuntu 24 GUI 仍失败。整轮未通过 RC，详见[本轮验证记录](evidence/packaged-gui-run39352844552-2026-10-20.md)。
- macOS ARM、macOS Intel 和 Ubuntu 22 的严格长历史原始报告均为 passed。200 条种子历史之外，实际 GUI 只提交一次探针；离开底部后分别取得 4、3、3 个全局 Running 状态下的不同真实 partial，阅读锚点稳定，前插/最旧历史/完整原文展开折叠、会话隔离、只读重开及最终冷读全部通过。冷读确认 202 条消息、一个探针、两个控制会话消息，原有 200 条标识及内容保留。未降低至少三个 partial 的要求，也未放慢固定回复；不是性能预算或长期资源证明。
- Ubuntu 22 新维护场景通过：Electron 正常退出后，用随包独立 Node 24.22.0 执行 backup/verify/restore/inspect/history/activities/export-history；原有文件字节不变，只出现允许的空 WAL 和 32 KiB SHM，隔离恢复档案只读且未变。再启动 Electron 后同一 scope、requestId、消息标识与 done 回执一致；两次退出和最终清理均确认。此证据不是原生维护 UI、断电恢复、可执行恢复库或三平台维护通过。
- Windows 源码 Node 测试为 676 passed、2 failed、10 skipped：无 profile/module-search 环境下的请求解析返回 helper timeout，以及合成 TaskDialog 未分类出预期 `ERR_MODULE_NOT_FOUND`。TaskDialog 就绪已可观察，但不能据合成诊断测试推断 Hipi 本身缺失模块；本次打包 GUI 未运行，真实启动异常尚未查明。Ubuntu 24 原始报告确认 renderer 就绪前退出，日志为 SUID sandbox helper 配置错误；未更改全局安全设置，不以 Ubuntu 22 成功替代。
- Ubuntu 22 文件工作台场景在 renderer 前因合成 fixture 处于禁止的 profile 根目录而被拒绝；所有文件功能仍为 not_run，不能把启动门禁拒绝写成编辑器或预览验证通过。fixture 移入允许的 profile 子目录及 Windows 诊断修复属于后续改动，待新构建验证。
- 用户追加的整体 UI 重设计已进入当前源码，但尚未获得原生验证。上述长历史、截图、布局及维护结果不覆盖重设计后的工作树；必须为新 UI 冻结源码、统一检查、重新构建并重跑对应原生场景。
- 已核实旧 AppImage（SHA256 `05c777254237f35d00aa21b3e18ac7cbb56d267d8cac7f76567e13d9ad6bb3c0`）的 desktop 入口与 AppRun fallback 使用 `--no-sandbox`，该产物仍不合格。最终真实 AppImage 的入口、launcher 和 sandbox 资格须独立审计，打包应用 GUI 成功不等于 AppImage 安装/入口通过；保留 AppImage 形式，不放宽 Ubuntu 24 安全要求。
- 历史测试数量不代表本轮或后续工作树。当前证据只绑定上述提交及源码摘要；之后的修改必须重新绑定统一门禁、构建及平台验证。真实模型、系统密钥链、安装、签名/公证、更新回退、物理 IME、断电/磁盘故障和长期负载仍有未通过门禁。
- 以下带时间的记录为历史结果；历史阻断与通过均不覆盖本节当前状态。全部未勾选 RC 门禁继续保留。

### 历史实现与验证记录

当前应用协议与公共命令以 [contracts.ts 的 PROTOCOL_VERSION](../../packages/work-runtime/src/contracts.ts)为准，握手要求精确版本匹配；17:44 已交付的容量/归档阶段包为协议 4，17:07 工具授权阶段包为协议 3。已接入模型目录、固定会话模型、凭据状态、运行中执行取消及显式工作区恢复；默认桌面组装使用真实模型 adapter，确定性模式独立保留。暂停任务取消会持久化取消意图而不启动 scheduler；`cancellation_pending` 与最终 `cancelled` 回执分开，均不表示已发生副作用回滚。分页目录、永久请求核对、归档/恢复、授权审计分页及安全工作区逐出已接入；[扩展生命周期](TOOL-PACK-LIFECYCLE.md)和[工具活动与成果入口](TOOL-ACTIVITIES.md)已有源码，最新整体验证正在收敛。Agent 文件工具、持久审批和历史上下文重新授权见 [TOOL-AUTHORIZATION.md](TOOL-AUTHORIZATION.md)。文件独立端口、CodeMirror 工作台及受限预览已有源码接入，真实交互验收仍待完成。

2026-10-19 15:59 UTC 检查点：整仓 `npm --offline run check` 通过；定向 runtime 62 项、UI 15 项、desktop 29 项通过；桌面生产构建通过。这些验证没有调用真实模型，没有验证系统密钥链或真实 Electron GUI。渲染主包约 721 kB，仍有超过 500 kB 的构建警告，未隐藏或当作性能达标。之后新增文件链路需再次统一检查，不能继承此结果。

2026-10-19 后续定向检查点：协调者报告 runtime 非预览 17 个测试文件 109/109、desktop 41/41、预览 worker 10/10、预览 service/HTTP 11/11 通过。之后 desktop 又新增 late-result 回归，最终计数和统一验证待更新。这些是明确范围的定向结果，最新整仓 check/build/test 尚待 UI 收尾，不据此记为 passed。依赖审计已有发现，见 [DEPENDENCY-REVIEW.md](DEPENDENCY-REVIEW.md)；不声明零漏洞。实际 GUI、IME、三平台与真实付费服务验收仍为 blocked / not_run。

2026-10-19 17:05 UTC 历史源码检查点：整仓 check 通过，显式 source verification 为 379 项 Node 测试及 13 个 UI Vitest 文件的 61 项测试全部通过。发布构建与 stage 通过，源码快照 SHA256 为 `e821b5432c6f64fbe72f0e06026e5b6726cd6821172680a5eb0d29d71b2dbe03`；177 个 payload 文件、167 个实际 bundle 包 owner，许可缺失检查为零（不代表法律审查或零漏洞）。PDF 本地 CMap/字体及四份许可已随包准备。当前 renderer 4,141.14 kB / gzip 2,121.18 kB，PDF worker 1,188.81 kB；500 kB 警告保留，后续需拆分与实际性能测量。历史安装产物的 Electron Node-mode CSV parser/SQLite smoke 通过，仍不等于 GUI 或 utility IPC。当前授权/请求累计配额、会话归档和扩展生命周期未完成，因此不能称为 RC。新源码包与 Linux unsigned 产物正在准备。

## 3. 功能矩阵

2026-10-19 18:48 UTC 维护与持久性检查点：整仓 check 通过，1618 文件无格式修复；显式验证为 527 项 Node、20 个 UI 文件的 107 项 Vitest，以及 Chord/Durable 六文件 110 项 SQLite 测试全部通过。新增离线 backup/verify、新目录 schema4 只读恢复、历史/工具活动读取和顺序 NDJSON 导出；失败关闭保留 owner、跨进程目标竞争和快照后效果不重放有临时数据回归。旧 SIGKILL 测试的“生成已完成后才 kill”竞态已改为受控持流且确认 durable partial 后 kill，未放宽断言。Hipi 四个工作库打开路径明确 FULL；通用上游默认 NORMAL、只读行为不变。冻结 build/stage 通过，source `1bf9f79b7f3b26e1f3fc3442350a362c45f9c88118402b51c67352ed5ceefffc`，锁仍 `c50a291b17168a06904e4f92d6d82cc9b93b390e3bd467ee42d49001d61f06e1`，179 payload、0 缺失许可，包含独立 maintenance.mjs。此前 FULL 改动前的维护 stage（source 9a7208f…）已通过仓库外 Electron Node-mode 维护闭环；新 FULL 安装包尚待最终打包并重新验证，不能混用旧包证据。[小规模 FULL 基准](benchmarks/capacity-full-2026-10-19.md)前后源码无变化，1,000 空历史会话首页 p95 1.96 ms；不是长消息、SSD、三平台或断电证明。原生维护 UI、实际 GUI/IME、三平台安装和平台同步资格仍未关闭。

2026-10-19 18:17 UTC 协议 5 检查点：整仓 check 通过，1596 文件无格式修复；显式验证 489 项 Node 测试、20 个 UI Vitest 文件共 107 项全部通过。包括真实 HTTP / fork Node IPC 的工具包生命周期、未截断工具输出从 SQLite 到 UI 会话的跨层回归，以及本地文档 checkpoint 的真实冷读。独立安全复核覆盖撤权竞争、描述符身份和 schema 3 降级屏障；未执行旧二进制实测或断电测试。冻结 build/stage 通过，源码摘要 `8736ded53f01b3dae72034f18d4d08b22a6d83b61c8ea7a2ffe37059c5ca51d9`，锁摘要 `c50a291b17168a06904e4f92d6d82cc9b93b390e3bd467ee42d49001d61f06e1`，178 个 payload 文件，许可缺失为零。品牌资产已接入；renderer 4,223.04 kB / gzip 2,141.47 kB，超 500 kB 警告保留，未声称性能达标。此时尚未生成本轮安装包，现有旧 Linux 安装包不能代表本轮。真实 GUI、三平台安装、备份恢复产品功能仍阻断 RC。

2026-10-19 17:40 UTC 容量检查点：整仓 check 通过；显式验证为 434 项 Node 测试、16 个 UI Vitest 文件的 80 项测试全部通过。冻结发布 build/stage 通过，源码摘要 `a5aeed28a3cf9d77a18ef88f597b30f8dbe854acf4e37cfc8775ee83fba3765e`，锁摘要 `c50a291b17168a06904e4f92d6d82cc9b93b390e3bd467ee42d49001d61f06e1`；177 个 payload 文件，许可缺失检查为零。此次未生成新的安装包，先前 Linux 安装产物不包含此轮改动。新增回归还覆盖启动清理不能确认时禁止继续新增 writer，以及归档会话的输入/授权门禁。独立工具包 SDK 的 8 项测试包含在上述数量中，但其安装生命周期、PI 和 UI 尚未接入，不能记为插件交付。

下表的本轮原生结果仅绑定重设计前的 `0434044`，不代表当前 UI 工作树已验证。

| 能力 / 验收项 | 盘点时实现 | 已有证据或明确缺口 | RC 必须补齐 |
| --- | --- | --- | --- |
| 核心、HTTP/IPC、桌面宿主 / A20 | 已有基础 | 契约/来源/身份、SQLite、HTTP、Node IPC 与桌面路由层测试；本轮 macOS 双架构/Ubuntu 22 基础 GUI 及严格长历史通过 | 新 UI 原生回归；全部新命令两端等价及安全边界；Windows/Ubuntu 24 真实窗口，不将有限场景当全部 preload/utility 验收 |
| 创建/重开/筛选/历史 / A02/A25 | 部分 | 幂等创建、分页目录、重命名/归档/恢复、忙碌拒绝、旧库迁移与目录投影恢复；真实 SQLite 回归及三个平台 GUI 创建/重开通过 | 筛选、归档等其余实际 UI；崩溃/断电/磁盘故障矩阵和跨平台迁移，不只靠模拟 failpoint |
| 真实模型与执行取消 / A01/A06/A19 | 部分 | 官方 OpenAI adapter、独立凭据端口、固定会话模型、运行中 abort、暂停取消持久意图且不启动 scheduler、入库前错误脱敏、显式恢复；定向测试通过 | 真实服务、取消竞争及恢复闭环验收；实际系统密钥链验证 |
| 工具活动与授权 / A03/A05 | 部分 | 三个文件工具、持久授权/逐次写审批、最终出站/写入检查、历史上下文重授权、unknown 只读核对；逐条审计消除累计配额，live 资源继续有界 | 工具时间线、长时授权/审批基准、真实图形审批与撤权竞争验收 |
| 回执、恢复、事件 / A04/A07/A08 | 已有基础 | 原请求去重、进程恢复、store 身份及有界传输定向测试 | 新能力故障注入；磁盘满/不可写、真实效果、取消竞争；读历史不恢复付费执行 |
| 流式消息与虚拟化 / A09/A23 | 部分 | 本轮 macOS 双架构/Ubuntu 22 严格长历史完整场景 passed：流式离底阅读、锚点、展开、隔离、只读重开及 202 条冷读 | 重设计 UI 下重跑；物理选区、IME、长期资源与硬件性能预算 |
| 文件树、编辑、Diff、成果 / A01/A10/A11 | 部分 | service、端口及 CodeMirror UI 已接，dirty/版本冲突/Diff 定向测试；本轮原生 fixture 在 renderer 前被拒绝，文件功能 not_run | 修复 fixture 后真实目录选择、编辑/冲突/Diff/IME 验证；成果独立验收，不将 editor-read 当作 Agent 全部成果 |
| 文档预览 / A12/A13 | 部分 | worker/service/端口和 DOCX/XLSX/CSV/PDF/图片受限预览源码与定向测试；本轮文件场景未到 renderer，实际预览 not_run | 实际渲染及保真矩阵，损坏/超限/恶意语料、取消与释放；不执行宏/脚本或自动上传，线程不是 OS 沙箱 |
| 主题/国际化/可访问性 / A14–A16 | 部分 | 本轮长历史截图已复核，CJK、原文、composer 与探针可见；Ubuntu 22 维护报告含主题/焦点/字体检查 | 全新 UI 的完整视觉、主题组合、目标语言、物理 IME、屏幕阅读器及缩放验收 |
| 受控扩展 / A17/A18 | 已接入，验收中 | 声明式 schema、固定版本绑定、PI 工具与 UI；本轮 Ubuntu 22 维护场景含管理/卸载历史冷读，仍明确 `managementOnly` | 新 UI 与真实工具执行/逐次审批/成果闭环、权限扩张和撤权竞争、隔离及长期资源；不支持任意 Node/UI 插件，不宣称 OS 沙箱 |
| 诊断与迁移 / A07/A19/A22 | 部分 | 本轮 Ubuntu 22 已完成真实 Electron 退出→独立 Node 24.22.0 离线维护→Electron 同 scope/回执重开；原文件和只读档案检查通过 | 原生维护入口、Windows/macOS 维护及三平台同步资格、断电/磁盘故障；恢复档案不是可执行工作库 |
| 三平台构建交付 / A21/A22 | 部分 | run 39352844552 两个 Mac 任务成功；Ubuntu 22 长历史/维护通过但文件场景失败；Windows 源码 2 项失败，Ubuntu 24 sandbox GUI 失败 | Windows 诊断/GUI、文件场景、新 UI 回归与 Ubuntu 24 安全前提；安装/更新/回退、签名/公证及最终产物审计 |
| 视觉与完整闭环 / A01/A24 | UI 重设计实施中 | 已有构建的部分截图/交互通过；当前整体重设计源码未获原生验证，旧截图不代表新 UI | 新 UI 正常/空/加载/失败/窄窗、焦点及无假按钮；真实工具任务从目标到成果验收 |

历史证据入口：[历史检查点](evidence/history/VERIFICATION.md)、[桌面检查点](evidence/desktop-host/VERIFICATION.md)、[动态布局证据](evidence/dynamic-message-layout-node-2026-10-19.md)。历史检查点记录 68 个 runtime/desktop、60 个 UI Node、10 个 Markdown SSR 定向测试通过；这些数量不是当前全量验证结论。动态布局记录包含裸库缺陷 characterization 和应用测量策略修复回归，不能混淆两者。

## 4. 当前执行顺序和依赖

1. **冻结重设计 UI 并关闭当前失败**：整合整体 UI 重设计、文件 fixture 路径和 Windows 诊断修复，统一检查后重新构建。保留可信状态和真实输入/命中测试要求，重跑基础 GUI、严格长历史、维护及文件场景；不以旧构建截图或旧通过结果证明新 UI。Windows 源码测试通过后继续定位真实启动异常；Ubuntu 24 不禁用 sandbox 或擅改全局安全设置。
2. **长期文档读取**：为持续更新的 PI 文档设置 checkpoint，避免只限制当前集合而遗漏历史 delta 回放增长；保留历史审计，验证当前值与历史版本。首次成功逐出后，本 runtime 后续冷打开均禁自动 resume，执行需显式继续。
3. **恢复与长期资源**：保留本轮 Ubuntu 22 真实维护/重开闭环，继续新构建、其余平台、三平台文件系统及故障负载。[小规模基准](benchmarks/capacity-full-2026-10-19.md)仅覆盖 10/1,000 个空历史会话；200 条确定性 GUI 历史也不证明长期内存、工具审计、并发或物理 SSD 性能。
4. **补齐真实交互缺口**：文件场景须先真正到达 renderer，再验收原生目录选择、编辑冲突、Diff/预览；继续实际工具执行与审批/成果闭环、完整截图、密钥链、物理 IME 和长期负载。不能把管理 UI、空工具活动列表、静态类型、SSR 或 Node-mode 验证当相应完整验收。
5. **交付门禁**：逐平台完成最终产物审计、真实安装、适用签名/公证、更新与回退、辅助技术和关键任务闭环。Ubuntu 24 所需安全前提单独审核，不擅改主机安全配置。真实服务只在有具体授权时使用，默认验收继续使用确定性 provider。

普通技术取舍由负责人直接决定并留下理由、限制与测试；不能因等待非必要产品确认而闲置可执行工作。涉及安全确认或确实缺少设备/凭据时，报告具体阻断，同时继续不依赖它的实现。

## 5. 不可省略的 RC 门禁

- [ ] A01–A03：真实目标到文件成果和人工验收；多任务不串状态；授权拒绝/过期/重复在可信端生效。
- [ ] A04–A08：原 requestId 核对；外部效果未知不重放；执行取消不伪称回滚；存储故障和单写 owner；两个 adapter 的断连/缺口/资源有界验证。
- [ ] A09：实际浏览器流式输入、选区、滚动、切任务和 IME。SSR/Node 无法关闭此项。
- [ ] A10–A13：dirty 冲突不丢输入；Diff 来源明确；支持格式合法/损坏/超限；恶意资源/路径不越权。受控写入与外部 writer 残余竞争分别说明，不宣称普通文件系统严格 CAS。
- [ ] A14–A16：完整主题往返/错误恢复、目标语言与格式、键盘及辅助技术可完成关键流程。
- [ ] A17–A18：真实扩展生命周期、权限扩张与撤权、崩溃/卡死隔离和资源回收；独立进程不是权限沙箱。
- [ ] A19–A20：凭据不进普通存储/日志/诊断；系统存储不可用不明文降级；全部新接口通过来源校验、边界检查及 IPC/HTTP 一致性验证。
- [ ] A21–A22：Windows/macOS/Linux 各自真实安装启动与关键闭环、适用签名/公证、更新/迁移失败和恢复证据。
- [ ] A23–A25：记录实际硬件/负载后确定性能预算；无假入口；归档/恢复保持身份、历史、成果和授权审计。

范围内 P0/P1 必须有当前构建的 passed 证据；failed、blocked、not_run 都不能宣称 RC 已验收。只允许不影响关键使用的 P2 带明确缺陷记录评估。构建成功、源码打包、测试数量、文档检查和演示均不替代以上门禁。完整场景与记录格式见 [ACCEPTANCE.md](ACCEPTANCE.md)。

## 6. 当前验收阻断

上述未完成验收仍阻断 RC。冻结检查点 `0434044` 的两个 Mac 任务、三个严格长历史场景及 Ubuntu 22 真实维护闭环已有通过证据，但它们均早于当前 UI 重设计。Windows 源码仍有 2 项诊断测试失败，GUI 未运行；Ubuntu 24 在 renderer 前因 SUID helper 配置失败；Ubuntu 22 文件 fixture 在 renderer 前被拒绝，所有文件功能仍 not_run。新 UI 和后续诊断/fixture 修复待新构建原生验证。工具包管理不等于工具执行/审批/成果闭环。旧 `--no-sandbox` AppImage 仍不合格，最终产物安全资格独立验收。三平台安装、签名/公证、更新回退、真实模型/密钥链、物理 IME/辅助技术、长期资源及故障矩阵仍缺证据；具体凭据/付费及 Release 发布授权边界不变。

PI Durable 为 Experimental；上游 watch/单条 entry 可能完整装载数据。传输分页不证明全过程内存严格有界；进程崩溃恢复不证明断电安全；请求去重不证明端到端 exactly-once。继续按实际证据描述这些边界。
