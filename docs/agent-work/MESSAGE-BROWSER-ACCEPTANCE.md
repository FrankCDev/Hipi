# 复杂消息组件浏览器验收

## 边界

[verify-message-browser.mjs](../../apps/hipi-work-ui/scripts/verify-message-browser.mjs) 使用独立的 [test/browser](../../apps/hipi-work-ui/test/browser/fixture.tsx) Vite 入口，直接组装正式 `ConversationHistory` → `ConversationMessages` → `MessageContent`、Markdown renderer、provider 和主题 CSS。未增加生产页面路由，未修改既有运行时验收脚本。

消息和 AppClient 是确定性测试数据：384 条可分页消息，初始 32 条；历史页每次有 31 条新消息及一个重叠 ID；长原文经正式契约解析器校验，以 32768 UTF-16 单位分页。测试显式释放读请求，故意让被取消的请求晚到。流式步骤固定为 1、3、5、12，并跨过富文本显示阈值。没有真实模型、付费请求、文件操作或传输连接。

这是组件浏览器验收，不是端到端运行时证据。[verify-browser.mjs](../../apps/hipi-work-ui/scripts/verify-browser.mjs) 中真实 PI Durable / SQLite / HTTP 的验收继续独立保留。

## 复跑

从仓库根目录执行。使用已经安装的 Node、仓库依赖、Playwright 和启用沙箱可正常启动的 Chromium；不需要生产构建或 Electron。Playwright 不作为产品依赖加入仓库。

```sh
HIPI_PLAYWRIGHT_PATH=/absolute/path/to/playwright \
HIPI_CHROMIUM_PATH=/absolute/path/to/chromium \
HIPI_EVIDENCE_DIR=/tmp/hipi-message-browser-evidence \
node apps/hipi-work-ui/scripts/verify-message-browser.mjs
```

`HIPI_PLAYWRIGHT_PATH` 可指向包目录或入口文件；省略时通过 Node 解析已有 `playwright`。Chromium 默认 `/usr/bin/chromium`，可先用 `command -v chromium` 确认本机路径。此脚本不安装依赖、不下载浏览器，并始终设置 `chromiumSandbox: true`。

若机器尚无 Playwright，可由操作者从官方 npm registry 将驱动安装在仓库外。以下是可选准备步骤，实施本次验收时没有执行安装：

```sh
npm install --prefix /tmp/hipi-browser-tools --ignore-scripts --save-exact playwright@1.62.1
HIPI_PLAYWRIGHT_PATH=/tmp/hipi-browser-tools/node_modules/playwright \
HIPI_CHROMIUM_PATH=/usr/bin/chromium \
node apps/hipi-work-ui/scripts/verify-message-browser.mjs
```

2026-10-19 通过 `npm view playwright@1.62.1 version engines --json` 核对该确切版本及 Node `>=20` 要求；仓库及 Vite 自己的 Node 要求也必须满足。使用操作系统或组织已准备的 Chromium。不要通过关闭沙箱绕过执行环境的安全限制。

无图形执行条件时，仅检查类型、脚本语法及 Vite 开发转换：

```sh
node node_modules/typescript/bin/tsc --noEmit -p apps/hipi-work-ui/test/browser/tsconfig.json
node --check apps/hipi-work-ui/scripts/verify-message-browser.mjs
HIPI_EVIDENCE_DIR=/tmp/hipi-message-transform-evidence \
node apps/hipi-work-ui/scripts/verify-message-browser.mjs --transform-only
```

`--transform-only` 不启动浏览器，不执行 React 或布局断言，结果始终标为 `TRANSFORM_ONLY_BROWSER_NOT_RUN`，不能作为浏览器通过。它禁用依赖预扫描，只做 fixture、样式和四个生产组件入口的开发转换。fixture 的独立 tsconfig 继承生产严格配置；根检查之外需执行上面的类型命令。

## 行为断言

