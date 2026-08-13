param(
    [string]$CaseFile = '',
    [string]$OutDir = '',
    # consema-rs checkout directory (multi-repo mode); default: <repo root>\consema-rs
    [string]$RustWorkspace = ''
)

# ---------------------------------------------------------------------------
# Cross-language normalized-result differential verification — TypeScript
# side (L5 differential harness; https://github.com/consema/consema/blob/main/docs/five-language-ci-design.md §3.3; the Go
# precedent consema-go/scripts/go-verify-normalized-differential.ps1).
#
# Bidirectional pipeline (TS never imports or calls Rust, RFC 0016 §1.1):
#   1. builds the minimal Rust evidence example
#      (consema-conformance/examples/emit_normalized_results.rs);
#   2. forward direction: runs it over the provisioned case set
#      (conformance/differential/normalized/cases.json, the shared
#      single-authority case directory of the consema repository) into
#      <OutDir> as
#      one `<case-id>.txt` normalized-facts file per case;
#   3. forward comparison + reverse emission: runs the TS side
#      (`node --test src/differential/normalized/` with
#      CONSEMA_DIFFERENTIAL_NORMALIZED_RUST_DIR set), which computes the TS
#      normalized results for the same input set and compares them field by
#      field with the Rust evidence files (case id + field + both values on
#      divergence), and emits the TS-side evidence files into the TS
#      evidence directory (CONSEMA_DIFFERENTIAL_NORMALIZED_TS_DIR);
#   4. reverse direction: runs the Rust example's consume mode
#      (`--consume <ts-evidence-dir>`), which recomputes the Rust results
#      and compares them field by field with the TS evidence files.
#
# Any divergence in either direction exits non-zero: forward via the TS
# test, reverse via the consume mode's exit 1.
#
# The compared facts are the language-neutral behavior surface of roadmap
# §11.2: parse formation, diagnostic code/order (never text), query
# count/identity/order, projection/materialization reports, edit result
# bytes or failure codes, and resource-limit completion semantics. A
# divergence is a finding for the roadmap §11.3 process, never a silent
# Rust-side "fix".
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
    $CaseFile = Join-Path $workspaceRoot 'conformance\differential\normalized\cases.json'
}
if (-not (Test-Path $CaseFile)) {
    Write-Error "normalized differential case file not found: $CaseFile"
    exit 1
}
# UTF8 explicit: PowerShell 5.1 Get-Content defaults to the ANSI codepage.
$cases = Get-Content $CaseFile -Raw -Encoding UTF8 | ConvertFrom-Json
$caseCount = @($cases.cases).Count
if ($caseCount -lt 108) {
    Write-Error "normalized differential case file has $caseCount cases, want >= 108"
    exit 1
}

# --- Rust side ---------------------------------------------------------------
$cargo = if ($env:CONSEMA_CARGO) { $env:CONSEMA_CARGO } else { 'cargo' }
if (-not (Get-Command $cargo -ErrorAction SilentlyContinue)) {
    Write-Error "cargo is not available ('$cargo')"
    exit 1
}
Write-Host "[1/4] building the Rust evidence example (emit_normalized_results)..."
# Windows PowerShell 5.1 routes native stderr through the error stream under
# $ErrorActionPreference='Stop'; relax around cargo (its progress lines are
# stderr) and judge success by $LASTEXITCODE only.
$previousEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
Push-Location $RustWorkspace
try {
    & $cargo build --locked -p consema-conformance --example emit_normalized_results
    $buildCode = $LASTEXITCODE
}
finally {
    Pop-Location
}
$ErrorActionPreference = $previousEap
if ($buildCode -ne 0) { exit $buildCode }

$targetDir = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $RustWorkspace 'target' }
$example = Join-Path $targetDir 'debug\examples\emit_normalized_results.exe'
if (-not (Test-Path $example)) {
    Write-Error "Rust example binary not found: $example"
    exit 1
}
if ($OutDir -eq '') {
    $OutDir = Join-Path $targetDir 'ts-differential-normalized'
}
# The env vars are consumed by `node --test` from the package directory, so
# they must be absolute.
$OutDir = [System.IO.Path]::GetFullPath($OutDir)
if (Test-Path $OutDir) { Remove-Item $OutDir -Recurse -Force }
New-Item -ItemType Directory -Force $OutDir | Out-Null

