param(
    [string]$CaseFile = '',
    [string]$OutDir = '',
    # consema-rs checkout directory (multi-repo mode); default: <repo
    # root>\consema-rs (CI layout) or a sibling consema-rs checkout (G109)
    [string]$RustWorkspace = ''
)

# ---------------------------------------------------------------------------
# Cross-language protocol exchange verification — TypeScript side (L5 differential harness;
# https://github.com/consema/consema/blob/main/docs/five-language-ci-design.md §3.4; the Go precedent
# consema-go/scripts/go-verify-protocol-exchange.ps1).
#
# Pipeline (TS never imports or calls Rust, RFC 0016 §1.1):
#   1. builds the minimal Rust exchange example
#      (consema-conformance/examples/emit_protocol_exchange.rs);
#   2. emit mode: runs it over the provisioned case set
#      (conformance/differential/protocol-exchange/cases.json, the shared
#      single-authority case directory of the consema repository) into
#      <OutDir> as `<case-id>.json.hex` / `<case-id>.pvce.hex` (accept) or
#      `<case-id>.error.txt` (reject);
#   3. runs the TS side (`node --test src/differential/exchange/` with
#      CONSEMA_EXCHANGE_RUST_DIR and CONSEMA_EXCHANGE_TS_DIR set): TS bytes
#      vs the Rust golden bytes on both transports, Rust bytes -> TS typed
#      record decode -> byte-identical re-encode, rejection codes compared,
#      and the TS-side encoder files emitted;
#   4. verify mode: re-runs the Rust example with `--verify` over the TS
#      encoder files, closing the TS-encode -> Rust-decode direction.
#
# Any divergence in either direction exits non-zero. A divergence is a
# finding for the roadmap §11.3 process, never a silent Rust-side "fix".
#
# Requirements: cargo (or $env:CONSEMA_CARGO) and node (or $env:CONSEMA_NODE)
# on PATH; the Rust workspace is the consema-rs checkout (<repo root>\consema-rs
# by default, -RustWorkspace overrides). Windows PowerShell 5.1 compatible, no
# third-party dependencies.
# ---------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'
# Per-invocation unique directory suffix (G44, 2026-08-14): a fixed shared
# capture/evidence/output/workDir path would let two concurrent runs
# truncate or interleave each other's files and flip the SKIPPED/PASSED
# verdicts; every default TEMP/target path below carries this nonce.
$nonce = [Guid]::NewGuid().ToString('N')
$workspaceRoot = Split-Path -Parent $PSScriptRoot
$tsDir = Join-Path $workspaceRoot 'typescript'
# The Rust emitter workspace lives in the consema-rs repository checkout
# (multi-repo mode): this repository carries the TypeScript implementation only.
# Default resolution (G109, adversarial audit 2026-08-13 — the old default
# only matched the CI nested layout): <repo root>\consema-rs (CI) first,
# then a sibling consema-rs checkout; -RustWorkspace overrides either.
if (-not $RustWorkspace) {
    $nested = Join-Path $workspaceRoot 'consema-rs'
    $sibling = Join-Path (Split-Path -Parent $workspaceRoot) 'consema-rs'
    if (Test-Path (Join-Path $nested 'Cargo.toml')) {
        $RustWorkspace = $nested
    }
    elseif (Test-Path (Join-Path $sibling 'Cargo.toml')) {
        $RustWorkspace = $sibling
    }
    else {
        Write-Error "consema-rs checkout not found: tried $nested (CI multi-repo mode) and $sibling (side-by-side layout); pass -RustWorkspace explicitly"
        exit 1
    }
}
$RustWorkspace = [IO.Path]::GetFullPath($RustWorkspace)

