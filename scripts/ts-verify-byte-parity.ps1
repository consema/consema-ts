param(
    [string]$CaseFile = '',
    [string]$OutDir = '',
    # consema-rs checkout directory (multi-repo mode); default: <repo root>\consema-rs
    [string]$RustWorkspace = ''
)

# ---------------------------------------------------------------------------
# Cross-language PVCE/PGCE byte-parity verification — TypeScript side
# (milestone 0.14.0 G0.5; docs/five-language-ci-design.md §3.2; the Go
# precedent scripts/go-verify-byte-parity.ps1).
#
# Pipeline (TS never imports or calls Rust, RFC 0016 §1.1):
#   1. builds the minimal Rust encoder example
#      (consema-conformance/examples/emit_parity_bytes.rs);
#   2. runs it over the checked-in case set
#      (conformance/differential/cases.json, the shared single-authority
#      case directory of the consema repository) into <OutDir> as one
#      `<case-id>.hex` file per case;
#   3. runs the TS side (`node --test src/differential/parity/` with
#      CONSEMA_DIFFERENTIAL_RUST_DIR set) which compares the TS encode
#      bytes with the Rust byte files and checks the bidirectional
#      direction (Rust bytes -> TS decode -> TS re-encode).
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
    $CaseFile = Join-Path $workspaceRoot 'conformance\differential\cases.json'
}
if (-not (Test-Path $CaseFile)) {
    Write-Error "differential case file not found: $CaseFile"
    exit 1
}
# UTF8 explicit: PowerShell 5.1 Get-Content defaults to the ANSI codepage.
$cases = Get-Content $CaseFile -Raw -Encoding UTF8 | ConvertFrom-Json
$caseCount = @($cases.cases).Count
if ($caseCount -lt 40) {
    Write-Error "differential case file has $caseCount cases, want >= 40"
    exit 1
}

# --- Rust side ---------------------------------------------------------------
$cargo = if ($env:CONSEMA_CARGO) { $env:CONSEMA_CARGO } else { 'cargo' }
if (-not (Get-Command $cargo -ErrorAction SilentlyContinue)) {
    Write-Error "cargo is not available ('$cargo')"
    exit 1
}
Write-Host "[1/3] building the Rust encoder example (emit_parity_bytes)..."
# Windows PowerShell 5.1 routes native stderr through the error stream under
# $ErrorActionPreference='Stop'; relax around cargo (its progress lines are
# stderr) and judge success by $LASTEXITCODE only.
$previousEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
Push-Location $RustWorkspace
try {
    & $cargo build --locked -p consema-conformance --example emit_parity_bytes
    $buildCode = $LASTEXITCODE
}
finally {
    Pop-Location
}
$ErrorActionPreference = $previousEap
if ($buildCode -ne 0) { exit $buildCode }

$targetDir = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $RustWorkspace 'target' }
$example = Join-Path $targetDir 'debug\examples\emit_parity_bytes.exe'
if (-not (Test-Path $example)) {
    Write-Error "Rust example binary not found: $example"
    exit 1
}
if ($OutDir -eq '') {
    $OutDir = Join-Path $targetDir 'ts-differential-parity'
}
# The env var is consumed by the TS test from the package directory, so it
# must be absolute.
$OutDir = [System.IO.Path]::GetFullPath($OutDir)
if (Test-Path $OutDir) { Remove-Item $OutDir -Recurse -Force }
New-Item -ItemType Directory -Force $OutDir | Out-Null

Write-Host "[2/3] running the Rust encoder over $caseCount cases -> $OutDir"
& $example $CaseFile $OutDir
if ($LASTEXITCODE -ne 0) {
    Write-Error "emit_parity_bytes failed (exit $LASTEXITCODE)"
    exit $LASTEXITCODE
}

# --- TS side -----------------------------------------------------------------
Write-Host "[3/3] running the TS differential test (byte_parity.test.ts)..."
$env:CONSEMA_DIFFERENTIAL_RUST_DIR = $OutDir
# Capture files live outside $OutDir: that directory must contain only the
# Rust encoder's `<case-id>.hex` files.
$logDir = Join-Path $env:TEMP 'consema-ts-parity'
New-Item -ItemType Directory -Force $logDir | Out-Null
$stdoutFile = Join-Path $logDir 'ts-test.stdout.txt'
$stderrFile = Join-Path $logDir 'ts-test.stderr.txt'
Push-Location $tsDir
try {
    & $node --test 'src\differential\parity\**\*.test.ts' 1> $stdoutFile 2> $stderrFile
    $testCode = $LASTEXITCODE
}
finally {
    Pop-Location
}
Get-Content $stdoutFile | ForEach-Object { Write-Host $_ }
if (Test-Path $stderrFile) {
    Get-Content $stderrFile | ForEach-Object { Write-Host $_ }
}

# The parity test must have RUN (not skipped) and passed.
$output = Get-Content $stdoutFile -Raw
if ($output -match 'byte parity: 68/68 equal.*# CONSEMA_DIFFERENTIAL_RUST_DIR is not set') {
    Write-Error 'the differential test skipped: the Rust byte directory was not provisioned'
    exit 1
}
$summary = [regex]::Match($output, 'byte parity: \d+/\d+ equal \(\d+ pvce, \d+ pgce\)')
if (-not $summary.Success) {
    Write-Error "the differential test did not pass (node --test exit $testCode)"
    if ($testCode -eq 0) { exit 1 } else { exit $testCode }
}
if ($testCode -ne 0) {
    exit $testCode
}

Write-Host "RESULT: $($summary.Value)"
Write-Host "byte parity verification complete (exit 0)"
exit 0
