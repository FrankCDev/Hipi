# 历史边界与恢复回归检查点

2026-10-19，云端 Linux x64，Node 24.19.0 / npm 11.9.0。协议版本 2；SQLite catalog、PI 回执文档及浏览器存储 schema 不变。此记录不表示整个产品或实际桌面验收完成。

## 变更

最新快照、历史页、消息原文块、回执回答/原因和实时输出均有独立大小约束与明确的长度/截断元数据。查询通过 PI 公共 fork-aware API，不从活动上下文伪造完整历史。UI 提供更早/最新页、完整原文块读取与受控复制反馈。

全量 UI 定向回归曾发现 pending-record 校验仍构造旧版 wire request，导致保存未决输入失败。已改为当前协议常量，保留本地 schema v1，并新增已保存请求与后续草稿在升级后仍可恢复的回归。初次失败输出保留为 `ui-tests.txt`；修复后输出为 `ui-tests-after-recovery-fix.txt`。

## 证据

- `check.txt`：最终完整 `npm run check` 输出；包含根检查、运行时、UI 与 desktop 工作区。它不运行完整测试套件。
- `runtime-tests.txt`：9 个 runtime 测试文件和 3 个 desktop 测试文件，68/68 通过。包括超过 128 条合法历史、多消息 entry、fork 边界、压缩/reset、空 continuation、追加与重启稳定性、跨会话拒绝、超过一 MiB 的真实 faux-provider 回答、精确 Unicode 原文重建，以及 HTTP/SSE、Node IPC 和 desktop 路由层验证。
- `ui-tests-after-recovery-fix.txt`：9 个 UI Node 测试文件，60/60 通过。包含旧本地存储恢复、迟到页/文本读取、取消、Latest 重置和迟到复制反馈。
- `markdown-tests.txt`：明确指定的 SSR 测试文件，10/10 通过。它没有运行浏览器 DOM、网络、布局或输入法。
- Vite 开发转换与文档链接检查另列实际输出，不能替代 GUI。

## 性能观察与限制

保留了可复现的 [Markdown SSR 测量](../../benchmarks/markdown/README.md)。旧策略的 32 Ki UTF-16 流式富文本 warm SSR 中位数约 134 ms，不能被 80 ms 更新间隔消除。当前暂将流式富文本上限降低为 2048 单位，较长输出明确回退到原文。静态上限仍为 32768 单位。测量环境共享、样本量小，不能视为浏览器帧率或最低硬件承诺。

PI 的活动 watch 和单条 entry 读取内部仍可能完整装载数据。应用分页不代表上游内存严格有界。

尚未执行生产构建、官方 Electron 下载/启动、跨平台 GUI/安装/更新验证。构建及官方 Electron 执行授权仍待回复；云端默认沙箱 Chromium 在建页前失败，Mac/Windows 执行环境仍离线。真实模型、工具与文件工作台、插件等后续能力未因此完成。无提交、推送或真实付费模型调用。
