# Consema TypeScript（consema-ts）

![CI](https://img.shields.io/github/actions/workflow/status/consema/consema-ts/ci-typescript.yml?branch=main)
![License](https://img.shields.io/github/license/consema/consema-ts)

Consema 语言中立契约（RFC 0002/0003/0004/0006 契约家族；权威仓
docs/rfcs/）的 **TypeScript 实现**仓库。本仓库是 Consema 六仓
拆分中的 TypeScript 仓：规范权威（RFC、docs、路线图、跨语言 conformance suites）在
[github.com/consema/consema](https://github.com/consema/consema)；本仓承载
TypeScript 实现与跨语言差分验证工具。

Version: 1.0.0-rc.1（`typescript/package.json` version；CI
check-version-consistency job 断言与 README 一致）。

## 快速开始（30 秒跑通）

```text
npm install @consema/consema（当前版本见上方 Version: 行；发布后可用）
```

（上面的命令块不受门禁保护——CI examples job 只比对下方 ```ts 栅栏与入库的
[`typescript/quickstart.ts`](typescript/quickstart.ts)：两侧归一化 CRLF 并 Trim
后必须逐字节一致；命令块为人工同步，按需保持最新。）

下面示例为**人工同步 + 门禁强制**（2026-08-14 对齐波 2 G32 决策；2026-08-15
波 4 R6 升级为 kt 式 fence 比对门禁）：仅保可运行——导入走 `typescript/`
目录内相对路径（仓库内演示；发布后包消费者从 `@consema/consema` 包根导入，
见下方 API 摘要；示例文件本身不随包发布）。同一示例已入库为
`typescript/quickstart.ts`（粘贴版与入库版必须保持一致，由 CI 强制），本地
执行 `cd typescript && node quickstart.ts`（node ≥ 26 原生运行 TS，无需构建；
一个 JSON 文档走完 parse → query → edit → render 四条链）：

```ts
import { integerValue } from './src/core/value.ts';
import { ProfileId } from './src/document/profile.ts';
import { JsonValue } from './src/json/document.ts';
import { commitEdits, EditTransactionBuilder } from './src/json/edit.ts';
import { parseDocument } from './src/registry.ts';

// 原生语义树成员查找（查询助手；完整操作符查询见 sdk_chain 示例）。
function member(value: JsonValue, name: string): JsonValue {
  const members = value.objectMembers();
  if (members.kind !== 'Available' || members.value === null) {
    throw new Error('not an object');
  }
  const m = members.value.find(
    (candidate) => candidate.name().kind === 'Available' && candidate.name().value === name,
  );
  if (m === undefined) throw new Error(`member '${name}' not found`);
  return m.value();
}

const source = new TextEncoder().encode('{"a":1,"b":{"c":2}}');
// 1. parse：json.strict 无损解析，render() 与源字节逐字节一致
const document = parseDocument(source, new ProfileId('json.strict', 1));
const json = document.asJson();
if (typeof json === 'string') throw new Error('not JSON');
// 2. query：原生语义树读 `b.c`
const c = member(member(json.root(), 'b'), 'c');
// 3. edit：`b.c` 语义替换为 42（CanonicalForProfile），编辑外字节原样保留
const transaction = new EditTransactionBuilder(json)
  .semanticScalar(c.nodeRef(), integerValue(42n), 'CanonicalForProfile')
  .build();
const edited = commitEdits(json, transaction).document();
// 4. render：输出 `{"a":1,"b":{"c":42}}`
console.log(new TextDecoder().decode(edited.render()));
```

完整链示例（parse → 操作符式原生语义查询 → best-exact 投影 → 结构编辑 → canonical 物化 → 跨格式转换到 TOML）：[`typescript/examples/sdk_chain.ts`](typescript/examples/sdk_chain.ts)，运行 `cd typescript && node examples/sdk_chain.ts`。

## API 摘要

核心面一行式（签名即 `typescript/src/` 的 tsc 类型面，typedoc 文档构建未接线，见 RELEASING.md §5；八个格式家族各有独立的 `parse*` / `execute*Query` / `project*` / `materialize*` 模块内入口；`convert*` 为根级统一入口，见 `src/convert.ts`，无家族级 convert 导出）。

**包根可导入符号**（`@consema/consema` 直接 import）：`parseDocument` / `Document` / `formatFamilies` / `profiles` / `queryDomains` / `formatOperationRegistry` / `FormatProfile` / `convert*` / `ConversionResult`（以及 core / graph / protocol 域记录）。签名中的类型名分两类（波 4 R23 修正，2026-08-15；`typescript/src/index.ts:20-48` 的 `export *` 面为权威，本段与其一致）：
- **包根 re-export 的类型**（可直接 `import { … } from '@consema/consema'`）：core / graph / protocol 域与 registry / convert facade 声明的类型——`ConversionResult`（convert.ts）、`ConversionFidelity`、`ConversionReport`、`ConsemaDocument`（registry.ts）、`FormatMismatch`、`Document`、`FormatProfile`、`CapabilitySet`（registry_descriptor.ts）、`ProfileDescriptor`、`ContractRegistry`（contract.ts）、`ErrorCodeRegistry`（error_registry.ts）、`RecordState`（records.ts）、`Diagnostic`（diagnostic.ts）、`PortableValue`（core/value.ts）等；
- **包根不 re-export 的类型**：document / json / toml / yaml 等家族模块内的类型名（`ProfileId`、`JsonDocument`、`ProjectionRequest`、`MaterializationRequest`、`JsonQueryResult` 等）不随包根 re-export，且 npm `exports` 仅暴露包根（tarball 只含 dist + LICENSE，见 RELEASING.md §4）——模块内类型**不可从包导入**，实例一律经包根入口获得（如 `profiles()` 返回 `FormatProfile[]`、取其 `.profile()` 得 `ProfileId`）；需要这些概念的注解时用包根 re-export 面的对应类型（W3-43 分列注记，2026-08-14）：

| 操作 | 包根 facade 入口（`@consema/consema` 直接 import） |
| --- | --- |
| parse | `parseDocument(source: Uint8Array, profile) -> Document`（profile 为 `ProfileId` 实例，见上注记） |
| convert | `convertJson(source, projectionRequest, materializationRequest) -> ConversionResult`（另有 convertToml / convertYaml / convertIni / convertProperties / convertXml / convertPlist / convertHcl，签名结构相同；参数类型见上注记） |
| registry | `formatFamilies()` / `profiles()` / `queryDomains()` / `formatOperationRegistry(profile)`（8 家族 / 16 profiles / 21 查询域 / 16 操作注册表） |
| query / project / edit / materialize | **模块内入口**（包根暂不 re-export，1.0.0-rc 不擅自扩导出）：`executeJsonQuery(executable, document, limits, cancellation) -> JsonQueryResult<JsonMatch>`（`src/json/query.ts`）、`project(document, request) -> ProjectionResult`（`src/json/projection.ts`）、`materialize(value, request) -> MaterializationResult<JsonDocument>`（`src/json/materialization.ts`）、`EditTransactionBuilder(document)` + `commitEdits(document, transaction) -> EditCommit`（`src/json/edit.ts`） |

**发布形态。** 包发布编译产物：`prepack` 先清空并重建（`npm run clean` 删 `dist/` 再 tsc → `typescript/dist/`，`.js` + `.d.ts` 同源生成；构建确定性见 RELEASING.md §4），`main`/`types`/`exports` 均指向 `dist/`——消费方无需任何 tsconfig 前置（Node ≥ 26 可直接 import 包根；打包器场景限定为**带 Node 内建模块 polyfill 的常规打包器或 Node 目标构建**——包根导出链使用 `node:crypto`（`typescript/src/protocol/cli.ts`，core.source-patch@2 记录），无 polyfill 的纯浏览器环境解析包根必失败；Node 的类型剥离不作用于 node_modules，源码直发不可行，见 RELEASING.md §4）。发布物含 LICENSE 全文，不含任何 `*.test.ts` 编译产物与
`test_helpers`/`test_decode`（不进构建面，CI 打包门禁按该清单断言）；dev
harness 模块（conformance runner、differential、capability_parity 等）随包
但不经 `exports` 暴露（记录为已知状态，2026-08-14，W3-40/R4）。包根导出链中使用 `node:crypto` 的是 `typescript/src/protocol/cli.ts`（core.source-patch@2 记录，Node 内建模块）；`.d.ts` 自包含、不引用 Node 类型，消费方无需安装 `@types/node`（`typescript` 与 `@types/node` 仅为构建期 devDependencies）。

## 布局

- `typescript/`：TypeScript 包（node 26，`tsc --noEmit` strict，运行时零依赖）。
  消费方文档（npm 包页 README）见 [typescript/README.md](typescript/README.md)；
  开发流程见下方「构建与测试」。
- `scripts/`：跨语言差分验证脚本（byte parity / normalized differential /
  protocol exchange）。脚本构建 consema-rs 的 Rust emitter 并对拍 TypeScript 实现；
  Rust 侧来自 consema-rs 仓 checkout（CI 多仓模式），conformance 数据来自规范仓 checkout。
- `.github/workflows/ci-typescript.yml`：10 个 job——ts-gates（type + 单测 +
  零依赖）、coverage、ts-compiler-matrix、ts-conformance（conformance
  runner 门禁，18 suites / 519 cases）、ts-differential（TS-Rust 差分门禁，
  windows-latest 多仓 checkout）、npm-audit（npm advisory 常设审计）、
  check-version-consistency、examples、ts-package 与聚合门禁 check。

## 构建与测试

前置：`npm test` 包含 conformance runner，按仓库相对路径读
`conformance/vectors/`（数据缺失即 ENOENT 失败，与 CI provision 步骤同源）。
本地运行前在仓库根 provision 数据。**数据源必须钉定**（波 4 R5/R22，2026-08-15；
F2 再锚）：
并排检出规范仓 consema 后，先 checkout 到本仓 CI 钉定的统一 provision commit
（当前 `ccc9943`——ci-typescript.yml / release.yml 各多仓 checkout 的 `ref:`
与此一致；该 commit 的 `docs/fc-manifest-0.13.0.json` 文件 sha256 为
`5cb4ab51…`），再复制——母仓 main 前进（尤其向量变更的 re-vendor 窗口期）后，
按任意 HEAD 取数得到的 conformance 数据与 CI 验证的数据不是同一文件：

```powershell
git -C ..\consema checkout ccc99430a6e3003bc1b0830d81cbad245323f0a4
if (Test-Path .\conformance) { Remove-Item .\conformance -Recurse -Force }
Copy-Item -LiteralPath '..\consema\conformance' -Destination '.\conformance' -Recurse -Force
```

```text
cd typescript
npm ci
npm run check        # tsc --noEmit (strict)
npm test             # node --test "src/**/*.test.ts" (glob form, node 26)
npm run test:differential   # byte parity / normalized / protocol exchange
                            # (byte parity + normalized require the
                            # CONSEMA_DIFFERENTIAL_* golden env vars; protocol
                            # exchange uses CONSEMA_EXCHANGE_*; missing env =
                            # documented skip, never silent)
```

conformance runner 钉定 18 suites / 519 cases 与聚合 digest
`cfd6e296…`（`typescript/src/conformance/runner.ts`，按仓库相对路径读
`conformance/vectors/`）；`runner.test.ts` 断言之，CI ts-conformance job
跑 519/519。

### 编译器线扩展评估（记录，非验证声称）

2026-08-12 曾对 6.0.x / 7.0.x 两条编译器线做一次性本地测量（node 26.7.0 /
npm 11.19.0，过程与 ts-compiler-matrix job 一致：`npm install -D
typescript@<v>` 后 `npm run check`，即 `tsc --noEmit` strict）；该测量未保留
命令输出与复核路径，**不可复算，不作为验证声称**（波 4 R24，2026-08-15；
6.0.x / 7.0.x 不在 CI 矩阵内）。CI 编译面以 ts-compiler-matrix job 为准：
矩阵钉 5.8.3 / 5.9.2 两条腿，且 lockfile 解析版本（当前 5.9.3）经门禁断言
∈ 已验证集（5.8.3 / 5.9.2 / 5.9.3，波 4 R26）。

## FAQ

- **支持哪些配置格式？** 八个格式家族、16 个 profiles：JSON（`json.strict@1` / `jsonc.bounded@1` / `json5.standard@1`）、TOML（`toml.1.0@1`）、YAML（`yaml.1.2-core@1` / `yaml.1.1-compat@1`）、INI（`ini.portable@1` / `ini.windows@1` / `ini.python-configparser@1`）、Java Properties（`java-properties.reader@1` / `java-properties.latin1@1`）、XML（`xml.1.0-safe@1`）、Property List（`plist.xml@1` / `plist.binary@1`）、HCL（`hcl.native@1` / `hcl.tfvars@1`）。完整面枚举见 `profiles()`。
- **与 zod 等 schema 校验库的关系？** 互补而非竞争：zod 做运行时 schema 校验/类型推导，Consema 做格式内容处理（无损文档、查询、投影、原子编辑、跨格式转换）；Consema 明确不做业务 schema 校验（平台接入指南）。
- **性能如何？** 行为一致性由 18 suites / 519 cases conformance 门禁与跨语言差分门禁保证；解析/渲染基准基线见规范仓 [docs/BENCHMARKS-0.13.0.md](https://github.com/consema/consema/blob/main/docs/BENCHMARKS-0.13.0.md) 与 Go 仓 [go/README.md](https://github.com/consema/consema-go/blob/main/go/README.md)。
- **零依赖吗？** 是——运行时零第三方依赖（`typescript` 与 `@types/node` 仅 devDependencies）。
- **跨语言一致性如何保证？** 18 套语言无关 conformance suite 共 519/519 cases（聚合 digest `cfd6e296…`）由规范仓维护、五仓共享；CI 多仓 checkout 跑 conformance runner 与 TS-Rust 差分门禁（byte parity / normalized differential / protocol-exchange）。
- **兼容承诺？** 语义化版本；`check-version-consistency` 门禁断言 README 版本行与 `package.json` 一致；`tsc --noEmit` strict 在 `src/` 全树零诊断（`examples/` 与 `tools_*.mjs` 不在 tsconfig include 内，不经 tsc）；兼容与支持政策见 RFC 0020。
- **如何贡献？** 见本仓 [CONTRIBUTING.md](CONTRIBUTING.md)（规范仓为权威版）；conformance 向量/夹具/oracle/差分数据权威在规范仓——向量变更是五仓同步事件，必须先回规范仓提交再同步五个语言仓。
- **"默认拒绝信息损失"是什么意思？** 投影/转换/编辑中的任何 loss（如 YAML 共享结构展开、Properties 重复键折叠、数值舍入）必须显式授权；未授权时操作原子失败（`ConversionResult` 为 `Failed`；fidelity 三档：Exact / Transformed / Lossy）。

## 六仓导航

| 仓库 | 角色 |
| --- | --- |
| [consema](https://github.com/consema/consema) | 规范 / RFC / 路线图 / 审计证据 / conformance 仲裁层（语言无关权威） |
| [consema-rs](https://github.com/consema/consema-rs) | Rust 参考实现 |
| [consema-go](https://github.com/consema/consema-go) | Go 实现 |
| [consema-ts](https://github.com/consema/consema-ts)（本仓） | TypeScript 实现 |
| [consema-py](https://github.com/consema/consema-py) | Python 实现 |
| [consema-kt](https://github.com/consema/consema-kt) | Kotlin 实现 |

## 文档导航

- 规范仓（RFC / docs / 路线图 / conformance 权威）：https://github.com/consema/consema
- [RFC 0001-0016](https://github.com/consema/consema/tree/main/docs/rfcs) + [RFC 0020 兼容与支持政策](https://github.com/consema/consema/blob/main/docs/rfcs/0020-compatibility-and-support-policy-v1.md)：语言无关规范的权威载体
- [1.0.0 产品路线图](https://github.com/consema/consema/blob/main/Consema%201.0.0%20产品路线图与双语言落地设计.md)
- [平台接入指南](https://github.com/consema/consema/blob/main/docs/platform-integration-guide.md)
- [CLI Cookbook（可复制配方）](https://github.com/consema/consema/blob/main/docs/cookbook.md)
- [多语言实现计划](https://github.com/consema/consema/blob/main/docs/multi-language-implementation-plan.md) / [五语言 CI 设计](https://github.com/consema/consema/blob/main/docs/five-language-ci-design.md)
