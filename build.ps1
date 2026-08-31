# Windows wrapper for build-extension.js
# Usage: .\build.ps1 -InputFile fingerprint.json [-OutputDir output\fp-extension] [-ExcludeList exclude-list.json,exclude-financial.json] [-HardblockList hardblock-list.json]
#
# -ExcludeList and -HardblockList each accept multiple comma-separated files
# (no spaces around the comma); they're merged and deduplicated at build time.

param(
    [Parameter(Mandatory = $true)][string]$InputFile,
    [string]$OutputDir = "output/fp-extension",
    [string]$ExcludeList = "exclude-list.json",
    [string]$HardblockList = "hardblock-list.json"
)

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js is required but was not found on PATH. Install it from https://nodejs.org/ and re-run."
    exit 1
}

node src/build-extension.js $InputFile $OutputDir $ExcludeList $HardblockList
