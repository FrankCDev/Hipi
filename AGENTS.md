# Development Rules

## Conversational Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text (e.g., "Thanks @user" not "Thanks so much @user!")
- Technical prose only, be direct
- Use concise, clear, simple language. Define unavoidable jargon before using it.
- Explain non-trivial designs and problems as: problem, concrete example or short trace, then solution. State why the solution is necessary and distinguish it from optional complexity.
- Prefer concrete behavior and small illustrations over abstract summaries, dense terminology, or unexplained lists of changes.
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site.
- Check node_modules for external API types; don't guess.
- **No inline imports** (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- In `packages/coding-agent`, resolve package assets through helpers in `src/config.ts`. Do not use `__dirname` directly; the helpers account for source checkouts, npm installations, and standalone binaries.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Use only erasable TypeScript syntax (Node strip-only mode) in code checked by the root config (`packages/*/src`, `packages/*/test`, `packages/coding-agent/examples`): no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or other constructs needing JS emit. Use explicit fields with constructor assignments.
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.
- Never hardcode key checks (e.g. `matchesKey(keyData, "ctrl+x")`). Add defaults to `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS` so they stay configurable.
- Never modify `packages/ai/src/models.generated.ts` directly; update `packages/ai/scripts/generate-models.ts` instead, then regenerate. Including the resulting `models.generated.ts` diff is always OK, even if regeneration includes unrelated upstream model metadata changes.

## Commands

- After code changes (not docs): `npm run check` (full output, no tail). Fix all errors, warnings, and infos before committing. Does not run tests.
- Never run `npm run build` or `npm test` unless requested by the user.
- Never run the full vitest suite directly: it includes e2e tests that activate when endpoint/auth env vars are present. For all non-e2e tests, run `./test.sh` from the repo root. Otherwise run specific tests from the package root:
  - Vitest: `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/specific.test.ts`
  - `packages/tui` (`node:test`): `node --test test/specific.test.ts`
- If you create or modify a test file, run it and iterate on test or implementation until it passes.
- For `packages/coding-agent/test/suite/`, use `test/suite/harness.ts` + the faux provider. No real provider APIs, keys, or paid tokens.
- When regressions tests for fixing a github issue, add a comment with the github issue number next to the test.
- For ad-hoc scripts, `write` them to a temp file (e.g. `/tmp`), run, edit if needed, remove when done. Don't embed multi-line scripts in `bash` commands.
- Never commit unless the user asks.

## Dependency and Install Security

- Treat npm dep and lockfile changes as reviewed code. Direct registry deps, including internal workspace deps, stay pinned to exact versions.
- When updating `undici`, you MUST read its changelog/release notes for the target version and evaluate whether any changes may affect functionality before applying the update.
- Hydrate/update locally with `npm install --ignore-scripts`; clean/CI-style with `npm ci --ignore-scripts`. Don't run lifecycle scripts unless the user asks.
- If dep metadata changes, refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts`.
- If `packages/coding-agent/install-lock/` needs regen, run `node scripts/generate-coding-agent-install-lock.mjs` (verify with `--check` or `npm run check`). New deps with lifecycle scripts require review and an explicit allowlist entry in that script; never add one silently.
- Pre-commit blocks lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1`. Don't bypass unless the user wants the lockfile change committed.

## Third-Party Notices

- Use npm packages normally. Do not copy each dependency's implementation or license tree into `vendor`, or maintain duplicate per-package inventories, CLI logs, staging lockfiles and audit snapshots by default. `package.json` and the lockfile remain the dependency source of truth.
- Keep license handling proportionate. Do not introduce elaborate license frameworks, redundant hash checks or repeated audits for ordinary dependency use, or let them displace product implementation and validation.
- When packaging, collect necessary notices for the dependencies actually shipped through the existing build process, rather than checking a second installed-dependency license tree into source control.
- Preserve required attribution for directly distributed source components, fonts and assets, and address concrete license restrictions when encountered. This is not permission to remove required distribution notices.

## Git

Multiple pi sessions may be running in this cwd at the same time, each modifying different files. Git operations that touch unstaged, staged, or untracked files outside your own changes will stomp on other sessions' work. Follow these rules:

Committing:

- Only commit files YOU changed in THIS session.
- Stage explicit paths (`git add <path1> <path2>`); never `git add -A` / `git add .`.
- Before committing, run `git status` and verify you are only staging your files.
- `packages/ai/src/models.generated.ts` may always be included alongside your files.
- Message format: `{feat,fix,docs}[(ai,tui,agent,coding-agent)]: <commit message> (optionally multiple lines)`. Message is informative and concise.

Never run (destroys other agents' work or bypasses checks):

- `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`.

If rebase conflicts occur:

- Resolve conflicts only in files you modified.
- If a conflict is in a file you did not modify, abort and ask the user.
- Never force push.

## Issues and PRs

See `CONTRIBUTING.md` for the contributor gate (auto-close workflows, `lgtm`/`lgtmi`, quality bar).

When reviewing PRs:

- Do not run `gh pr checkout`, `git switch`, or otherwise move the worktree to the PR branch unless the user explicitly asks.
- Use `gh pr view`, `gh pr diff`, `gh api`, and local `git show`/`git diff` against fetched refs to inspect PR metadata, commits, and patches without changing branches.
- If you need PR file contents, fetch/read them into temporary files or use `git show <ref>:<path>` without switching branches.

When creating issues:

- Add `pkg:*` labels for affected packages (`pkg:agent`, `pkg:ai`, `pkg:coding-agent`, `pkg:tui`); use all that apply.

When posting issue/PR comments:

- Write the comment to a temp file and post with `gh issue/pr comment --body-file` (never multi-line markdown via `--body`).
- Keep comments concise, technical, in the user's tone.
- End every AI-posted comment with the AI-generated disclaimer line specified by the originating prompt (e.g. `This comment is AI-generated by `/wr``).

When closing issues via commit:

- Include `fixes #<number>` or `closes #<number>` in the message so merging auto-closes the issue. For multiple issues, repeat the keyword per issue (`closes #1, closes #2`); a shared keyword (`closes #1, #2`) only closes the first.

## Testing pi Interactive Mode with tmux

For testing pi's interactive mode, load and follow [.pi/skills/interactive-testing.md](.pi/skills/interactive-testing.md).

## Changelog

Location: `packages/*/CHANGELOG.md` (one per package).

Sections under `## [Unreleased]`: `### Breaking Changes` (API changes requiring migration), `### Added`, `### Changed`, `### Fixed`, `### Removed`.

Rules:

- All new entries go under `## [Unreleased]`. Read the full section first and append to existing subsections; never duplicate them.
- Released version sections (e.g. `## [0.12.2]`) are immutable; never modify them.
- Do not create changelog entries when working on a branch other than `main` or pull request

Attribution:

- Internal (from issues): `Fixed foo bar ([#123](https://github.com/earendil-works/pi/issues/123))`
- External contributions: `Added feature X ([#456](https://github.com/earendil-works/pi/pull/456) by [@username](https://github.com/username))`

## Releasing

For release preparation, publishing, verification, or recovery, load and follow [.pi/skills/release.md](.pi/skills/release.md).

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.

## Hipi Work 客户端补充约束

本仓库规划基于 PI Durable 的全新跨平台 Agent Work 客户端 Hipi Work，工程标识为 `hipi-work`，仓库名保持 Hipi。`client` 仅用于内部客户端接口模块。以上上游规则保留；以下约束适用于本产品开发，不代表上游能力承诺。

- 开始产品开发前，阅读 [VISION.md](VISION.md)、[产品原则](docs/agent-work/PRODUCT-PRINCIPLES.md)与[工程原则](docs/agent-work/ENGINEERING-PRINCIPLES.md)；完整入口见 [Hipi Work 文档](docs/agent-work/README.md)。
- 维护跨平台、好看、交互友好、插件生态、可靠、稳定六个核心目标；主题、字体、国际化、流畅体验和异常恢复均属于产品质量要求。
- Electron 桌面、TypeScript 主进程、shadcn/ui、Tailwind CSS 与 TanStack 家族方向已明确。遵循[架构决策](docs/agent-work/ARCHITECTURE.md)：UI 只依赖应用契约与注入的 AppClient，IPC/HTTP 适配不进入页面；应用核心不依赖 Electron 或 HTTP 框架。React 与 TanStack 细项、具体版本兼容、最低系统与硬件要求、性能预算和首版范围仍待验证或评审，不得将建议写成已确认决策。
- 当前 PI Durable 文档基线为 `1402973a9dbe8c627341e04c9744c54953e285ca`，上游标注 Experimental。通过薄适配层接入、固定版本并验证升级；不得承诺自动获得端到端 exactly-once 或权限沙箱。
- 保持业务规则、持久执行状态和 UI 临时状态的边界；IPC 与插件入口必须有明确契约和输入校验。
- 阶段可以缩小功能范围，但不得降低正式代码的封装与工程质量。封装必须明确职责、所有权、不变量、错误与资源生命周期，不以接口或包装层数量衡量。测试模型与兼容性实验单独标识和组装，不能代替真实链路验收。提交恢复、连接隔离与重复执行等风险必须有行为回归证据。
- 新功能同时考虑三平台、主题、国际化、权限、取消与恢复，按风险提供验证证据；不得用文档或演示替代生产可靠性证明。
- 完成报告明确已验证内容与未运行检查。文档改动检查相对链接及 `git diff --check`，不得声称等价于功能测试通过。
- 客户端开发与评审必须遵守[开发规范](docs/agent-work/DEVELOPMENT-STANDARDS.md)，覆盖模块边界、严格类型、异步资源、组件、测试、依赖与交付；其中标注待实施的自动门禁不得当作已配置。以上命令、导入和 Git 规则继续有效。
