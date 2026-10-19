# 架构决策：与传输通道解耦的 Electron 客户端

日期：2026-10-19。状态：用户已明确技术方向；以下实现方案为工程推荐，待最小验证后锁定具体依赖版本。本文件不是实现完成或远程服务产品已交付的声明。

## 1. 已确定的方向与待验证的选择

用户明确倾向采用 Electron，前端采用 shadcn/ui、Tailwind CSS 和 TanStack 家族，主进程使用 TypeScript。前端不得依赖 Electron API；通过 provider / adapter 注入能力，方便未来接入 HTTP 服务端。核心能力同样不能依赖 Electron，需保留 IPC 与 HTTP 两条接入路径。

据此以 Electron 作为桌面方向继续设计，不再将桌面容器选型保持为完全开放问题。React 是配合该 UI 方向的推荐基础；具体 React、Electron、Node、Tailwind、shadcn/ui、TanStack 版本组合及构建、打包、更新工具尚未安装或验证，实施前需核对官方兼容要求并固定确切版本。服务器产品范围、部署方式和公网开放不在本次决策承诺内。

## 2. 问题、例子与解决方式

如果任务页面直接调用 Electron 的 IPC，未来网页客户端就必须重写页面；如果业务用例接受 Electron 事件或 HTTP request 对象，两个入口又会形成两套业务规则。

例如“提交任务”：页面调用 `AppClient.submitTask(command)`，桌面注入 IPC client adapter，网页注入 HTTP client adapter。两侧服务入口校验并转换为同一应用用例；用例通过 Durable adapter 提交持久执行，返回受控 DTO 与接收回执。页面不需要知道进程、端口或运行时句柄。

采用显式构造参数与 React Provider 完成依赖注入即可；暂不引入万能 DI 容器，也不为未来拆分微服务。

## 3. 模块与依赖边界

以下是职责划分建议，不是已创建的目录或包：

- **应用契约**：浏览器安全的 DTO（数据传输对象）、schema、应用错误、命令回执与版本信息。不得导出 Electron、Node、Chord 或持久化实例。
- **AppClient 接口**：UI 使用的查询、命令与订阅能力。UI 通过 React Provider 获取接口，只依赖应用契约和该接口；不得读取 `window.electron`、导入 preload、Node 模块或依赖通道名称。
- **UI**：React 页面、组件、主题、国际化及临时交互状态；可以独立挂载到浏览器测试环境。
- **客户端适配器**：IPC adapter 使用受限 preload bridge；HTTP adapter 使用浏览器可用的网络接口，不依赖 Node 或 Electron。桌面组装入口选择 IPC adapter，网页组装入口选择 HTTP adapter。选择通道不进入页面业务逻辑。
- **服务入口适配器**：IPC 和 HTTP 分别处理认证上下文、输入解析、协议错误与输出映射，调用同一套 application core 用例。核心不接收 Electron 事件、Express/Hono 请求对象或响应对象。
- **应用核心**：纯 TypeScript 的业务用例、授权规则及输入输出端口，不依赖 Electron 或 HTTP 框架。存储、运行时、时钟、OS 资源等通过明确端口接入；只抽象已有变化点。
- **Durable adapter 与 Agent runtime**：薄适配层隔离 PI Durable / Chord 的对象、生命周期与错误。Agent runtime 在独立 Node 进程中运行；执行、工具与模型活动不放在 renderer 或 Electron main 的事件循环里。
- **Electron main**：薄宿主，负责窗口、菜单、系统集成及 runtime 启停与故障监管，连接受控 IPC 入口。业务用例仍由独立 runtime 内的服务组装运行，main 不成为第二个状态写入者。主进程与 runtime 的具体通信机制待验证，不向 UI 透出其内部协议。
- **平台与存储适配器**：实现文件访问、凭据存储、通知及 Durable 存储等输出端口；授权在可信服务侧执行，不能以 UI 禁用按钮代替权限检查。

Electron 专用 bridge 只在桌面组装边界接入。采用上下文隔离、关闭 renderer 的 Node 集成、适用的沙箱及内容安全策略；preload 暴露逐项定义的方法，不暴露通用 `ipcRenderer`、任意通道或任意文件访问。IPC 入口仍需验证调用来源、参数和授权。独立进程本身不等于工具权限沙箱。

