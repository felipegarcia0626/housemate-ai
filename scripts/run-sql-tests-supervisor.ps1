[CmdletBinding()]
param(
  [switch]$SelfTest,
  [switch]$CrashProbe,
  [string]$CrashProbeStatus,
  [switch]$SignalProbe,
  [string]$SignalProbeMode,
  [int]$SignalTimeoutMilliseconds = 30000,
  [int]$SignalGracefulMilliseconds = 1000,
  [int]$SignalTerminationMilliseconds = 5000,
  [switch]$SignalProbeChild,
  [switch]$IgnoreCtrlBreak
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$nativeSource = Join-Path $PSScriptRoot 'sql-test-job-supervisor.cs'
$powershellPath = Join-Path $PSHOME 'powershell.exe'

if ($SignalProbeChild) {
  [Console]::WriteLine('[sql-supervisor-test] signal-child-before-add-type')
}
try {
  Add-Type -Path $nativeSource -ErrorAction Stop
} catch {
  [Console]::Error.WriteLine('[sql-supervisor] Native helper compilation failed: ' + $_.Exception.Message)
  exit 1
}

if ($SignalProbeChild) {
  [Console]::WriteLine('[sql-supervisor-test] signal-child-after-add-type')
  [HouseMateAi.SqlTest.Supervisor]::RunSignalProbeChild([bool]$IgnoreCtrlBreak)
  exit 0
}

if ($SelfTest) {
  try {
    [HouseMateAi.SqlTest.Supervisor]::RunSelfTests($PSCommandPath, $powershellPath)
    exit 0
  } catch {
    [Console]::Error.WriteLine('[sql-supervisor-test] FAIL: ' + $_.Exception.ToString())
    exit 1
  }
}

if ($SignalProbe) {
  $probeRoot = $null
  try {
    $probeRoot = [HouseMateAi.SqlTest.Supervisor]::CreateOwnedTempRoot()
    [Console]::WriteLine('[sql-supervisor-test] signal-probe-root=' + $probeRoot)
    $result = [HouseMateAi.SqlTest.Supervisor]::RunSignalProbe(
      $PSCommandPath,
      $powershellPath,
      $probeRoot,
      [bool]($SignalProbeMode -eq 'ignore'),
      $SignalTimeoutMilliseconds,
      $SignalGracefulMilliseconds,
      $SignalTerminationMilliseconds
    )
    [Console]::WriteLine('[sql-supervisor-test] signal-probe-result detail=' + $result.Detail +
      ' job_empty=' + $result.JobEmptyConfirmed + ' cleanup_safe=' + $result.CleanupSafe +
      ' forced=' + $result.Forced + ' exit_code=' + $result.ExitCode)
    if ($result.CleanupSafe) {
      $removed = [HouseMateAi.SqlTest.Supervisor]::TryDeleteOwnedRoot(
        $probeRoot,
        $result.CleanupSafe,
        $result.TerminalClose
      )
      if (-not $removed) {
        throw 'The signal probe could not remove its root after confirming an empty Job.'
      }
      [Console]::WriteLine('[sql-supervisor-test] signal-probe-root-removed job_empty_confirmed=true')
    } else {
      [Console]::Error.WriteLine('[sql-supervisor-test] signal-probe-root-retained path=' + $probeRoot)
    }
    exit [int]$result.ExitCode
  } catch {
    [Console]::Error.WriteLine('[sql-supervisor-test] signal probe failed: ' + $_.Exception.Message)
    exit 1
  }
}

if ($CrashProbe) {
  if ([string]::IsNullOrWhiteSpace($CrashProbeStatus)) {
    [Console]::Error.WriteLine('[sql-supervisor-test] Crash probe status path is required.')
    exit 2
  }
  try {
    [HouseMateAi.SqlTest.Supervisor]::CrashProbe($CrashProbeStatus)
    exit 1
  } catch {
    [Console]::Error.WriteLine('[sql-supervisor-test] Crash probe failed: ' + $_.Exception.Message)
    exit 1
  }
}

$temporaryRoot = $null
$launchAttempted = $false
$exitCode = 1
try {
  if (-not (Test-Path -LiteralPath $powershellPath -PathType Leaf)) {
    throw 'Windows PowerShell 5.1 executable was not found.'
  }

  $commandProcessor = [HouseMateAi.SqlTest.Supervisor]::GetSystemCommandProcessor()

  $npmCommand = Get-Command 'npm.cmd' -CommandType Application -ErrorAction Stop |
    Select-Object -First 1
  $npmPath = $npmCommand.Source
  if ([string]::IsNullOrWhiteSpace($npmPath) -or
      -not [IO.Path]::IsPathRooted($npmPath) -or
      -not (Test-Path -LiteralPath $npmPath -PathType Leaf)) {
    throw 'npm.cmd did not resolve to an absolute file path.'
  }

  $temporaryRoot = [HouseMateAi.SqlTest.Supervisor]::CreateOwnedTempRoot()
  [Console]::WriteLine('[sql-supervisor] temp-root=' + $temporaryRoot)
  # Worker stdin is NUL. The launcher signal pipe belongs to this supervisor.
  $commandText = '"' + $npmPath + '" run test:sql:worker'
  $commandArguments = '/d /s /c "' + $commandText + '"'
  $launchAttempted = $true

  $result = [HouseMateAi.SqlTest.Supervisor]::Run(
    $commandProcessor,
    $commandArguments,
    $repositoryRoot,
    $temporaryRoot,
    1800000,
    15000,
    15000,
    $true
  )

  if ($result.CleanupSafe) {
    $removed = [HouseMateAi.SqlTest.Supervisor]::TryDeleteOwnedRoot(
      $temporaryRoot,
      $result.CleanupSafe,
      $result.TerminalClose
    )
    if (-not $removed) {
      throw 'The supervisor could not confirm removal of its temporary root.'
    }
    [Console]::WriteLine('[sql-supervisor] temp-root-removed')
  } else {
    [Console]::Error.WriteLine('[sql-supervisor] temp-root-retained path=' + $temporaryRoot)
    if ($result.ExitCode -eq 0) { $result.ExitCode = 1 }
  }

  $exitCode = [int]$result.ExitCode
} catch {
  [Console]::Error.WriteLine('[sql-supervisor] FAIL: ' + $_.Exception.Message)
  if ($temporaryRoot -and -not $launchAttempted) {
    try {
      $removed = [HouseMateAi.SqlTest.Supervisor]::TryDeleteOwnedRoot($temporaryRoot, $true, $false)
      if ($removed) {
        [Console]::WriteLine('[sql-supervisor] temp-root-removed-before-launch')
      } else {
        [Console]::Error.WriteLine('[sql-supervisor] temp-root-retained path=' + $temporaryRoot)
      }
    } catch {
      [Console]::Error.WriteLine('[sql-supervisor] pre-launch cleanup failed; root retained path=' + $temporaryRoot)
    }
  } elseif ($temporaryRoot) {
    [Console]::Error.WriteLine('[sql-supervisor] launch outcome uncertain; temp-root-retained path=' + $temporaryRoot)
  }
  $exitCode = 1
}

exit $exitCode
