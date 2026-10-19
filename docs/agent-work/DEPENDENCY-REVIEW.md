# 文件工作台依赖审查

2026-10-19。此记录只描述依赖选择与安装检查，不是漏洞扫描、功能验收或 RC 通过证明。

## 编辑器

直接固定 `@codemirror/state 6.5.2`、`@codemirror/view 6.38.6`、`@codemirror/commands 6.8.1`、`@codemirror/merge 6.11.1`。使用官方原生编辑器与比较视图，不引入额外 React wrapper。官方来源为 [CodeMirror](https://codemirror.net/) 及 npm 的同名包。四包为 MIT，首次安装新增 13 个 MIT 依赖条目，没有变更既有解析版本或运行安装脚本。

输入、保存和预览仍受应用自己的文件授权、字节限制、版本检查与资源生命周期管理。安装 CodeMirror 不等于完成 IME、无障碍或大文件性能验收。

## 文档解析

- `mammoth 1.13.0`，BSD-2-Clause：[官方仓库与安全说明](https://github.com/mwilliamson/mammoth.js)。只用 Buffer 的纯文本提取，不采用 HTML 转换。外部资源禁用不等于资源耗尽防护，需要独立工作线程、预检和超时终止。
- `xlsx 0.20.3`，Apache-2.0：固定 [SheetJS 官方发布包](https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz)，不是 npm 上的旧 `xlsx 0.18.5`。版本及发布包 integrity 保存在锁文件。来源说明见 [官方安装文档](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/)。只读取受限单元格与保存值，不重新计算公式。
- `yauzl 3.4.0`，MIT：[官方仓库](https://github.com/thejoshwolfe/yauzl)。使用流式 ZIP 预检，不提取到磁盘；实际解压字节与条目数量另有限制。类型固定为 `@types/yauzl 3.4.0`。
- `papaparse 5.7.0`，MIT：[官方文档](https://www.papaparse.com/docs)。CSV 仅作为字符串表格，不启用下载或动态类型推断。类型固定为 `@types/papaparse 5.5.2`。

安装上述解析器与类型新增 27 个锁文件条目，没有新增 install 生命周期脚本。既有 `inherits` 与 `util-deprecate` 的依赖分类发生变化，版本未变。JSZip 的双许可证选择 MIT；其余新增传递依赖为 MIT、BSD 系列、Apache-2.0 或 Zlib。安装使用 `--ignore-scripts`，未执行包的开发用 `prepare`、`build` 或测试脚本。

解析器输入不包含路径、凭据或授权对象。线程隔离和 V8 内存限制不是操作系统权限沙箱，也不是严格进程 RSS 限额。

## PDF

`pdfjs-dist 6.4.299`，Apache-2.0：[Mozilla PDF.js](https://mozilla.github.io/pdf.js/)。包要求 Node `>=22.13.0 || >=24`，与本项目 Node 基线相容。主包约 35 MB 是解包体积，不是浏览器实际下载量；实际生产构建另行测量。

锁文件同时记录 PDF.js 的可选 `@napi-rs/canvas 1.0.11` 及各平台二进制包，许可证 MIT，无 install 生命周期脚本。UI 采用浏览器 canvas 和独立 PDF worker，不据此宣称 Node 原生 canvas 在所有平台可用；各平台可选包不会全部安装到当前系统。

按实际安装类型验证 API，不沿用已移除的旧选项。只使用受控数据输入和本地 worker，不接受任意预览 URL，不挂载脚本、附件、表单或注释层；远端字体、CMap、WASM 等加载必须明确禁止或限定为打包资源。

## 发布要求

2026-10-19 `npm audit --omit=dev --json` 返回 5 个受影响包项：2 high、3 moderate（包括依赖传播项，并不等于 5 个独立漏洞）。仓库现有 Gondolin → node-forge 报告 [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv)；Mammoth 的 CLI 依赖 argparse → sprintf-js 报告 [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c)。没有运行自动降级/批量修复命令。

已检查 Mammoth `lib/index.js` 与 `bin/mammoth`：argparse 仅由 CLI 入口导入。本应用使用库的 `extractRawText`，不调用该 CLI。独立解析器的 esbuild metafile 检查确认没有 argparse、sprintf-js、node-forge 或 Gondolin 输入，且搬离源码目录的解析器已通过 CSV/DOCX/XLSX 合成样例。`apps/hipi-work-desktop/scripts/check-preview-bundle.mjs` 可在最新生产构建后重新检查。这证明该解析器构建图的排除关系，不意味着整个仓库 audit 清零；其他交付入口仍须独立验证。

锁文件审查只记录来源、版本和完整性。尚需针对可达路径审查公开安全公告，并验证恶意文件、损坏输入、超限、取消和连续切换。分发构建必须保留依赖原始 LICENSE / NOTICE，不能因打包到一个 JavaScript 文件就丢弃许可证。现有依赖安装成功不代表最终安装包、代码签名或三平台运行通过。
