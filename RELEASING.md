# Consema TypeScript 发布流程（npm）

本文件是 consema-ts 仓库的发布操作手册（六仓统一纪律见 consema 仓库根
`RELEASING.md`）。发布是**半自动**的：版本 bump、CHANGELOG、tag 由人完成；
tag 推送后 `.github/workflows/release.yml` 自动发布 `@consema/consema`
到 npm。

## 1. 发布步骤（人执行的部分）

1. **版本 bump**：改 `typescript/package.json` 的 `version`，同时改仓根
   `README.md` 的 `Version:` 行，并更新
   `.github/ISSUE_TEMPLATE/bug_report.yml` 环境信息段的版本串
   （`check-version-consistency` 门禁断言三处一致：README 版本行、
   bug_report 模板版本串与 package.json version；rc→GA bump 漏任一位置
   即红）。
2. **CHANGELOG 策展**：记录本版本变更；跨语言变更同步到
   consema 仓库根 `CHANGELOG.md`（真实变更记录；`https://github.com/consema/consema/blob/main/docs/CHANGELOG.md` 只是勘误）。
3. **质量门禁全绿**：main 分支 CI `check (all gates green)` 全绿
   （清单见各仓 ci 配置）。
4. **打 tag 并推送**（发布动作的唯一触发点；tag 必须指向 main 历史
   上的 commit，否则 release.yml 的守卫拒绝发布陈旧或分歧代码）：
   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```
   发布 workflow 会先 provision conformance 数据（多仓 checkout 模式，与
   CI 一致；`npm test` 的 conformance runner 按仓库相对路径读
   `conformance/`），再依次执行两个发布守卫：tag 必须指向 origin/main
   历史上的 commit（G71, 2026-08-14；`git merge-base --is-ancestor`
   祖先判定，W3-28——main 在 tag 推送后前进不会拒绝合法 tag）；tag
   去掉 `v` 前缀必须等于
   `typescript/package.json` 的 version（不一致即 exit 1 中止；provision
   步骤在校验之前，与 release.yml 的步骤顺序一致），最后执行
   npm ci / check / test / pack + 干净目录安装 import 冒烟 /
   publish --dry-run / publish。release 路径的 `npm test` 中三个差分测试
   无 Rust emitter 环境、按 documented-skip 执行——差分门禁由 CI
   ts-differential job 覆盖，release 步骤显式披露该跳过（G72）。
   1.0.0-rc.1 是预发布版本：npm 11 要求预发布必须显式 dist-tag，
   release.yml 以 `--tag rc` 发布，消费者安装
   `@consema/consema@rc`；GA 版本（1.0.0）去 `--tag` 走 `latest`
   （波 2 实测发现，2026-08-14）。

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

1.0 前发布**编译产物形态**：`main`/`types`/`exports` 均指向
`typescript/dist/`（`.js` + `.d.ts` 同源生成；`npm pack`/`npm publish`
经 `prepack` 自动构建，`tsc -p tsconfig.build.json`），
`files = ["dist", "LICENSE"]`（LICENSE 由 prepack 从仓根复制进打包目录；
构建面排除 `*.test.ts` 与 `yaml/test_helpers.ts`/`yaml/test_decode.ts`，
tarball 不含任何 `*.test.ts` 编译产物与 `test_helpers`/`test_decode`
（门禁按该清单断言）；dev harness 模块随包但不经 `exports` 暴露
（记录为已知状态，2026-08-14，W3-40/R4））。
选择编译产物而非源码直发的根因：Node 26 的类型剥离机制对 node_modules
下的文件明确拒绝——源码直发包在声明支持窗口（engines `>=26`）内不可从
包根 import（对抗审计 G33, 2026-08-14）。发布前本地验证：`npm pack`
后把 tarball 安装进干净目录并验证包根 import（CI ts-package job 与
release.yml 均有该步骤，G33 常设门禁）。

## 5. API reference 文档（决策：typedoc 待发布时引入）

API reference 的 typedoc 构建**尚未接线**（2026-08-12 决策）：typedoc 不是
devDependency，package.json 也没有 docs 脚本；引入 typedoc 属于依赖改动，
按"发布时引入"处理（与 rustdoc docs.yml artifact job 对标的文档产物在
typedoc 引入后补建 `.github/workflows/docs.yml`）。当前依赖面审计由
`.github/workflows/audit.yml`（npm audit）覆盖。
