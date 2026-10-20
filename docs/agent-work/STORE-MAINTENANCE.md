# 离线备份与历史档案

2026-10-19。当前为独立 Node CLI 和服务实现，Linux 临时 SQLite 的定向测试已运行，最新整仓验证以 [RC 跟踪](RC-TRACKER.md)为准。尚无桌面备份按钮，也没有 Windows/macOS、真实断电或安装版维护入口验收。

## 先理解恢复方式

备份保存工作库里的会话、工具包和执行事实；恢复写入一个全新目录，成为只读历史档案。它不会把旧任务重新执行，不会把快照中的 approved 当作现在有效的写入批准，也不会回滚现实世界中已经完成的文件修改。

原工作库及备份均保留。后续新工作使用独立的正常工作库；不能把档案目录交给正常客户端继续执行。档案使用独立 storeId 和 schema 4，普通 runtime 会拒绝打开。原工作库仍为 schema 3。

当前档案入口提供工作区、会话、消息分页、原文导出，以及只读工具活动和效果证据。备份里的其他审计数据保留原样，但尚未提供完整审计浏览界面。不能将这一阶段描述成所有操作记录均已有可视化查看入口。

## 找到正确目录

- 桌面客户端：Electron 实际 userData 下的 `production-store`；确定性模式是独立的 `deterministic-store`。userData 的基目录由平台和启动方式决定，不要凭固定示例猜测。
- HTTP 开发后端：使用启动命令中 `--data` 指定的目录。
- 目标必须是包含 `catalog.sqlite`、`store-owner.sqlite` 和工作区子目录的工作库本身，不是整个应用设置目录或外部工程目录。

先退出客户端和后端，确认进程已真正结束。若命令返回 BUSY，不删除 owner 文件、不杀未知进程、不用复制主数据库代替；先处理仍持有工作库的进程。关闭窗口、IPC 断开或超时不等于已安全关闭数据库。

本 CLI 首版只接受 schema 3 工作库。它不是旧 schema 1/2 首次升级前的自动备份器；旧版本升级前仍需停机完整保留原数据集合。不能仅拷贝 SQLite 主文件而遗漏未 checkpoint 的 WAL。

## 命令

Linux x64 打包候选提供独立 `hipi-work-maintenance` 入口和固定官方 Node，不依赖系统 Node 或 npm。关闭 GUI 后，从独立终端运行该入口；不要用 GUI 的 `ELECTRON_RUN_AS_NODE` 方式。命令参数和只读档案语义不变，详见 [Linux 维护运行时](LINUX-MAINTENANCE-RUNTIME.md)。这不是 Debian 安装包或 Ubuntu 24.04 GUI 验收通过声明。下面仍是仓库开发环境的调用方式。

从 Hipi 仓库根目录运行，需要 Node 24.19.0 或以上及已安装的仓库依赖。维护服务不加载模型目录、构造 Harness 或读取 API key。

```sh
node --conditions=source packages/work-runtime/src/store-cli.ts --help

# 替换为确认过的实际工作库目录。
STORE='/absolute/path/to/production-store'
mkdir -p "$HOME/Hipi Backups"

# destination 必须尚不存在，不能指向工作库内部。
node --conditions=source packages/work-runtime/src/store-cli.ts backup \
  --source "$STORE" --destination "$HOME/Hipi Backups/backup-20261019"

node --conditions=source packages/work-runtime/src/store-cli.ts verify \
  --backup "$HOME/Hipi Backups/backup-20261019"

# 恢复到另一个全新目录，不覆盖原工作库。
node --conditions=source packages/work-runtime/src/store-cli.ts restore \
  --backup "$HOME/Hipi Backups/backup-20261019" \
  --destination "$HOME/Hipi Backups/archive-20261019"

node --conditions=source packages/work-runtime/src/store-cli.ts inspect \
  --archive "$HOME/Hipi Backups/archive-20261019"

node --conditions=source packages/work-runtime/src/store-cli.ts workspaces \
  --archive "$HOME/Hipi Backups/archive-20261019"

node --conditions=source packages/work-runtime/src/store-cli.ts conversations \
  --archive "$HOME/Hipi Backups/archive-20261019" --workspace WORKSPACE_ID

node --conditions=source packages/work-runtime/src/store-cli.ts history \
  --archive "$HOME/Hipi Backups/archive-20261019" \
  --workspace WORKSPACE_ID --conversation CONVERSATION_ID

node --conditions=source packages/work-runtime/src/store-cli.ts activities \
  --archive "$HOME/Hipi Backups/archive-20261019" \
  --workspace WORKSPACE_ID --conversation CONVERSATION_ID

node --conditions=source packages/work-runtime/src/store-cli.ts export-history \
  --archive "$HOME/Hipi Backups/archive-20261019" \
  --workspace WORKSPACE_ID --conversation CONVERSATION_ID \
  --output "$HOME/Hipi Backups/conversation.ndjson"
```

