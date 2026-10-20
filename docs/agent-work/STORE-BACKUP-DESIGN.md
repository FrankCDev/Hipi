# 离线 Store 备份与安全恢复设计

2026-10-19。面向 Hipi Work 1.0 RC 的方案设计。后续已实现离线维护核心、CLI 与只读历史档案，正在统一验证；操作及实际限制见[维护说明](STORE-MAINTENANCE.md)。本设计中的原生界面、完整审计读取和平台资格等仍有未完成项，不能从设计反推已交付。遵循[工程原则](ENGINEERING-PRINCIPLES.md)、[开发规范](DEVELOPMENT-STANDARDS.md)及[RC 门禁](RC-TRACKER.md)。

## 1. 决定与最小交付

采用离线 CLI：取得原目录 owner 后制作一致备份；恢复只写全新目录；恢复结果是全局只读历史档案。原目录、原 owner 文件和原备份均保留原位。用户在独立的正常工作库新建空白会话继续工作，不把旧任务、批准或上下文自动带入新会话。

先交付四项：`backup`、`verify`、`restore`、只读 `inspect/export-history`。核心为不依赖 Electron 的维护服务，CLI 调用同一服务；宿主以后只能在 runtime 实际退出后调用维护端口。首版不做在线快照、原位替换、自动恢复执行、增量备份、压缩、加密容器、云上传、自动轮换或旧目录删除。

“恢复”表示找回可浏览/导出的持久工作记录，不表示撤销现实世界效果，也不表示从快照时刻重新执行。UI/CLI 必须明确这一边界。只读档案并不降低后续正常工作库的能力；不允许在档案内部新建会话，避免让整库执行器有机会扫描历史任务。

### 为什么不原位替换

具体错误轨迹：进程 A 持有 `old-root/store-owner.sqlite` 的锁；恢复程序把 root 改名，创建同路径的新 owner；进程 B 成功锁住新 inode。A 与 B 都认为自己独占同一路径。文件改名原子性不能解决 owner 身份分裂。

原位逐库替换虽然可以保住 owner，却需要跨库提交日志、WAL 清理顺序、断电回滚以及新旧身份混用防护。恢复到新目录不需要跨库回滚，原库就是回退材料。代价是需要额外空间、显式选择档案入口和重新授权新工作的文件根目录。RC 选择后者。

**禁止 rename/unlink/替换任何已创建的 root owner、workspace owner 或包含这些文件的目录；即使程序认为锁已过期也不允许。** 本方案连恢复目标目录也不改名：在最终路径创建，持锁写入，以 catalog 状态发布。

## 2. 当前代码事实与关键差异

- [StoreCatalog](../../packages/work-runtime/src/store-catalog.ts)：root owner 使用 `BEGIN EXCLUSIVE`，`busy_timeout=0`；`catalog.sqlite.identity` 含 version、store_id、canonical root。当前正常工作库为 schema 8；schema 3 引入的包历史披露权限单向安全屏障仍保留。打开时会升级、扫描并补登记工作区，因此不能拿 `StoreCatalog.open()` 当只读备份入口。
- [Node runtime](../../packages/work-runtime/src/node.ts)：root canonicalization；各工作区 `owner.sqlite` 的独占事务；关闭失败保留 owner。维护入口不能实例化 WorkRuntime/PiWorkspace，也不能用超时或 PID 文件判断可以接管。
- [Chord SQLite adapter](../../packages/chord/src/sqlite/node.ts)：通用 writer 默认仍是 WAL、`synchronous=NORMAL`；Hipi 的四个工作库打开路径已明确选择 FULL，关闭仍会尝试 checkpoint。该设置属于连接，不能只在首次建库配置。关过一次数据库不证明 WAL 已空，也不等于真实断电资格通过；旧版本 NORMAL 写入的持久性不能追溯改善。
- [Durable SQLite Storage](../../packages/durable/src/storage/sqlite/storage.ts)：`SqliteStorage.open()` 会运行迁移；构造器私有。当前 `openNodeSqliteStorage()` 没有只读选项，不得假设已有安全的只读入口。
- [PiWorkspace](../../packages/work-runtime/src/pi-workspace.ts)：即使 `resume:false`，open 仍会恢复工具包/broker、核对回执、写持久状态。`continueWorkspace()` 会调用 `#schedule()` 和 `harness.resume()`。不能把“不开自动 resume”等同于恢复隔离。
- [桌面启动](../../apps/hipi-work-desktop/src/main.ts)：当前工作目录为 userData 下的 mode-store；凭据位于独立 `credentials/providers.enc`，不是工作库的一部分。文件根授权来自 [file host](../../packages/work-runtime/src/files/host.ts) 与运行期 authority，并不是目录内的普通备份文件。
- [History](../../packages/work-runtime/src/history.ts) 当前依赖 PiConversation.entries；底层 [Storage.scanEntries](../../packages/durable/src/types.ts) 已提供 fork-aware 读取。只读档案可以复用这一读取语义，不必创建 Harness。

