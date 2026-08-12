# Consema TypeScript 发布流程（npm）

本文件是 consema-ts 仓库的发布操作手册（六仓统一纪律见 consema 仓库根
`RELEASING.md`）。发布是**半自动**的：版本 bump、CHANGELOG、tag 由人完成；
tag 推送后 `.github/workflows/release.yml` 自动发布 `@consema/consema`
到 npm。

## 1. 发布步骤（人执行的部分）

1. **版本 bump**：改 `typescript/package.json` 的 `version`，同时改仓根
   `README.md` 的 `Version:` 行（`check-version-consistency` 门禁强制一致）。
2. **CHANGELOG 策展**：记录本版本变更；跨语言变更同步到
   consema 仓库 `docs/CHANGELOG.md`。
3. **质量门禁全绿**：main 分支 CI `check (all gates green)` 通过
   （ts-gates / ts-conformance / ts-differential / ts-compiler-matrix /
   check-version-consistency）。
4. **打 tag 并推送**（发布动作的唯一触发点）：
   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

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
`./src/index.ts`，`files = ["src"]`——零构建依赖、node 26 原生执行 TS，
发布包即源码（类型与实现天然同源，无 dist 漂移风险）。若未来需要
降级兼容（如浏览器打包器需要 JS），再切换为 tsc 预编译 dist 形态，
届时需同步修改 main/types/exports/files 并增加 build 步骤。
