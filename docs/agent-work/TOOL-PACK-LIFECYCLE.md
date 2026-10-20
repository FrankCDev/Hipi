# 受控工具包生命周期

2026-10-19。本文描述当前源码行为及定向验证边界，不是整仓检查、GUI 或桌面发布验收结论。格式和纯转换语义见[工具包编写指南](TOOL-PACK-AUTHORING.md)，发布状态以 [RC 跟踪](RC-TRACKER.md)为准。

## 1. 从导入到会话绑定

管理界面支持导入 UTF-8 JSON 文件或粘贴文本，预览名称、版本、说明和完整 SHA-256，再安装到当前工作区。文件导入拒绝无效 UTF-8，预览和安装都拒绝 BOM、孤立代理码元、超限内容及不符合 v1 格式的字段。安装初始状态为 disabled；enable 只使该版本可供选择，不把工具自动加入任何会话。

绑定前，界面读取完整已安装源文，展示工作区、会话、完整摘要、固定 provider/model 和有效期，并要求明确确认。当前 UI 提供 15 分钟或 1 小时；运行时接受未来且不超过 24 小时的有效期。新绑定要求会话处于可授权的空闲状态，归档会话不能绑定。绑定只属于指定会话与模型，不继承到分支，不自动更新或切换版本。

包名称、说明与步骤 literal 都可能包含私密文字。SHA-256 只验证内容身份，包 ID、名称及“官方”示例不构成发布者身份验证。当前显示本地导入、发布者未验证；没有签名信任链、市场审核或包自称 public 后免授权的路径。

## 2. 安装身份与固定版本

安装 API 接受 packageText；摘要是该原字符串实际 UTF-8 编码后的全部安装字节的 SHA-256，包括空白。它不是 parse 后重新序列化的摘要，也不声称代表任意原文件编码的字节。完整原文与完整摘要持久保留；getToolPackSource 可按摘要精确读取，包括已卸载版本。

同一工作区内，packageId 与 version 已对应某摘要后，不能用不同字节覆盖。需要改变内容时应发布新版本。模型工具名为 `pack_<摘要前32位>_<localId>`，但授权和存储以完整 64 位摘要为权威；运行时拒绝摘要前缀和工具名冲突。PI 扩展名同时包含完整摘要及解释器协议版本。

每个 AgentDoc 显式选择核心 hipi.files 与已绑定的不可变版本。缺包、摘要或解释器版本不匹配、核心或工具包 registry 身份丢失都会阻断最终发送和工具效果，不能依赖 PI 静默省略未知扩展。未决任务和恢复过程不会把旧工具名指向新版实现。

## 3. 披露与历史授权

install、enable、bind 及提交准入检查本身都不登记“已经外传”。最终模型 dispatch 在同一会话 broker 锁内，核对实际组装的工具描述及 schema 快照，然后先提交披露依赖，再调用网络发送。`disclosed` 表示可能已向模型披露的保守事实，不表示远端确认收到，也不表示整个源文件已发送。网络随后失败仍保留依赖。

v1 不插入自由 prompt section。包名称和说明通过受控工具描述进入模型上下文；步骤 literal 还可能通过转换结果进入历史。工具描述即使没有被调用，也属于需要授权的包内容。旧描述、结果或其摘要仍可能在历史中，因此压缩历史不能自动清除依赖。

例如，绑定后从未 dispatch 就撤销：没有历史披露依赖时，新组装的纯核心请求可以继续，但撤销前捕获的旧工具 payload 仍被拒绝。已经 dispatch 后撤销：下一次发送须有同一摘要、同一固定模型的有效 live-package 或 retained-package 授权。

retained-package 通过明确选择已披露的原 live binding 创建，保存 sourceBindingId，拥有独立有效期且可以撤销。它只允许保留历史内容再次发送，不重新提供工具，不自动启用或重装包。管理界面的有效授权与历史列表都标明 purpose，不能把 retained 授权计算为可调用工具包。文件内容还必须满足[文件工具授权](TOOL-AUTHORIZATION.md)，包授权不代替文件许可。

## 4. 撤销、过期、停用与恢复

- revoke 撤销指定 binding；expiry 在最终效果检查时生效，不能依赖 UI 倒计时或定时器及时执行。
- workspace disable/uninstall 使该版本所有受影响会话的 live binding 失效。重新 enable 不恢复旧 binding。
- 全工作区停用按固定顺序获取所有受影响会话的 broker 锁，在授权状态和待决审批失效提交后中断旧任务。最终 fetch 与文件写入 gate 使用同一锁，不能从检查与撤权之间穿过。
- 取消尾部只停止撤权线性化点捕获的任务与排队提交，不误伤之后明确提交的新任务。
- revoke、disable、uninstall 不删除已安装原文、披露依赖、审计、未决请求或 unknown 文件效果；uninstall 不是历史擦除。已有 retained 授权有自己的生命周期，需要单独撤销。
- 重启恢复使旧授权失效，保留固定身份和恢复所需数据，不自动 resume 或调度。归档使授权失效，恢复会话也不恢复授权。

精确只读查询、取消和撤销不经过要求有效工具包的上下文 guard。包缺失或授权过期时，用户仍可查看事实、核对未知结果及撤权。已发生的外部发送不能被撤销收回。

## 5. 真实工具与能力边界

工具只通过现有 broker.read 读取已授权 UTF-8 文件，要求完整文件不超过 8,192 字节；nextOffset 非 null 就拒绝，不能把分页首段当成完整文件。纯转换后返回文本与原 revision，前后再次检查授权。保存仍走核心 hipi_files_save 的每次提案审批、revision 比较与最终写入 gate。

