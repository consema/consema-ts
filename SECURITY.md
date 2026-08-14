# Security and resource behavior

安全披露统一走 consema 组织（github.com/consema/consema）的 SECURITY 流程（披露渠道、响应 SLA 与支持窗口以规范仓为权威）；本仓库的安全边界与资源上限语义与规范仓一致，完整内容见下。

Consema 将资源上限作为执行策略，不把截断包装成成功：

- `ParseLimits` 限制 source、nesting、token/piece、node 和 diagnostic；
- `DecodeLimits` 限制 PVCE bytes、depth、nodes、container、integer 和 blob；
- `ProtocolLimits` 同时限制 canonical JSON/PVCE 的 transport bytes、depth、nodes、container、integer 和 blob；
- `QueryLimits` 限制 step 与 result；
- `ProjectionLimits` 限制 value、report、provenance 和 depth；
- `SourceLimits` 限制 raw bytes、decoded UTF-8 bytes 与 scalar/location count；
- `SourcePatchLimits` 限制 result source、replacement count 与 patch bytes。
- `max_number_digits`（默认 100_000，与 HCL number-digits 先例一致）限制 JSON/JSONC/JSON5、YAML 与 TOML 数字字面量的系数位与指数位；检查在 BigInt 转换与尾零剥离之前，超限以 `FatalFormationFailure`（json/yaml，`core.parse.resource-limit@1`）或 `TomlFormationFailure`（kind `ResourceLimit`）失败，core 侧 `decimalValue` 直接构造超限系数同样抛 `PVCEError`（kind `ResourceLimit`）。不崩溃、不静默截断、不回退为字符串。
- `MaterializationLimits` 限制 input nodes/depth、output bytes、report entries 与 provenance entries。

超限分别返回 `FatalFormationFailure`（parse）、`PVCEError`（kind `ResourceLimit`，PVCE/transport decode）、`QueryExecutionFailure`（kind `ResourceLimitExceeded`，query）或 failed projection；每种 typed error 携带冻结注册码（如 `core.pvce.resource-limit@1`、`core.query.resource-limit@1`）。取消不会被报告为完成。

解析器和 decoder 严格检查 UTF‑8、长度溢出、非最短 varint、非规范整数/Decimal、容器计数和嵌套深度（TS 无 `unsafe` 机制——「禁止 unsafe」是 Rust 参考实现侧的约束）。Rust 仓的 hardening 证据（`consema-conformance` 63 个恶意/边界对抗测试：hardening.rs 12 个、yaml_hardening.rs 5 个、line_formats_hardening.rs 6 个、xml_hardening.rs 10 个、xml_encoding_corpus.rs 7 个、plist_hardening.rs 7 个、hcl_hardening.rs 8 个、cli_hardening.rs 8 个；另有 3 个文件 4 个 `proptest!` 块、7 个 property 测试）见 consema-rs 仓 SECURITY.md；本仓对应机制为 conformance 门禁（18 套 / 519 cases，聚合 digest cfd6e296…）、TS-Rust 差分 harness（byte parity / normalized differential / protocol-exchange）与 node --test 测试套件（运行时零第三方依赖）。如果发现崩溃、无界分配或规范绕过，请附最小输入与触发的 capability contract 报告。

canonical protocol JSON 拒绝空白、替代 escape、重排/未知字段和非最短数字表示；PVCE 继续拒绝非规范 varint 与整数。默认协议任意精度整数 magnitude 上限为 1 KiB，避免十进制转换的 CPU 放大；调用方提高上限时必须同时评估输入可信度和工作预算。任何 v1-v7 envelope payload 都会进入对应 typed decoder，不能只靠匹配 `schema` 绕过字段与交叉约束（G162 复核 2026-08-14：分派实现在 typescript/src/protocol/payload_validators.ts（40 个 record validator 自注册）与 typescript/src/protocol/contract.ts（Transport 信封级拒绝），逐记录与 rs payload.rs 分派一致，无 envelope 级记录）。v1-v7 registry 全部冻结（55/62/90/92/132/166/187 code；v7 增量为 additive，语义模型 v6 向量断言的是 v6 发布时点的 v1-v5 冻结——历史快照）；JSON5 专属 diagnostic 从 semantic-model v4 起可外部化（92/132/166/187-code registry 均含对应代码）。

`json5.standard@1` 只实现 Standard JSON5 数据文法，不求值 JavaScript，不执行表达式、import、getter、method、computed key、regex 或模板字符串，也不访问文件与网络。IdentifierStart/Continue 使用宿主 `\p{ID_Start}`/`\p{ID_Continue}` property escapes（Node 26 运行时 Unicode 版本；Rust 侧钉 `unicode-id-start 1.4.0` 表，两表存在版本漂移风险，见 typescript/src/json/parser.ts）。有限数字进入任意精度 Integer/Decimal；只有 `±Infinity`/`±NaN` 进入四种固定 binary64 位模式，有限 binary64 和任意 NaN payload 不能通过 JSON5 文本伪造 exact round-trip。非法 escape/identifier/number/comment 进入 recovery 或 fatal failure，不暴露伪造 native 值。固定 JSON5 v2.2.3 gate（43 valid / 39 invalid / 一个完整真实夹具）与逐字节 mutation/truncation 对抗证据见 consema-rs 仓与规范仓 conformance 层（conformance/corpora/json5-v2.2.3.json）；本仓对应机制为 conformance 门禁的 json-family-v2 套件与 TS-Rust 差分 harness。

