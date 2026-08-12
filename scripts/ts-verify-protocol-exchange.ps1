param(
    [string]$CaseFile = '',
    [string]$OutDir = '',
    # consema-rs checkout directory (multi-repo mode); default: <repo root>\consema-rs
    [string]$RustWorkspace = ''
)

# ---------------------------------------------------------------------------
# Cross-language protocol exchange verification — TypeScript side (milestone
# 0.19.0 G5.3; docs/five-language-ci-design.md §3.4; the Go precedent
# scripts/go-verify-protocol-exchange.ps1).
#
# Pipeline (TS never imports or calls Rust, RFC 0016 §1.1):
#   1. builds the minimal Rust exchange example
#      (consema-conformance/examples/emit_protocol_exchange.rs);
#   2. emit mode: runs it over the checked-in case set
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
$workspaceRoot = Split-Path -Parent $PSScriptRoot
$tsDir = Join-Path $workspaceRoot 'typescript'
# The Rust emitter workspace lives in the consema-rs repository checkout
# (multi-repo mode): this repository carries the TypeScript implementation only.
# -RustWorkspace overrides the default sibling checkout <repo root>\consema-rs.
if (-not $RustWorkspace) { $RustWorkspace = Join-Path $workspaceRoot 'consema-rs' }
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
if ($caseCount -lt 40) {
    Write-Error "protocol exchange case file has $caseCount cases, want >= 40"
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
    $OutDir = Join-Path $targetDir 'ts-exchange'
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
$tsExchangeDir = Join-Path $targetDir 'ts-exchange-ts'
$tsExchangeDir = [System.IO.Path]::GetFullPath($tsExchangeDir)
if (Test-Path $tsExchangeDir) { Remove-Item $tsExchangeDir -Recurse -Force }
Write-Host "[3/4] running the TS exchange test (exchange.test.ts) + emitting the TS encoder files -> $tsExchangeDir"
$env:CONSEMA_EXCHANGE_RUST_DIR = $OutDir
$env:CONSEMA_EXCHANGE_TS_DIR = $tsExchangeDir
$logDir = Join-Path $env:TEMP 'consema-ts-exchange'
New-Item -ItemType Directory -Force $logDir | Out-Null
$stdoutFile = Join-Path $logDir 'ts-test.stdout.txt'
$stderrFile = Join-Path $logDir 'ts-test.stderr.txt'
Push-Location $tsDir
try {
    & $node --test 'src\differential\exchange\**\*.test.ts' 1> $stdoutFile 2> $stderrFile
    $testCode = $LASTEXITCODE
}
finally {
    Pop-Location
}
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
& $example --verify $CaseFile $tsExchangeDir 1> $reverseLog 2> $reverseErr
$verifyCode = $LASTEXITCODE
Get-Content $reverseLog | ForEach-Object { Write-Host $_ }
if (Test-Path $reverseErr) {
    Get-Content $reverseErr | ForEach-Object { Write-Host $_ }
}
if ($verifyCode -ne 0) {
    Write-Error "the Rust verify mode found divergences or failed (exit $verifyCode)"
    exit $verifyCode
}
Write-Host "bidirectional protocol exchange verification complete (exit 0)"
exit 0
