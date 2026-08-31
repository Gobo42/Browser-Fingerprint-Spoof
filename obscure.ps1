# Windows wrapper for obscure-fingerprint.js
# Usage: .\obscure.ps1 -InputFile fingerprint.json [-OutputFile fingerprint.json] [-Seed 12345]

param(
    [Parameter(Mandatory = $true)][string]$InputFile,
    [string]$OutputFile = $InputFile,
    [int]$Seed
)

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js is required but was not found on PATH. Install it from https://nodejs.org/ and re-run."
    exit 1
}

if ($PSBoundParameters.ContainsKey('Seed')) {
    # [int]$Seed defaults to 0 when unspecified, and 0 is falsy in
    # PowerShell, so checking truthiness here would make "-Seed 0"
    # indistinguishable from omitting -Seed entirely. Checking whether it
    # was actually passed avoids that.
    node src/obscure-fingerprint.js $InputFile $OutputFile "--seed=$Seed"
} else {
    node src/obscure-fingerprint.js $InputFile $OutputFile
}