# --- repo layout sanity ------------------------------------------------------
if (-not (Test-Path (Join-Path $RustWorkspace 'Cargo.toml')) -or
    -not (Test-Path (Join-Path $RustWorkspace 'consema-conformance\Cargo.toml'))) {
    Write-Error "consema-rs workspace not found: $RustWorkspace (checkout consema/consema-rs beside this repository, or pass -RustWorkspace)"
    exit 1
}
if (-not (Test-Path (Join-Path $tsDir 'package.json'))) {
    Write-Error "TypeScript package not found: $tsDir"
    exit 1
}
$node = if ($env:CONSEMA_NODE) { $env:CONSEMA_NODE } else { 'node' }
if (-not (Get-Command $node -ErrorAction SilentlyContinue)) {
    Write-Error "node is not on PATH ('$node')"
    exit 1
}

# --- case set ----------------------------------------------------------------
if ($CaseFile -eq '') {
    $CaseFile = Join-Path $workspaceRoot 'conformance\differential\protocol-exchange\cases.json'
}
if (-not (Test-Path $CaseFile)) {
    Write-Error "protocol exchange case file not found: $CaseFile"
    exit 1
}
# UTF8 explicit: PowerShell 5.1 Get-Content defaults to the ANSI codepage.
$cases = Get-Content $CaseFile -Raw -Encoding UTF8 | ConvertFrom-Json
$caseCount = @($cases.cases).Count
if ($caseCount -ne 83) {
    Write-Error "protocol exchange case file has $caseCount cases, want exactly 83 (frozen count, G66)"
    exit 1
}

# --- Rust side ---------------------------------------------------------------
$cargo = if ($env:CONSEMA_CARGO) { $env:CONSEMA_CARGO } else { 'cargo' }
if (-not (Get-Command $cargo -ErrorAction SilentlyContinue)) {
    Write-Error "cargo is not available ('$cargo')"
    exit 1
}
Write-Host "[1/4] building the Rust exchange example (emit_protocol_exchange)..."
# Windows PowerShell 5.1 routes native stderr through the error stream under
# $ErrorActionPreference='Stop'; relax around cargo (its progress lines are
# stderr) and judge success by $LASTEXITCODE only.
$previousEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
Push-Location $RustWorkspace
try {
    & $cargo build --locked -p consema-conformance --example emit_protocol_exchange
    $buildCode = $LASTEXITCODE
}
finally {
    Pop-Location
}
$ErrorActionPreference = $previousEap
if ($buildCode -ne 0) { exit $buildCode }

$targetDir = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $RustWorkspace 'target' }
$example = Join-Path $targetDir 'debug\examples\emit_protocol_exchange.exe'
if (-not (Test-Path $example)) {
    Write-Error "Rust example binary not found: $example"
    exit 1
}
if ($OutDir -eq '') {
    $OutDir = Join-Path $targetDir "ts-exchange-$nonce"
}
# The env vars are consumed by `node --test` from the package directory, so
# they must be absolute.
$OutDir = [System.IO.Path]::GetFullPath($OutDir)
if (Test-Path $OutDir) { Remove-Item $OutDir -Recurse -Force }
New-Item -ItemType Directory -Force $OutDir | Out-Null

# --- forward direction: Rust emits, TS compares -------------------------------
Write-Host "[2/4] running the Rust example over $caseCount cases -> $OutDir"
& $example $CaseFile $OutDir
if ($LASTEXITCODE -ne 0) {
    Write-Error "emit_protocol_exchange failed (exit $LASTEXITCODE)"
    exit $LASTEXITCODE
}