单包最多 8 个工具，每工具最多 16 个内建纯文本步骤，输入及每个中间结果最多 8 KiB，超限拒绝且不截断。解释器不执行第三方 JavaScript、Wasm、正则、表达式或 npm 依赖，不提供进程、网络、环境变量或凭据访问。包无自由文本配置层。此边界不是 OS 沙箱，也不承诺任意第三方插件安全。

同步纯转换检查取消信号，但不声称事件循环期间硬实时抢占。恢复、文件系统和网络效果也不因此获得端到端 exactly-once 保证；unknown 效果必须保留并核对。

## 6. 配额、持久化与只读核对

PI 是生命周期事实的唯一权威，按 Pack、Binding、Command 文档及每页 64 ID 的审计页保存。小型 live 集合与终身历史分离，没有第二套 SQL 执行状态机。

- 每工作区最多 32 个 enabled 版本，内存 registry 的包版本也最多 32 个。disabled 与 uninstalled 不占此配额；安装为 disabled 不受该 32 项限制，没有新增终身安装次数配额。
- 每会话最多 4 个 active live-package，即最多 32 个包工具。
- 每会话所有 active binding（含 retained）合计最多 32；历史记录不占该 active 配额。
- 工作区最多 256 个存在有效包授权的会话引用，每会话最多 256 个持久披露摘要依赖。达到安全边界时拒绝新增，不删除旧依赖来腾名额。
- 安装文本最多 64 KiB；列表、源文读取和传输继续接受各自响应预算校验。

listActiveToolPackBindings 直接读取有界有效集合；历史单独按 cursor 分页。preview、列表、source 与 getToolPackCommandResult 使用只读存储路径，不打开 Harness，也不 resume 旧任务。

冷恢复只解析最多 32 个 enabled 原文，安装身份冲突按 packageId/version 的摘要键点查，不扫描 disabled 历史。包列表每页最多 32 项、最多读取两个 64-ID 审计页。Pack 文档同时保存摘要与原文，因此列表虽不重新解析包格式，仍会物化当前页最多 32×64 KiB 的原文，加上 JSON、UTF-16 和存储层开销；这不是全链路绝对内存上界或已测得的 RSS 保证。

生命周期文档每 32 次变更写入一个新的 PI base，使按当前版本写入的文档冷读取最多回放 31 个 delta。PI session 文档本来只支持 current 读取；checkpoint 替换其内部重建链，保留当前业务事实、独立历史审计条目和完整安装源文，不承诺保留不可历史查询的内部 revision。已有超长旧链在首次再次修改并 checkpoint 前仍可能需要完整物化；只读查询不会偷偷改写它。

命令保存原 method、scope、requestId 和规范 payload 摘要。精确查询必须匹配这些字段，返回当前权威对象状态；原成功安装结果不代表包现在仍 enabled。相同 requestId 的不同意图冲突，同一请求重试不重复执行副作用。

UI 遇到未知响应先精确只读核对，不生成新请求覆盖原意图。安装恢复只持久保存必要元数据和摘要，不保存原文草稿；重试时重新导入同摘要原文并复用 requestId。未找到记录不等于证明任何未完成操作从未发生，仍需按界面的原请求流程核对。

## 7. 单向存储屏障

当前 transport protocol 为 5，工具包 formatVersion 为 1，两者含义不同。root catalog schema 3 在 runtime 可用前持久建立单向屏障，使仅接受 schema 1/2 的旧程序拒绝打开新数据，避免旧模型出站路径忽略工具包历史依赖。

schema 3 是首次引入该屏障的版本，当前正常 catalog 为 schema 8，仍保留此安全要求。即使只打开目录也会升级。不能手工降低版本或只替换旧二进制回滚。手工回滚原则要求停机并持有升级前完整一致的 root 与全部 workspace 备份；当前[离线维护入口](STORE-MAINTENANCE.md)支持 schema 3、5、6、7、8 源库，但 restore 只创建新的 schema 4 非执行历史档案，不能用作可执行回滚。详细边界和未完成门禁见[长期容量与会话归档](CAPACITY-AND-ARCHIVAL.md#工具包授权的单向版本屏障schema-3)。

## 8. 验证范围

本轮定向测试使用仓库示例、临时 SQLite/文件和 faux provider，没有真实用户文件、付费模型调用或外部发布：

- [SDK 测试](../../packages/work-runtime/test/extension-pack.test.ts)：格式、Unicode、原字节摘要、步骤预算、取消。
- [生命周期测试](../../packages/work-runtime/test/extension-lifecycle.test.ts)：安装禁用、绑定与披露、stale payload、retained 历史、descriptor 篡改、registry 缺失、恢复、跨会话停用锁、过期和旧取消尾部竞争。
- [真实文件工具测试](../../packages/work-runtime/test/extension-tools.test.ts)：完整文件转换、原 revision、核心保存逐次审批、8,193 字节拒绝、审批消费后停用阻止最终写入并保留 unknown。
- [契约测试](../../packages/work-runtime/test/tool-pack-contracts.test.ts)与[只读存储测试](../../packages/work-runtime/test/feature-readonly.test.ts)：严格协议、scope/digest 精确匹配、不开 Harness 的查询及 schema 3 升级屏障。
- [checkpoint 测试](../../packages/work-runtime/test/extension-checkpoint.test.ts)：真实 SQLite 下 100 个 disabled 安装后的冷列表分页、全部源文保真，以及全部生命周期文档连续 100 次修改后的实质 materialization tail 与当前值。

最后一次核心组合定向运行 49/49 通过；计时器资源清理后生命周期与真实文件子集再次 14/14 通过。UI 管理代码与会话状态测试不能替代真实点击、键盘、屏幕阅读器、三平台主题和桌面打包验收。本文不声称整仓 npm run check、GUI、跨版本二进制恢复、断电/磁盘满或长期内存门禁已经通过。