`core.source-snapshot@1` 解码时重算 digest、BOM/encoding resolution 与 decoded status；`core.source-patch@1` 解码时检查 replacement order/count/bytes，应用时再次检查 base/original/target/encoding。极端 offset、stale content、非法 UTF 序列和超限输出都在返回新 snapshot 前失败；redaction 只影响 review/debug presentation，不删除应用所需的字节前置条件。

Materialization 在递归与输出分配前计算 input node/depth 和增长上限，并对 report/provenance 独立计数；任一上限、不可表示值、unsupported policy 或 target reparse 失败时，结果中没有 Document 或 partial output。caller string 总由 target Profile 转义，materializer 不执行表达式、不解析 import、不访问文件或网络。

结构事务首先验证 snapshot、role、target/anchor、所有权、冲突、表示能力与资源预算，再构造并重新解析完整 candidate；失败不会改变 base，也不会返回 ChangeSet、proof 或 SourcePatch。`UntouchedByteProof` 覆盖全部且仅覆盖 replacement 外的旧/新字节，并绑定 base/target digest；任何 region、digest 或 target 篡改均失败。dry-run 与 commit 必须产生相同 replacements 和 target digest，但 plan 本身不授权文件写入。

宿主语言（TypeScript）无序列化禁令机制；「raw `NodeRef`、snapshot handle、cursor 与 `CancellationToken` 不可序列化」的约束以 Rust 参考实现的 serde 派生为准。需要 source/node identity 的 Diagnostic、Query、Provenance、ChangeSet、MaterializationResult 和 EditPlan 必须先绑定调用方稳定 locator；缺失绑定会失败，不会省略身份事实后伪造成功。

`toml.1.0@1` 只对完整合法文档形成 snapshot，非法输入返回 `FatalFormationFailure`。`toml-lang/toml-test v2.2.0` 的 205 个 valid 和 474 个 invalid TOML 1.0 decoder cases 由母仓 `scripts/run-toml-test.ps1` 记录（门禁为记录载体：脚本与记录在母仓、无 CI job 执行——六仓拆分后母仓根无 Cargo.toml，脚本在母仓原位不可执行；可执行入口的迁移/重建待总指挥决策，2026-08-14 波 2 处置）；本仓 ci-typescript.yml/release.yml 无运行它的 job，本仓发布路径不含该门禁；上游版本变更必须单独审计。本仓对应机制为 conformance 门禁的 toml-v1 套件（18 套 / 519 cases 之一）与 TS-Rust 差分 harness。semantic edit 不会舍入 NaN payload、亚纳秒时间或非整分钟 offset 来伪造成功。

`xml.1.0-safe@1` 的 formation 只消费调用方提供的完整 document entity bytes，绝不打开外部 DTD、实体、URI、文件、网络连接、registry、classpath 或 catalog，也不提供用户 resolver 回调。DOCTYPE 仅允许 bounded internal subset；外部 subset、外部/参数实体、notation、conditional section 与 validation 声明一律恢复并发布稳定诊断。entity 膨胀按整个文档六维记账（declaration/reference 数量、expansion depth、expanded bytes/scalars、amplification ratio），任何一维突破即恢复；攻击无法把预算拆分到多个引用。内部 subset 注释按字符数据处理，其文本不会触发排除声明误报。UTF-16 输入必须携带 BOM；encoding 声明与实际编码冲突时恢复。恢复文档永不投影、物化或编辑；`xml.safe-canonical-document@1` materialization 对生成字节执行重解析闭包验证，失败返回无目标 Document。结构编辑不接收 raw markup，新内容一律 XML-escape；编辑不猜测或伪造 namespace 声明，unbound/reserved prefix、重复 expanded attribute、ancestor placement 与根删除均在 commit 前失败。XML 语法覆盖包含 37 种细粒度 kind，实体引用与属性部件均可被 lossless query 精确区分。

`plist.xml@1`/`plist.binary@1` 的 formation 只消费调用方提供的完整文档字节，绝不打开外部 DTD、实体、URI、文件或网络连接，不 fetch Apple DTD 或任何 URI，也不读环境/locale 状态或调用应用代码。XML 表示只按声明的 UTF-8/UTF-16 source contract 读取，binary 表示只解析 object table 与 offset-table/trailer 事实，XML 文档永不暴露 binary object/offset/ref/trailer 事实，binary 文档永不暴露文本 token/trivia。date、data 与 integer 不通过字符串降维；object reference、offset 与 size 计算在分配前检查溢出与资源限制。XML/binary 双表示 round-trip 转换对目标表示无法表达的原始事实（UID、Float32 width、未配对 surrogate、分数秒/越界日期等）原子失败并发布 `plist.conversion.inexpressible@1`，不产生部分目标文档。恢复文档永不投影、物化或编辑；`plist.xml-canonical@1`/`plist.binary-canonical@1` materialization 对生成字节执行重解析闭包验证，失败返回无目标 Document。逐字节 mutation/truncation 对抗证据在 consema-rs 仓（plist_hardening.rs，见 consema-rs SECURITY.md）；本仓 plist 编码边界覆盖为 conformance 门禁的 plist-v1 套件（49 cases）与 TS-Rust 差分 harness。

