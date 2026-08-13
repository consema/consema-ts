# Consema TypeScript 发布流程（npm）

本文件是 consema-ts 仓库的发布操作手册（六仓统一纪律见 consema 仓库根
`RELEASING.md`）。发布是**半自动**的：版本 bump、CHANGELOG、tag 由人完成；
tag 推送后 `.github/workflows/release.yml` 自动发布 `@consema/consema`
到 npm。

## 1. 发布步骤（人执行的部分）

1. **版本 bump**：改 `typescript/package.json` 的 `version`，同时改仓根
   `README.md` 的 `Version:` 行（`check-version-consistency` 门禁强制一致）。
2. **CHANGELOG 策展**：记录本版本变更；跨语言变更同步到
   consema 仓库根 `CHANGELOG.md`（真实变更记录；`https://github.com/consema/consema/blob/main/docs/CHANGELOG.md` 只是勘误）。
3. **质量门禁全绿**：main 分支 CI `check (all gates green)` 全绿
   （清单见各仓 ci 配置）。
4. **打 tag 并推送**（发布动作的唯一触发点）：
   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```
   发布 workflow 会先 provision conformance 数据（多仓 checkout 模式，与
   CI 一致；`npm test` 的 conformance runner 按仓库相对路径读
   `conformance/`），再校验 tag↔版本一致（tag 去掉 `v` 前缀必须等于
   `typescript/package.json` 的 version，不一致即 exit 1 中止；provision
   步骤在校验之前，与 release.yml 的步骤顺序一致），最后执行
   npm ci / check / test / publish --dry-run / publish。

## 2. 凭证配置（用户侧一次性动作）

1. npm 账号生成 **publish token**：npmjs.com → Access Tokens →
   Generate New Token，type 选 **Granular**（或 Classic），
   权限只勾 `Read and write`（`@consema/consema` scope 或 all packages）。
2. GitHub 仓库 Settings → Secrets and variables → Actions 新建
   **`NPM_TOKEN`**，填入 token。
3. （可选但推荐）npmjs.com → `@consema/consema` 包设置 → 把
   "Provenance" 与 "Trusted publishing"（OIDC）标记为可用；provenance
   在 workflow 中已通过 `--provenance` + `id-token: write` 启用，无需
   额外配置即可生效。

发布包默认 `publishConfig.access = public`，`publishConfig.provenance =
true`（npm 9.7+；手动 `npm publish` 同样带 provenance 签名）。

## 3. Canary 发布（zod 模式，P2 可选，暂不接线）

zod 类库的 canary 模式（每个 commit 发布 `x.y.z-canary.<sha>` 到
`canary` dist-tag，供集成方提前验证）在 1.0 前不接线；需要时按如下
模式补：

```bash
# 在 release.yml（或独立 canary.yml）中：
npm publish --tag canary --provenance
# 版本号：package.json 版本不动，用 --no-git-tag-version + npm version
# prerelease --preid canary 生成 canary 版本再发布
```

消费者侧：`npm i @consema/consema@canary`。接线前需确认 npm 包名的
`canary` dist-tag 归属策略（与主版本共存）。

## 4. 发布形态说明（决策记录）

1.0 前保持**源码直发**：`main`/`types`/`exports` 均指向
`./src/index.ts`，`files = ["src", "!src/**/*.test.ts"]`（排除测试文件，
tarball 不含消费者环境 ENOENT 死文件）——零构建依赖、node 26 原生执行 TS，
发布包即源码（类型与实现天然同源，无 dist 漂移风险）。若未来需要
降级兼容（如浏览器打包器需要 JS），再切换为 tsc 预编译 dist 形态，
届时需同步修改 main/types/exports/files 并增加 build 步骤。

## 5. API reference 文档（决策：typedoc 待发布时引入）

API reference 的 typedoc 构建**尚未接线**（2026-08-12 决策）：typedoc 不是
devDependency，package.json 也没有 docs 脚本；引入 typedoc 属于依赖改动，
按"发布时引入"处理（与 rustdoc docs.yml artifact job 对标的文档产物在
typedoc 引入后补建 `.github/workflows/docs.yml`）。当前依赖面审计由
`.github/workflows/audit.yml`（npm audit）覆盖。