桌面能力单独以可选 `DesktopCapabilities` 提供，UI 必须处理能力缺失。例如本机文件选择器不能伪装为远程服务器文件选择器；网页使用显式上传或已授权服务器资源选择流程。

## 4. 一个契约，两种通道

复用仓库已有的 TypeBox 技术基础，推荐用共享 schema 描述可序列化应用边界，并派生 TypeScript 类型；具体 schema 兼容、校验和生成链路需验证。IPC、HTTP、插件等不可信入口均执行运行时校验，输出亦按公共契约验证。

公共 HTTP API 是经过筛选与授权设计的应用接口，不直接公开 Chord RPC 对象、任意文档修改或事务回调。OpenAPI 从公共 HTTP 契约与其路由、认证、状态码元数据生成，不手工维护第二份 DTO；不承诺所有内部 RPC 或 TypeBox 表达都能无损转为 OpenAPI，无法表达的行为需明确限制并测试生成结果。

契约至少定义：

- 请求关联 `requestId`、任务和工作区标识、协议版本、稳定错误码及可安全展示的信息；原始异常与敏感路径不直接返回 UI。
- 查询与改变执行事实的命令分开；命令返回接收回执，区分已请求、已接受、已执行与结果已确认。提供按请求或回执查询状态的能力，避免回包丢失后盲目重试。
- 幂等键的作用域、保留期与相同键不同载荷的冲突规则。对 Durable 支持的请求去重做明确映射；其他命令需独立验证，不能推导出任意外部副作用 exactly-once。
- `cancelWait` 仅停止客户端等待或订阅；`cancelRun` 是经过授权的执行取消命令。网络断开、页面卸载、关窗与退出宿主不能隐式冒充用户取消；退出和后台存活策略单独评审。
- 有界快照、分页历史、带游标或序号的增量事件、队列和消息大小限制、订阅释放及背压。明确快照与事件的衔接点；重连后检测重复、缺口、过期游标，必要时重新取快照。HTTP 流采用何种机制待验证，不能依赖无限内存回放。

## 5. HTTP 不是替换 URL

HTTP adapter 复用应用语义，但必须补齐网络边界：

- 身份认证、工作区和资源授权、凭据生命周期、请求体限制、限流、连接与订阅配额，以及断线和超时处理。
- 根据认证方式设计 CORS、CSRF 与 Origin 校验；CORS 不是鉴权。公网传输必须有 TLS 和明确的部署信任边界。
- 上传大小、内容类型、存储配额、取消与清理策略；资源使用受控 resource URI 或资源 ID。客户端路径与服务器路径不能混同，路径映射需防目录穿越、越权与符号链接逃逸，不接受任意绝对路径。
- 错误码到 HTTP 状态码、命令回执到异步状态查询、订阅到网络流的映射，均作为 HTTP 契约的一部分验证。

初版可只在 loopback 上开发验证 HTTP adapter；即使仅本机访问，也需防恶意网页调用本地服务，落实认证、来源限制及安全绑定。远程安全验收前不绑定公网、不宣称已交付服务器产品。部署、多租户、运维和公网 API 生命周期另行决策。

## 6. 前端工具职责与状态归属

shadcn/ui、Tailwind CSS 与 TanStack 家族方向已确定；下列 TanStack 子库的职责划分与取舍是工程推荐，尚未锁定具体组合或版本，不表示已安装或已验证。

- **shadcn/ui + Tailwind CSS**：组件与样式基础，配合语义主题变量、可访问性、字体与国际化设计。组件源代码需持续维护；默认组合不代表完整设计系统。
- **TanStack Router**：类型化导航、工作区与任务路由、可分享的页面定位。路由状态不承载执行事实。
- **TanStack Query**：应用查询的读模型缓存、加载与错误状态、失效及重新拉取。订阅事件按版本更新缓存或触发失效；重连可由权威快照重建。
- Query 缓存键必须包含连接身份与工作区等作用域；切换服务或身份时清理对应缓存和订阅，避免跨服务展示或泄露数据。
- **TanStack Virtual**：长会话、日志和成果列表在性能证据支持时使用，验证动态高度、流式内容、焦点与滚动锚定。
- **TanStack Table**：出现真实复杂表格需求时再引入，不作为全量家族安装要求。
- **TanStack Start**：当前桌面与浏览器客户端不需要 SSR，不引入；未来需求变化另行评审。