# --- TS side: forward comparison + reverse emission ---------------------------
$tsExchangeDir = Join-Path $targetDir "ts-exchange-ts-$nonce"
$tsExchangeDir = [System.IO.Path]::GetFullPath($tsExchangeDir)
if (Test-Path $tsExchangeDir) { Remove-Item $tsExchangeDir -Recurse -Force }
Write-Host "[3/4] running the TS exchange test (exchange.test.ts) + emitting the TS encoder files -> $tsExchangeDir"
$env:CONSEMA_EXCHANGE_RUST_DIR = $OutDir
$env:CONSEMA_EXCHANGE_TS_DIR = $tsExchangeDir
$logDir = Join-Path $env:TEMP "consema-ts-exchange-$nonce"
New-Item -ItemType Directory -Force $logDir | Out-Null
$stdoutFile = Join-Path $logDir 'ts-test.stdout.txt'
$stderrFile = Join-Path $logDir 'ts-test.stderr.txt'
# Same PS 5.1 caveat as the cargo call: under $ErrorActionPreference='Stop'
# a native command writing to stderr through a file redirect raises a
# terminating NativeCommandError — exactly when we want to capture the
# diagnostics. Relax around the node call and judge success by
# $LASTEXITCODE only.
$previousEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
Push-Location $tsDir
try {
    & $node --test 'src\differential\exchange\**\*.test.ts' 1> $stdoutFile 2> $stderrFile
    $testCode = $LASTEXITCODE
}
finally {
    Pop-Location
}
$ErrorActionPreference = $previousEap
Get-Content $stdoutFile | ForEach-Object { Write-Host $_ }
if (Test-Path $stderrFile) {
    Get-Content $stderrFile | ForEach-Object { Write-Host $_ }
}

# The exchange test must have RUN (not skipped) and passed; the TS emitter
# must have RUN too.
$output = Get-Content $stdoutFile -Raw
if ($output -match 'CONSEMA_EXCHANGE_RUST_DIR is not set') {
    Write-Error 'the exchange test skipped: the Rust exchange directory was not provisioned'
    exit 1
}
if ($output -match 'CONSEMA_EXCHANGE_TS_DIR is not set') {
    Write-Error 'the TS emitter skipped: the TS exchange directory was not provisioned'
    exit 1
}
$summary = [regex]::Match($output, 'protocol exchange: \d+/\d+ accept cases and \d+/\d+ reject cases verified')
if (-not $summary.Success) {
    Write-Error "the TS exchange tests did not pass (node --test exit $testCode)"
    if ($testCode -eq 0) { exit 1 } else { exit $testCode }
}
if ($testCode -ne 0) {
    Write-Error 'protocol exchange divergences found (forward): see the DIVERGENCE lines above'
    exit $testCode
}
Write-Host "RESULT (forward): $($summary.Value)"

# --- reverse direction: Rust verifies the TS encoder files --------------------
Write-Host "[4/4] reverse: running the Rust verify mode against the TS encoder files ($tsExchangeDir)"
$reverseLog = Join-Path $logDir 'rust-verify.stdout.txt'
$reverseErr = Join-Path $logDir 'rust-verify.stderr.txt'
# Relax EAP around the native verify call (PS 5.1 NativeCommandError on
# redirected stderr), same caveat as the node call above.
$previousEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& $example --verify $CaseFile $tsExchangeDir 1> $reverseLog 2> $reverseErr
$verifyCode = $LASTEXITCODE
$ErrorActionPreference = $previousEap
Get-Content $reverseLog | ForEach-Object { Write-Host $_ }
if (Test-Path $reverseErr) {
    Get-Content $reverseErr | ForEach-Object { Write-Host $_ }
}
if ($verifyCode -ne 0) {
    Write-Error "the Rust verify mode found divergences or failed (exit $verifyCode)"
    exit $verifyCode
}
# The reverse leg must not be an exit-code-only assertion: the Rust verify
# mode prints a per-run summary ('emit_protocol_exchange (verify): N accept
# cases and M reject cases verified into <dir>', consema-rs
# emit_protocol_exchange.rs), and an exit 0 from a broken entry that never
# ran the verification would silently pass. Assert the summary line in the
# captured log (same strength as the forward leg and as the normalized
# harness's reverse leg, R47, 2026-08-15).
$reverseSummary = [regex]::Match((Get-Content $reverseLog -Raw), 'emit_protocol_exchange \(verify\): \d+ accept cases and \d+ reject cases verified')
if ($reverseSummary.Success) {
    Write-Host "RESULT (reverse): $($reverseSummary.Value)"
}
else {
    Write-Error 'cannot find the Rust verify-mode summary line (emit_protocol_exchange (verify): N accept cases and M reject cases verified) in the verify output'
    exit 1
}
Write-Host "bidirectional protocol exchange verification complete (exit 0)"
exit 0