也可使用 `npm run store --workspace=@hipi/work-runtime -- <command> ...`。npm workspace 的工作目录可能影响相对路径，建议传绝对路径。CLI 不会为遗漏参数猜测默认工作库。

成功返回一行 JSON，`ok: true`；操作失败退出码 1，参数错误退出码 2。普通错误不输出内部 SQL、路径或堆栈。`inspect` 的身份和快照时间是档案事实，不表示当前外部世界的状态。

分页结果的 `nextCursor` 非 null 时，将原值原样作为同一命令的 `--cursor`；游标不能跨恢复档案、工作区或会话复用。消息预览若截断，使用 `text` 命令的 `--message` 和 `--offset` 继续读取；偏移是 UTF-16 单位，不按中文字节计算。参数与详细形式见 `--help`。

工具活动接口标记 `readOnly`、`snapshotAt` 和 `evidence: snapshot_only`，其中 pending、approved、unknown 均为快照记录，不会重核或执行；授权是否已过期的计算时间另外标注，不冒充备份时状态。活动按任务/保留结果两段分页，空页可能仍有后续游标。使用 `activity-text --activity ID` 读取已保留输出，不会调用工具。

导出是按全局时间线顺序写入的 NDJSON，包含快照警告、消息与完整文本分块，以及成功完成标记。实现依据是持久条目与条目内模型消息的升序，header 明确 `order: chronological`；不是按机器墙钟重新排序。它不是可执行脚本。已有输出文件不会覆盖；异常中断可能留下不完整的新文件，不能把“文件已存在”当作导出成功。只在命令成功并有完成标记时使用完整导出。

## 一致性、隐私和失败处理

- 备份持有与正常 runtime 相同的 root owner，逐库通过 SQLite backup 读取已提交 WAL；不会复制 owner 或手工拼接 WAL。
- manifest 最后发布；缺 manifest、摘要不符、缺库、未知字段或不支持的 schema 均拒绝。恢复先建立 preparing 安全屏障，验证全部数据后才成为 ready。
- 输出只在全新路径创建。失败目录保留，重新执行应选新的输出目录；没有自动覆盖、自动轮换或删除旧备份。
- 不包含独立凭据库、系统钥匙串、外部工程文件、未保存编辑器草稿或运行期文件根授权。
- 会话可能包含用户粘贴的秘密或私有文件内容，因此备份不是自动脱敏文件。请保护备份和导出，不公开分享；工具不会自动上传。
- 本方案只针对受信来源、同用户合作进程、本地私有目录。不支持网络文件系统资格，不提供抵抗恶意同用户进程或任意 SQLite 文件的沙箱。
- SQLite backup 没有强制中断 API；取消会等待当前库复制真正结束后再释放 owner。等待取消不代表副作用回滚。

文件同步失败不能报告成功；当前平台无法完成所需目录同步时会失败关闭。Windows/macOS 的文件同步、锁和路径语义尚未资格验证，不因 TypeScript 跨平台就声称维护功能已经在三平台可用。`verified_and_flushed_platform_unqualified` 仅表示当前运行完成验证和同步调用，不代表真实断电持久性通过。

## 资源限制与验收

当前清单最多 8 MiB、10,000 个工作区，总文件预算 64 GiB；这些是拒绝阈值，不是实测吞吐或支持任意大单条消息的承诺。只读存储还对单条 JSON、文档重建链和分支深度实施独立上限；超限明确拒绝，不静默跳过会话。目录/文档完整核验会扫描数据，首次打开大档案可能耗时。

实现依据和故障矩阵见 [设计](STORE-BACKUP-DESIGN.md)。本轮定向 CLI 测试使用临时真实 SQLite 和确定性 provider，覆盖创建备份、核验、恢复、查看及导出；没有操作用户数据或真实模型。底层、跨进程竞争、损坏和效果隔离的最终结果由根任务统一记录，不能用这份操作文档替代 RC 验收。