持久执行事实由 Durable 拥有，保持单一写入权威；应用需要新增持久元数据时明确其存储归属，不能复制一套可独立写入的任务生命周期。Query 仅保存可重建的读取投影；React 本地状态保存输入草稿、展开项等交互。不得再用全局 store 维护第三份任务状态。乐观 UI 只能显示待确认意图，不能伪造已执行或已授权事实。

## 7. 工程工具建议与实施前验证

当前仓库已有 Biome，建议继续负责基础 lint 与唯一格式化；ESLint 仅在需要 React Hooks、TanStack Query 等专门规则且现有工具不能覆盖时补充，并明确文件范围与关闭重复规则。Prettier 不与 Biome 同时格式化同一文件。此处是职责推荐，不是已配置或验证的规则集；专项插件、导入边界规则与兼容版本在实施前确认。

HTTP adapter 推荐评估 Hono，仅留在传输边界；命令和查询采用 HTTP，单向状态更新优先评估 SSE，只有明确双向高频通信需求才考虑 WebSocket。以上均未实测，不构成版本或性能承诺。无论框架如何选择，应用核心必须可以不启动 Electron 而在独立 Node 环境运行。

保持现有工作区规范、精确版本与锁文件审查，不为客户端引入第二套包管理器。通过静态依赖检查与浏览器构建验证 UI、应用契约、AppClient 不引用 Electron/Node，以及应用核心不引用具体宿主。新工具、目录与脚本在实现变更中单独评审，不修改上游规范来迁就新方案。

官方资料：[Hono](https://hono.dev/docs)、[TanStack Query](https://tanstack.com/query/latest/docs/framework/react/overview)、[TanStack Router](https://tanstack.com/router/latest/docs/overview)、[Biome](https://biomejs.dev/installation/quick-start/)、[React Hooks lint](https://react.dev/reference/eslint-plugin-react-hooks)、[TanStack Query lint](https://tanstack.com/query/latest/docs/eslint/eslint-plugin-query)。这些资料说明工具用途，不替代本仓库的版本兼容与集成测试。

## 8. 最小验证与接受条件

实现前先做一个贯穿用例：提交任务 → 回执 → 流式观察 → 取消等待 → 重新连接 → 查询最终结果；使用确定性假模型，不调用付费服务。

1. 同一 UI 在 Electron IPC 与普通浏览器 HTTP 下运行，不改变页面业务代码。
2. 两个 adapter 执行同一应用契约一致性测试，覆盖校验、拒绝授权、错误、回执、重复请求和不同载荷冲突。
3. 覆盖接受命令后回包丢失、runtime 崩溃、UI 重载、订阅泄漏、慢消费者、事件缺口和过期游标恢复；状态与结果不得被缓存反向改写。
4. 验证取消等待不会取消任务；取消执行不承诺撤销已发生的外部效果，未知结果有核对路径。
5. 验证 Electron 内嵌 Node 与独立 runtime 的版本、原生存储模块和三平台打包路径；主进程保持响应。性能预算在建立基准后确定。
6. 验证 IPC 来源限制、preload 最小接口、HTTP 本地认证与来源限制、文件授权和上传边界。公网发布须另做威胁模型与远程安全验收。

通过以上验证后再锁定具体版本、通信与打包工具、前端构建细节及首版范围。本轮仅记录方向与设计，未创建客户端、安装依赖、运行功能测试或证明生产就绪。

流式 Markdown、右侧文件工作台、编辑与文档预览的详细边界见[工作台设计](WORKBENCH.md)。

关联：[愿景](../../VISION.md)、[产品原则](PRODUCT-PRINCIPLES.md)、[工程原则](ENGINEERING-PRINCIPLES.md)、[PI Durable 文档](../../packages/durable/README.md)。