# --- forward direction: Rust emits, TS compares ------------------------------
Write-Host "[2/4] forward: running the Rust example over $caseCount cases -> $OutDir"
& $example $CaseFile $OutDir
if ($LASTEXITCODE -ne 0) {
    Write-Error "emit_normalized_results failed (exit $LASTEXITCODE)"
    exit $LASTEXITCODE
}

# --- TS side: forward comparison + reverse emission ---------------------------
$tsEvidenceDir = Join-Path $targetDir 'ts-differential-normalized-ts'
$tsEvidenceDir = [System.IO.Path]::GetFullPath($tsEvidenceDir)
if (Test-Path $tsEvidenceDir) { Remove-Item $tsEvidenceDir -Recurse -Force }
Write-Host "[3/4] running the TS differential test (normalized.test.ts) + emitting the TS evidence files -> $tsEvidenceDir"
$env:CONSEMA_DIFFERENTIAL_NORMALIZED_RUST_DIR = $OutDir
$env:CONSEMA_DIFFERENTIAL_NORMALIZED_TS_DIR = $tsEvidenceDir
# Capture files live outside $OutDir and $tsEvidenceDir: those directories
# must contain only the `<case-id>.txt` evidence files.
$logDir = Join-Path $env:TEMP 'consema-ts-normalized'
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
    & $node --test 'src\differential\normalized\**\*.test.ts' 1> $stdoutFile 2> $stderrFile
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

# The differential test must have RUN (not skipped) and passed; the TS
# emitter must have RUN too.
$output = Get-Content $stdoutFile -Raw
if ($output -match 'CONSEMA_DIFFERENTIAL_NORMALIZED_RUST_DIR is not set') {
    Write-Error 'the differential test skipped: the Rust evidence directory was not provisioned'
    exit 1
}
if ($output -match 'CONSEMA_DIFFERENTIAL_NORMALIZED_TS_DIR is not set') {
    Write-Error 'the TS evidence emitter skipped: the TS evidence directory was not provisioned'
    exit 1
}
$summary = [regex]::Match($output, 'normalized-result differential: \d+/\d+ equal')
if (-not $summary.Success) {
    Write-Error "the TS differential tests did not pass (node --test exit $testCode)"
    if ($testCode -eq 0) { exit 1 } else { exit $testCode }
}
if ($testCode -ne 0) {
    exit $testCode
}
Write-Host "RESULT (forward): $($summary.Value)"

# --- reverse direction: Rust consumes and compares the TS evidence ------------
Write-Host "[4/4] reverse: running the Rust consume mode against the TS evidence files ($tsEvidenceDir)"
$reverseLog = Join-Path $logDir 'rust-consume.stdout.txt'
$reverseErr = Join-Path $logDir 'rust-consume.stderr.txt'
# Relax EAP around the native consume call (PS 5.1 NativeCommandError on
# redirected stderr), same caveat as the node call above.
$previousEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& $example $CaseFile $OutDir --consume $tsEvidenceDir 1> $reverseLog 2> $reverseErr
$consumeCode = $LASTEXITCODE
$ErrorActionPreference = $previousEap
Get-Content $reverseLog | ForEach-Object { Write-Host $_ }
if (Test-Path $reverseErr) {
    Get-Content $reverseErr | ForEach-Object { Write-Host $_ }
}
if ($consumeCode -ne 0) {
    Write-Error "the Rust consume mode found divergences or failed (exit $consumeCode)"
    exit $consumeCode
}
$reverseSummary = [regex]::Match((Get-Content $reverseLog -Raw), 'reverse normalized-result differential: \d+/\d+ equal')
if ($reverseSummary.Success) {
    Write-Host "RESULT (reverse): $($reverseSummary.Value)"
} else {
    Write-Error 'cannot find the reverse normalized-result differential summary line in the consume-mode output'
    exit 1
}
Write-Host "bidirectional normalized-result differential verification complete (exit 0)"
exit 0
