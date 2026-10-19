# Electron 宿主与 Markdown 源码检查点

2026-10-19，云端 Linux x64，Node 24.19.0 / npm 11.9.0。源码来自第二阶段交付包，经 SHA-256 与逐文件清单验证后恢复；恢复目录不含 Git 元数据。本记录不表示产品完成或生产就绪。

本记录对应 13:01 UTC 的桌面/Markdown 检查点。后续协议 2 与历史边界修复见[历史检查点](../history/VERIFICATION.md)，下面列出的当时限制不自动代表后续源码仍未修复。

## 已实现

- Electron main / 沙箱 preload / utility runtime 源码及共享 UI 桌面组装，受控调用来源、存储身份绑定、事件确认、有界等待和订阅。
- utility 退出后的有限重启、代次隔离、不自动重放变更命令；未确认退出时不宣称写入者已释放。
- 窗口关闭确认先于 runtime 清理，取消关闭保留可用连接；超时 IPC 仍保留底层未决调用配额。
- 助手消息 GFM Markdown、临时流式语法修补、禁用活动链接和图片资源；有界原文分页；选中文本时冻结显示并提示有新输出。
- 两处回归修正：SIGKILL 恢复测试区分合法中断片段与重复完成答案；OpenRouter 格式测试使用固定 fixture，避免依赖实时模型目录。

## 实际验证

完整输出见同目录文本文件，以下均非完整仓库测试套件：

- `npm run check`：覆盖根静态检查、TypeScript、公开依赖/入口图、安装锁一致性、浏览器安全编译与三个 Hipi 工作区检查。实际结果以 `check.txt` 最后一次执行为准。
- 6 个 runtime 测试文件与 3 个 desktop 测试文件：56/56 通过。包含真实 PI/SQLite、HTTP、Node child IPC 与桌面路由层恢复；desktop peer/lifecycle 由受控替身测试，不是 Electron 执行。
- 7 个 UI Node 测试文件：50/50 通过，覆盖连接、持久草稿、原回执核对、桌面适配与显示投影策略。
- `test/message-markdown.test.tsx`：7/7 通过，SSR、原文与 URL 策略验证。SSR 无 DOM/network，不证明实际浏览器无请求或选区行为。
- `test/openai-completions-tool-choice.test.ts`：49/49 通过，SDK mocked，无真实模型调用。
- Vite 开发入口及 29 个源模块转换通过；没有执行生产构建。
- 文档相对链接及空白检查单独执行。无 `.git`，未运行有效的 `git diff --check`，没有提交或推送。

## 未运行与阻断

- 构建和官方 Electron 二进制下载/运行授权仍待用户回复；未执行 `prepare:desktop`、Electron 安装脚本或 Electron 启动。
- 本轮尝试默认沙箱 Chromium，创建页面前因 `socket() failed: Operation not permitted` 退出。没有 GUI 断言或截图，详见 `browser-blocked.txt`。
- macOS / Windows / Linux Electron 真机、打包安装、签名、公证、更新、原生输入法、屏幕阅读器和长会话性能未验收。
- 当前仍为明确标识的确定性测试模型。真实模型设置、执行工具、文件编辑/Diff、文档预览、插件闭环尚未完成。
- 现有完整快照存在长历史及超长回答边界问题，见[历史边界](../../HISTORY-BOUNDS.md)。本次 Markdown 显示分页不修复传输层问题，生产发布仍受其阻断。

检查命令可从各工作区 README 重现。通过数量只说明所列检查，不等于 UI 美观度、生产稳定性或跨平台完成。