`hcl.native@1`/`hcl.tfvars@1` 的 parse/query/project/edit 全程不求值：无 variable/function/template 求值与展开，`hcl.expression@1` 只承载语法事实、永不执行，无 application schema 与 Terraform/cty 语义。formation 只消费调用方提供的完整文档字节，不访问文件、网络、registry 或环境。表达式/模板/heredoc depth、number digits、item/label/attribute counts 与 recovery regions 等全部尺寸算术在分配前 checked，limit 失败绝不伪装成空 body、截断表达式或缩短查询。恢复文档可查询、不可 project/materialize/commit；`hcl.canonical-document@1` materialization 生成字节必先重解析并逐节点比较闭包语义，失败返回无目标 Document、无 partial bytes、无 partial provenance。对抗门禁覆盖 expression depth、template/heredoc size、number digits、body nesting 与 item counts 的极限输入，验证无 panic、无无界分配。

本仓依赖门禁为 `npm audit`（npm advisory 数据库）：常设 job `npm-audit` 定义在 `.github/workflows/ci-typescript.yml` 内（聚合门禁 check 的一环，红即挡合并），`.github/workflows/audit.yml` 独立 workflow 提供 daily cron 触发同一审计（无 path filter，全量 push/PR 也触发）；任何 advisory（含 low）都使审计 job 变红；运行时零第三方依赖（`package.json` 仅 devDependencies，ci-typescript.yml 零依赖门禁断言）。Rust 仓对应机制（`Cargo.lock`、RustSec `cargo audit`、仓库级 `deny.toml`）见规范仓 consema 的 SECURITY.md。

## 安全披露与支持周期

安全披露、响应时间与支持窗口（路线图 §19.4 的"安全披露联系方式和支持周期"；缺陷等级沿用 §18.4，P0/P1 在 1.0.0 前不允许未解决，P2 必须逐项公开评审）。

**披露渠道。** GitHub 私有漏洞报告当前未启用（2026-08-14 gh api 实测 false）；启用后为首选渠道，启用前首选维护者邮箱 franckcl@icloud.com（GitHub: franckcl1989）。报告请包含：受影响的版本与 Profile/contract、触发问题的 capability contract（如 `core.source-snapshot@1`）、最小复现输入、以及你观察到的行为。发现崩溃、无界分配或规范绕过时，也请携带上述信息报告（见上文 hardening 段）。披露遵循协调披露：收到报告后先确认再公开，不会在修复可用前公开细节；不承诺任何形式的赏金。供应链问题（依赖、SBOM、签名、CI）同样走此渠道。

**响应 SLA（按缺陷等级）。** P0（数据破坏、静默损失、RCE/外部访问、错误写文件、跨快照误编辑）：24 小时内确认，7 天内给出修复或缓解方案。P1（崩溃/未捕获异常/hang、错误完成状态、明显语义不一致、limit bypass）：72 小时内确认，14 天内修复。P2（有安全替代路径的功能缺陷、非核心性能回退、诊断位置错误）：随下一个发布窗口修复，发布判断逐项记录。P3（文档、易用性、非稳定 message、低风险边角）：尽力而为。任何等级都不得用降级测试或截断包装来"修复"；资源上限与完成状态语义是安全边界（见本文档开头部分），不能因披露而放松。

**支持窗口。** 1.0.0 发布前，安全修复只承诺两个窗口：最新稳定版本与其上一 minor（当前版本见 README `Version:` 行（本段避免硬编码版本串）；1.0.0 发布前窗口为当前 rc 与其前 rc/版本——本仓尚无发布 tag，不引用 tag 对象）；更早版本不承诺修复，除非影响面证明必须回移。正式支持的目标是 CI 平台矩阵：9 个 job 在 ubuntu-latest（ts-gates / coverage / ts-compiler-matrix / ts-conformance / npm-audit / check-version-consistency / examples / ts-package / check），TS-Rust 差分门禁 ts-differential 在 windows-latest（多仓 checkout）；Node.js 版本窗口为 `typescript/package.json` `engines` 声明的 `>=26`（CI 钉 node 26.7.0 运行）。Rust 仓的 MSRV 窗口（manifest 声明的 `rust-version`，当前 1.85）与 Go 实现的版本窗口见各自仓库的 SECURITY.md。公共 API 与 CLI 命令的弃用期至少一个 minor；contract/Profile 退役必须走 RFC 进程，已冻结的 v1-v7 registry 永不删除 code（G058 对齐，对抗审计 2026-08-14：旧文 v1-v6 漏 v7），退役只改变新输入的接受行为并在发布记录中列明。