本地 Node 为 24.19.0。已读 `node_modules/@types/node/sqlite.d.ts`：`DatabaseSync({readOnly:true})` 可用；`backup(sourceDb,path,{rate,progress})` 返回 `Promise<void>`；无 AbortSignal；目标存在时会覆盖。因此仅向本操作独占的新目录内、新路径调用 backup，不能把任意用户路径直接交给该 API。

[Node SQLite API](https://nodejs.org/api/sqlite.html) 与 [SQLite Backup API](https://www.sqlite.org/backup.html) 支持连接级备份；这不是多库原子快照。多库一致性来自整个复制期间持续持有 root owner、所有合作写入者停止。以仓库所用 Node 类型和打包运行时实测为准，不依据最新网页新增 API。

## 3. 安全与故障模型

### 支持的范围

- 本机、同一 OS 用户、遵守 root owner 协议的 Hipi 进程；私有本地目录，已验证的本地文件系统。
- 对进程崩溃、SIGKILL、磁盘满、权限错误、部分输出、损坏备份采取 fail-closed。没有 COMPLETE/ready 证据不得报告可用。
- 文件内容视为不可信数据；不执行 SQL 脚本、扩展代码、工具包、模型调用或备份附带的路径/命令。
- 哈希防意外损坏，不提供来源认证。只支持用户自己的受信来源备份；不把任意攻击者提供的 SQLite 文件当安全沙箱输入。

### 不宣称的保证

- 恶意同用户进程可以绕过 SQLite owner、替换文件或修改 manifest；Node 的路径检查无法提供完整的 openat/reparse-point 原子防护。拒绝可发现的别名和链接，但不承诺抵抗此类攻击。
- NFS/SMB、网络挂载、云同步目录、锁语义未知的文件系统不在 RC 支持范围。不能只凭路径名称可靠识别所有挂载类型，入口说明与平台资格验证都必需。
- 旧版本 SQLite WAL + NORMAL 不保证断电前最后一个已返回提交仍在。当前 Hipi 明确请求 FULL，改善同步策略；备份仍只能保存成功读取到的持久快照，不能追溯性承诺旧提交或把配置等同于平台断电实测。
- `fsync`/目录刷盘及设备缓存行为有平台差异；进程崩溃测试不等于断电测试。[SQLite synchronous 说明](https://www.sqlite.org/pragma.html#pragma_synchronous)是语义依据，三平台真实文件系统证据仍是发布门禁。

## 4. 不变量

1. 源维护操作从读取 catalog 到关闭全部源连接始终持有原 root owner。无法取得锁立即 BUSY，不终止持锁者、不删锁。
2. 同一条维护路径绝不打开 Harness、provider、credential broker 或文件写工具。读档案也不组装它们。
3. 备份只包含经过 SQLite 连接读取的数据库快照，不直接复制活动数据库或拼接 WAL/SHM。
4. 只允许全新输出目录；不覆盖已有文件，不自动清理用户数据。失败只留下标明未完成的新产物。
5. 恢复首先建立 schema 4 的 preparing catalog，最后才提交 ready。源库、备份及目标 workspace 数据不会被“修复”成可执行状态。
6. 每次恢复产生随机新 storeId；原 storeId 仅作为来源信息。所有档案请求与游标绑定新身份，不复用旧 UI 连接。
7. 恢复库始终 `mode=recovery_archive`，默认拒绝一切普通 runtime 打开；不存在“继续此恢复工作区”开关。
8. PI 原始回执、任务、审批、grant、历史包源、文档修订和状态原样保留。未知外部效果保持未知；旧成功也只表示快照时记录，不保证外部现状。
9. 无 COMPLETE manifest 的备份、无 ready catalog 的档案、未知 schema/版本/字段均不自动接受。缺少数据不能当空库。
10. 源与输出不同树、不同实际目录；schema 3 的安全语义不能通过备份/恢复降回 schema 1/2。

## 5. 备份范围、格式与路径

### 包含和排除

包含 catalog 快照、全部发现的完整 workspace.sqlite（包括 ready=0 登记、目录中存在但 catalog 尚未 ready 的工作区）、版本/身份/大小/摘要清单。会话、审计、PI 执行事实和声明式工具包都在数据库内。

不包含 `store-owner.sqlite`、各 `owner.sqlite`、任何 WAL/SHM/journal 副本、credentials、环境变量、系统钥匙串、日志、缓存、Electron session、外部工程文件、工作台未保存草稿、运行期文件根授权。未知普通文件不得递归打包；记录受限的排除计数/类别。未知目录或不符合工作区 ID 的目录直接拒绝，不能默默漏备份。

“凭据存储不进入备份”不等于“备份无敏感信息”：用户可能曾在会话中粘贴秘密，PI 内容也可能含私有文件文本。备份是私有工作内容，不自动上传、不声称自动脱敏。导出前显示此说明；CLI 保持私有目录权限。Windows 用账户私有目录及其 ACL，不把 POSIX mode 当作 Windows ACL 保证。

### v1 目录格式

- `manifest.json`：最后发布的完成清单；存在且完整校验后才可称为备份。
- `catalog.sqlite`：源 catalog 的 SQLite 快照，保留原身份用于核验。
- `workspaces/<workspaceId>.sqlite`：独立单文件 SQLite 快照。
- `operation.json`：操作 ID/开始时间/格式；用于识别失败目录，不是恢复授权或完成标志。

清单包含 formatVersion=1、backupId、createdAt、源 catalog schema/PI schema、sourceStoreId、source canonical root（来自已验证 catalog）、生产程序版本/可用源码摘要、固定文件集合、每文件字节数与 SHA-256、workspaceId/名称/登记状态、未完成空 reservation 清单、explicit exclusions。root 属于私有元数据，不能上传遥测。恢复目标路径永不取自 manifest。清单中的源 catalog 摘要只验证备份内的 catalog；恢复 catalog 是新建的，不能拿该摘要比对新 catalog。档案重新打开时校验新 catalog 的严格结构、身份和 recovery_state，再用对应清单逐项验证未改写的 workspace payload。

当前备份源和备份核验支持 catalog schema 3、5、6、7、8 的普通工作库，以及 PI SQLite schema 2。正常工作库当前为 schema 8；支持的旧备份版本逐版核验，不在维护读取时迁移。schema 7、8 的权威置顶元数据和不可变回执必须完整有效；schema 8 搜索投影另行严格校验。明确拒绝 schema 4 档案再备份，避免将 preparing 状态或未经完整核验的档案重新发布为有效备份。其他版本同样拒绝；新增兼容性和档案再备份必须另有评审和测试，不能把档案“洗白”为工作库。

工作区清单取 catalog 与真实目录的并集。ready=1 但主数据库缺失、身份不符、重复 ID、读出损坏直接失败。ready=0 且不存在 PI 数据可保留为未完成 reservation 元数据，明确不显示为完整工作区；有完整 PI 数据则必须纳入并验证。不可读取的 PI 文件不能降格为空 reservation。

### 路径校验

对源、输出父目录和所有输入文件逐级 lstat；拒绝 symlink、Windows junction/reparse 别名（平台探针须覆盖）、非普通文件、数据库 nlink != 1、特殊设备、FIFO、socket。复用并加强 `checkDatabasePath()` 对数据库及 sidecar 的检查。源 root 必须已存在，维护不会创建空源目录。

用 canonical parent + 新 basename 构造目标；目标只用非递归 mkdir，EEXIST 即拒绝，即使现有目录为空。比较 canonical containment，拒绝源=目标、互为祖先、备份位于源内部、恢复目标位于备份内部等重叠。大小写不敏感盘及别名用实际 canonical 身份校验，不仅比较用户字符串。workspace ID 同时通过现有契约与跨平台安全名称规则：单段、无斜杠/反斜杠/冒号/驱动器/UNC/`..`、无尾随点空格、无保留设备名或大小写重复。

只读 SQLite 连接显式禁用 extension loading，使用受支持的 trusted_schema=OFF；先核验内置 schema 对象与版本，不执行备份提供的查询或迁移脚本。未知 trigger/view/virtual table 拒绝，完整性校验不充当恶意数据库沙箱。

不采用 archive 解包，避免 zip-slip 与解压炸弹；manifest 中仅接受由固定模板推导的路径，不接受自由相对路径。restore 逐文件复制并计算摘要，校验实际输出与清单相符；解析前/复制后校验文件身份、长度和完整集合，发现源变动拒绝。摘要一致仍不等于抗恶意同用户进程。

## 6. 备份状态机

`validate → acquire_owner → inventory → snapshot → verify → flush → publish_manifest → complete`

1. 校验路径、支持版本、资源预算及输出父目录。源 identity 必须存在；任何只读验证失败不创建正常空 store。
2. 提取现有 root owner 实现为内部 `StoreOwnerLease`，与 StoreCatalog 使用完全相同文件和锁协议。backup 取得源 lease；不调用 StoreCatalog.open。要求该版本所有合法 writer 均遵循 root owner；不宣称与绕过 root 的旧实验程序可并用。
3. 持锁打开 catalog 的 `DatabaseSync({readOnly:true})`；扫描和校验 catalog/目录并集。逐 workspace 检查 owner 路径及可取得性；发现意外持有者失败。root lease 是全组冻结依据，不能把多个短暂 workspace 锁误称为全组事务。
4. 创建独占备份目录及 operation 标识。逐库打开只读连接并调用 `backup()`，并发固定为 1，关闭连接。保留源 WAL，由 SQLite 读取其已提交内容。不开 `immutable=1`，不要求 checkpoint，不删除 sidecar。热 rollback journal 若需要写恢复而只读打开失败，则明确失败；不得悄悄换可写方式恢复源。
5. 输出库在本操作私有目录内统一成为可独立读取的单文件：必要时只对输出库 checkpoint/切换 DELETE journal mode；关闭后验证不依赖 WAL，若仍有未处理 sidecar 则失败。对输出运行 integrity_check、foreign_key_check、schema 与语义身份检查，再流式哈希。
6. 对所有输出库/元数据执行文件 sync，按平台支持刷目录；准备完整 manifest 临时文件、sync 后改名为 manifest.json，并刷父目录。这里只改名 manifest，不改名 store/root/owner。最终目录为本操作独占，因此不得存在可被覆盖的旧 manifest。
7. 关闭全部连接后才释放源 owner。成功结果包含 backupId、大小、工作区数和验证/持久化级别；不输出历史内容或私有路径到普通日志。

取消不是数据库操作“回滚”。Node backup 没有 AbortSignal：第一阶段 CLI 在库边界观察取消；当前库完成后停止，保持未完成目录。取得 lease 的维护进程本身拥有所有 SQLite 连接，不跨进程传递 lease 或假定父进程持锁能替子进程完成清理。宿主若需要硬超时，应启动独立维护进程，实际退出后才认为句柄关闭；不能 Promise.race 超时就释放 owner。progress 仅报告 SQLite 给出的页数与已完成文件数，不编造总耗时。

## 7. 恢复状态机：全新目录、最后发布

`verify_backup → allocate_target → lock_target → prepare_catalog → copy_workspaces → verify_target → sync_payload → commit_ready → complete`

1. 在独立只读路径验证备份清单、完整集合、schema、长度/摘要、SQLite 完整性和身份。未知文件/sidecar、缺文件、混入另一份 backup 的文件均失败。恢复不需要打开或锁原工作库；备份本身须静止且在可信私有目录。
2. exclusive mkdir 创建最终目标 root，取得该目录新建的 store-owner lease；如果竞争 runtime 已取得锁，停止。获得锁后再次检查 catalog 主文件、WAL/SHM/journal 及非本操作产物；即使竞争者已经退出、只留下零字节或无 identity 的 catalog，也停止且保留，不覆盖或调用 StoreCatalog.open 修复。程序不对外公布可打开目标直到 complete。
3. **先创建新 catalog，不先把源 catalog 复制为目标 catalog。** 用单个 FULL synchronous 事务写 identity(version=4, store_id=新UUID, root=目标canonical路径)，以及严格单行 `recovery_state`：mode=recovery_archive、state=preparing、restoreId、backupId、sourceStoreId、manifestDigest。重建所需 catalog 表和 workspace 注册元数据；不复制 conversations/checkpoints 投影，后续按只读 PI 数据构建非权威索引。
4. 创建工作区目录，复制已校验的 workspace 快照到新路径，流式校验实际写出摘要。可创建新的空 workspace owner 文件供格式一致性检查；不复制旧 owner。PI 文件字节保持不变；不修改 pending task、approval、grant、sessionId 或 workspace generation。所有输出目录与文件只属于这次操作。
5. 重新只读打开全部目标 PI 库，验证身份/schema/完整性并构建完整的只读目录索引。索引来自 PI，不能把源 catalog 的陈旧投影当事实。缺失记录和失败需要报告，不产生部分成功档案。关闭连接、sync 文件以及相关目录。
6. 用 catalog 单事务把 recovery_state 从 preparing 改为 ready，校验 restoreId/摘要条件，提交并关闭；sync catalog 与目录。完成后仍保持 schema4 + recovery_archive。发布期间持有目标 owner；只读 reader 也先取得同一 owner，避免读取 preparing。备份 manifest 的受限内容在目标中另存为固定名 `recovery-manifest.json` 并在 ready 前刷盘；其摘要绑定 recovery_state，档案验收不依赖原备份永远留在原路径。该文件只用于档案 payload 核验，不给目标任何执行能力。
7. 返回新 storeId 与档案路径。不得自动切换桌面正常工作库、启动 provider 或导入凭据。原工作库可以继续原位置工作；新历史视图与其使用独立连接身份。

失败目标不得在原路径“重试覆盖”；最小实现选择新目录重新 restore，保留失败目录用于诊断。没有递归删除命令、没有自动回收原库/旧备份。以后若增加清理功能，须独立确认并验证仅删除用户选定产物；本设计不授权删除。

### 崩溃和断电后的判断

- 备份无 manifest、manifest 截断或任一摘要不符：未完成，不可恢复；源不变。
- 恢复在 catalog 建立前中断：目标可能仅含空 owner；不能据此当作已恢复。CLI `inspect` 显示未完成，用户重新选择新目标。
- preparing + 部分库：不可打开；老程序见 schema4 拒绝，新程序见 preparing 拒绝。
- ready 提交前中断：源/备份完整保留，重做目标即可。
- ready 已提交但 CLI 回包丢失：离线 inspect 验证 restoreId、manifestDigest、全部目标库摘要；确认后报告已完成，不能再次覆盖。
- 断电后 ready 丢失、payload 丢失/损坏或目录刷盘语义不成立：启动时复验失败并拒绝。只读档案可每次打开验证全组摘要，第一版接受这一 I/O 成本，不引入可信缓存捷径。

此方案保证不破坏原数据；不能在尚未验证的平台声称刚生成的新备份一定经受任意断电。输出可区分 `verified` 与平台已资格验证的 `durably_flushed`，后者没有证据就不能显示。保留至少原数据与新备份两份也不等于异机灾备。

## 8. 恢复隔离、schema4 与新身份

### 旧 protocol 5 的实际绕过路径

如果恢复仅修改 root/storeId 而保留 schema3，当前旧程序会接受 catalog；用户或 host 可以重新 handshake 获得新 storeId。随后 `openWorkspace` → `PiWorkspace.open` 恢复 broker/回执；显式 `continueWorkspace` → `#schedule` → `harness.resume`。`resume:false` 只挡自动启动，无法挡这条显式执行链。快照后的消息发送/文件写入可能已经在现实世界完成，备份却仍是 pending/authorized；此时可能重复执行。

因此 schema4 是**磁盘安全屏障**，不是另一个 UI 协议编号。上述旧 StoreCatalog 只接受 1/2/3，在读 PI 前以 STORE_MISMATCH 拒绝 4；当前 schema 8 runtime 同样拒绝 schema 4。新 runtime 必须先读 identity/recovery_state，再做任何迁移/恢复；对于 mode=recovery_archive 或 preparing，普通 openRuntime 一律拒绝。不得把 4 迁回 3 或迁为 8 等可执行格式；不得以版本兼容把 unknown mode 当普通工作库。schema3 的包历史披露安全要求全部保留。恢复不是可执行回滚，也不把源库的项目文件夹授权、置顶状态/回执或搜索投影复制进档案 catalog。

### 最小只读档案实现

新增 `openRecoveryArchive()`，只创建原始只读 SQLite 连接、只读 Storage 和分页读取端口，不创建 WorkRuntime/PiWorkspace/Harness/Models。读取者也持有 archive root owner，首版只允许一个 reader，降低生命周期复杂性。

给 Durable SQLite 增加显式无迁移只读打开入口：验证当前 schema 和 metadata；底层连接 readOnly；commit/allocate/write 路径主动拒绝；close 只关闭、不 checkpoint；不调用现有迁移器。只读 adapter 的 transaction 必须采用 deferred `BEGIN`，不能沿用 writer 的 `BEGIN IMMEDIATE`；document 读取本身使用事务，后者会请求写锁并使只读连接失败。保持既有串行队列、rollback 和 close 排序，writer 行为不变。仍复用现有 document delta 还原与 fork-aware scanEntries，避免自行实现第二套 PI 状态机。不能直接给现有 openNodeSqliteStorage 强塞不存在的 readOnly 参数。

公开窄接口只含 archive identity、workspace/conversation 分页、历史分页/文本读取、审计读取和本地导出。把 history 的依赖缩小为只读 entries 函数，通过 Storage.scanEntries 实现；不冒充完整 PiConversation。审计展示原始快照时状态，并加“历史档案，不反映当前外部结果”的统一说明；不把 approved 显示成当前可执行批准。

普通 execute/submit/continue/approve/revoke/install/authorize、文件端口、preview 路径授权及模型端口均不存在，unknown method 拒绝；导出只写用户选择的新文件，历史不是可执行脚本。新工作在独立 active root 新建空白会话，需要新的授权和请求 ID；不自动添加历史文本、工具绑定、文件路径或模型上下文。用户主动复制文字属于另一次有意输入。

每次 restore 的 storeId 都不同；所有 archive 请求有 expectedStoreId，游标编码新 storeId。现有普通协议的 expectedStoreId 校验继续生效，桌面切换档案时同时换 transport generation、撤销 preview/file handles、清空连接缓存。不能仅依赖 durable conversationId 或相同 workspaceId 区分两次恢复。保留旧 PI generation 是为了不改审计证据，不可拿它代替新档案身份。

## 9. 资源、错误和宿主端口

首版保守资源策略：数据库串行处理；文件流固定 1 MiB buffer；manifest 上限 8 MiB；最多 10,000 个 workspace 文件；总输出上限 64 GiB；所有累计值用安全整数/BigInt 检查。上述为初始拒绝阈值，不是性能或最低硬件承诺，最终须以测试调整；超限明确拒绝，不截断备份。允许未来 CLI 显式调整预算，但始终有上限。

空间预检用 statfs 和源 page_count/page_size 估计；预留至少输出估计 + 单库规范化临时空间 + 10%/64 MiB 中较大余量。此估计不是磁盘预留，ENOSPC 仍逐步处理；稀疏文件、配额、其他进程写入、sqlite 临时空间可能使预检不足。运行中按实际字节预算检查，不能先读整个 DB 到内存。

对完整性检查/大 SQL/哈希设可观察阶段和明确超时。同步 SQLite 调用不能假装被 AbortSignal 中断，运行在 CLI/维护子进程；超时终止后以实际退出为句柄释放证据。只读记录 API 必须在 JSON materialize 前检查单条 TEXT/BLOB 大小；超限返回专门错误，不跳过记录。现有 PI 单 entry materialize 的内存限制仍要单独测，不因磁盘流式复制就宣称历史读取严格有界。

错误至少区分：BUSY、INVALID_PATH、TARGET_EXISTS、UNSUPPORTED_SCHEMA、INCOMPLETE_BACKUP、INTEGRITY_FAILED、IDENTITY_MISMATCH、SOURCE_CHANGED、CAPACITY_EXCEEDED、NO_SPACE、PERMISSION_DENIED、CANCELLED、DURABILITY_UNVERIFIED、RECOVERY_ARCHIVE_READ_ONLY。错误包含 operationId 和阶段，不在普通日志泄漏绝对路径/SQL内容/凭据。发生 sync 错误不得成功退出。

建议命令形态（拟议，当前未实现）：

```text
hipi-store backup --source <existing-store> --destination <new-backup-dir>
hipi-store verify --backup <backup-dir>
hipi-store restore --backup <backup-dir> --destination <new-archive-dir>
hipi-store inspect --archive <archive-dir>
hipi-store export-history --archive <archive-dir> --workspace <id> --conversation <id> --output <new-file>
```

维护端口是主进程可信能力，不加入 renderer 的任意路径 AppClient 方法。UI 先取得宿主文件选择句柄；host 校验来源与一次性选择 token，再调用维护服务。backup 必须先停止接收新命令、停止文件/preview 工作、关闭 runtime 并确认 utility 真实退出；`shutdownFailed` 或超时仍算忙。不得依赖 supervisor 已发 stop、窗口关闭或 IPC 断开。CLI 若和运行中的桌面竞争，仅返回 BUSY。

## 10. 实际代码插点与实施顺序

1. `packages/work-runtime/src/store-owner.ts`（新增）：从 StoreCatalog 抽出 lease，保持原文件名、独占事务和失败生命周期；StoreCatalog/node 共用，不增加第二种锁。新增 maintenance 类型/错误，不污染浏览器 exports。
2. `packages/work-runtime/src/store-maintenance.ts`（新增）：schema/清单/path 校验、snapshot/verify/restore 状态机；独立 CLI `store-cli.ts`。package.json 增加明确 Node-only export 与脚本，打包 Node/Electron SQLite 各自 smoke。
3. `packages/durable/src/storage/sqlite/storage.ts`、`node.ts` 及 Chord Node adapter：添加真正无迁移 read-only 入口与只关闭连接的生命周期；用现有公共出口，不深层导入私有实现。先测试只读文件字节不变和不能 commit。
4. StoreCatalog/node：在现有 migration/#recover 前识别 schema4/mode 并拒绝普通执行；存量 schema3 正常库不因备份被改版本。restore 自己创建 schema4 catalog，初始 preparing 与最后 ready 都事务化。
5. `packages/work-runtime/src/recovery-archive.ts`（新增）和 history：窄读取端口复用 PI 文档/历史语义，绑定新 storeId，导出流式文件。先 CLI 验证，再加独立宿主 archive port，不先把档案塞进完整 AppClient。
6. desktop `main.ts`、supervisor、runtime-entry 与 transport：维护工作进程/退出确认；只读档案单独入口与连接代际。正常工作库不自动切换，凭据服务完全不传入档案进程。
7. 完成故障与三平台证据后再在 RC tracker 标记对应项。备份“可写出”不等于恢复“可打开”，两者必须闭环。

必须分清已经存在的函数和拟新增接口；本节所有新增路径/接口均为设计。无需引入第三方备份库或压缩依赖。若打包 Electron 未提供所需 backup API，先报告确切探针结果；不可悄悄退回 copyFile 活动数据库。

## 11. 验收矩阵与失败注入

| 风险 | 必测行为与证据 |
| --- | --- |
| owner | 真双进程：runtime 持锁时 backup BUSY；backup 持锁时 runtime BUSY；杀死持锁者后可重开；shutdownFailed 仍拒绝；owner inode/path 从未替换 |
| WAL | 建立未 checkpoint 的已提交 WAL 后杀进程；备份包含提交数据、不含未提交事务；只复制主库的对照必须能暴露缺失；备份无需源 checkpoint |
| 多库一致 | catalog reserve/PI commit/ready 间的每个 crash 点；完整 PI 不漏、空 reservation 标明、不完整数据拒绝；两个 workspace 不跨冻结时点混合 |
| 源不变 | catalog/PI 主库和 WAL 前后记录校验；不跑 migration/recover/provider；SQLite 允许的 SHM/owner 元数据变化与业务字节变化分开记录 |
| 容器校验 | 缺 manifest、截断、未知字段、重复 ID、文件互换、大小/hash 不符、未知 schema、坏页、热 journal、额外 sidecar；全部拒绝且不改原数据 |
| 路径 | symlink/hardlink/junction、相对逃逸、UNC/设备名、大小写别名、Unicode、深路径、源目标重叠、目标已存在；不越界写 |
| 恢复原子可用性 | 每个状态之间 SIGKILL；preparing 永不打开；ready 丢回包可 inspect 核对；payload 丢失即使 ready 也拒绝 |
| 磁盘/权限 | mkdir、backup、复制、hash、manifest、每次 sync、ready commit 前后 ENOSPC/EACCES/EIO；所有句柄释放、原库/备份保留、无虚假成功 |
| 安全降级 | 旧 schema3-only runtime 打开恢复 schema4 必须在读 PI 前拒绝；新 runtime 也拒绝 archive；未知 mode/缺 recovery_state 不当普通库 |
| 外部效果 | 确定性 fake effect 计数：快照 pending，真实效果随后发生，restore/浏览/导出/反复重启计数不增加；submit/continue/approve/安装均被可信端拒绝 |
| 历史正确性 | fork/reset/compaction、归档会话、长文本、审计与包源；档案展示与快照公共 Storage 读取相同，不丢分支、不创建新回执 |
| 身份隔离 | 同一备份恢复两次得不同 storeId；旧 UI request/cursor/file/preview token 拒绝；同 conversationId 不串库 |
| 凭据 | fixture 凭据独立文件不在清单/产物；维护进程无 credential RPC；历史中人为粘贴的秘密不被误称已脱敏 |
| 有界性 | workspace/manifest/总字节阈值及阈值+1；大单库、大 entry、慢盘、取消、检查超时；内存/FD/退出行为有实测 |
| 平台 | macOS APFS、Windows NTFS、Linux ext4 等明确目标文件系统各自实跑 SQLite backup、锁、rename manifest、sync、权限、杀进程、长路径；未知 FS 不套用结果 |
| 断电 | 独立 VM/故障盘断电恢复验证数据/元数据持久性；没有真实故障证据则保留未验证声明，不能用 SIGKILL 替代 |

测试使用现有确定性 provider 或无 provider，不访问真实付费模型。代码阶段按根 AGENTS 运行新增定向测试与完整 check；文档不替代行为测试。

## 12. 本次交付验证与仍阻断事项

设计阶段已核对源码、当前 Node API 类型、owner 生命周期、实际恢复执行入口和 PI 只读读取可复用点。随后实施加入了只读 SQLite、backup/verify/restore、档案目录与历史读取、NDJSON 导出及 CLI；具体代码和最终验证以维护说明及 RC 跟踪为准。当前工作树没有可用 Git 元数据，`git diff --check` 无法执行为有效差异检查，不声称通过。

后续独立 [SQLite backup API 探针](evidence/sqlite-backup-api-2026-10-19.json)在当前 Linux x64 的 Node 24.19.0 与 Electron 42.11.15 Node-mode 中通过：只读源连接可备份未 checkpoint 的已提交 WAL，备份期间源主库与 WAL 字节不变，目标完整性检查通过。仅使用临时 fixture；不是产品实现、多库一致性、GUI、进程崩溃或断电证明。

schema4 隔离与只读 Storage/archive 已有实现和定向测试，完整审计读取与原生宿主入口尚未实现；尚未验证真实断电行为或三平台文件系统资格。矩阵中的各项证据仍须逐项记录，CLI 的临时数据测试不能关闭全部 RC 备份恢复门禁。