- 初始到最新；四次靠近顶部自动读取历史，连续滚动事件不重复发起正在等待的请求。重叠消息 ID 去重，保留消息总索引正确，离开顶部不继续清空历史。
- 使用稳定消息 ID 记录更新前后相对滚动容器顶部的几何位置，允许 3 CSS px 舍入偏差。每次 prepend、非底部流式与最终提交、上方原文展开/折叠/换页、容器宽度及视口尺寸变化都记录实际差值。
- 不完整 Markdown/代码块持续增高，跨过富文本阈值后仍跟随底部；partial 替换为 final 时逻辑行数不增加，底部意图不丢失。离开底部阅读时不得自动拉回。
- 另一个受控 fixture 模式仅把真实虚拟行首次实测高度设为 160px，与当前生产估高一致。跨越视口顶部的行增长至 560px 再收缩，检查稳定阅读位置，覆盖“首次实测恰好等于估高”的测量缓存边界。
- 创建真实 DOM Selection 后，待发布数据冻结、选中文本不变；滚到别处时选区所在窗口的 DOM 仍挂载，当前视口消息也实际可见。清除选区发布最新数据并释放额外挂载。
- 每个普通窗口挂载不超过 48 行；选择期间上限为原固定窗口行数加 48。这是宽松测试回归上限，不是产品性能预算。
- 切换 scope 时旧历史/原文请求被取消；即使测试服务稍后返回，也不得污染新 scope。旧流式投影也不得出现在新 scope。
- 连续空历史页在 16 次读取后停止，显式“继续扫描”才恢复。不允许未处理异常、console error 或外部网络访问。
- CSS zoom 125% 后原阅读行仍在视口内且没有跳到最新；此项不声称验证原生 Electron 缩放。Selection 由脚本创建，也不替代原生鼠标拖选、输入法或屏幕阅读器测试。
- 为保持阅读锚点，视口外 overscan 行的原文/折叠控件使用 DOM `click()` 触发高度变化，不自动滚入视口。这不能作为真实可见鼠标点击的端到端证据。

## 证据及当前状态

脚本写入指定目录的 `message-verification.json`，包含 `result`、停止阶段、通过的检查、逐项几何测量、容差及异常。浏览器成功运行或失败时会尽力保存截图；启动阻塞不可能提供截图。行为失败返回非零并标 `FAIL`；启动/环境失败返回非零并标 `BLOCKED`。

浏览器与 Vite 清理分别捕获异常并记录 `cleanupErrors`，任何一项清理抛错仍会尝试写入报告，不覆盖原失败及停止阶段。即使断言已完成，清理失败也不得报告 `PASS`，且退出码非零。

2026-10-19 本次实现验证：fixture 严格类型检查、Biome、脚本语法检查和 7 个 Vite 开发转换通过。实际仅进行一次启用沙箱的 Chromium 启动，环境在 `socket()` 上返回 `Operation not permitted` 并以 SIGABRT 退出，报告 `BLOCKED`，浏览器行为检查完成数为 0。已有 Playwright 1.62.1 由环境全局 Node 路径解析；没有安装驱动或下载浏览器。

因此上述浏览器断言已经实现，但尚未得到实际浏览器执行通过的证据。仍需在允许 Chromium 沙箱运行的机器复跑；Windows、macOS、原生 Electron、真实输入法及原生鼠标拖选均未验收。没有运行构建、完整测试套件或提交代码。

2026-10-19 17:16 UTC 补充：受支持的云端浏览器工具能发现运行中的 Chromium，但访问组件开发服务 `http://127.0.0.1:5187` 返回 `ERR_CONNECTION_REFUSED`。另一次受支持的本机服务启动因环境只读文件系统错误失败，没有改变浏览器沙箱或网络安全设置。开发服务已停止。此尝试同样没有执行页面布局断言，不能记为浏览器通过。fixture 新增可见的释放读取、增长/提交流式输出和切换会话按钮，方便后续通过真实控件进行验收；其所在工具栏不属于产品界面。
