[CmdletBinding()]
param(
    [string[]]$Natives = @('rmsd.exe', 'rms-ls.exe', 'rms-test.exe')
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$releaseRoot = Join-Path $repositoryRoot 'target/release'
$destinationRoot = Join-Path $repositoryRoot 'apps/desktop/native'

if (-not $destinationRoot.StartsWith($repositoryRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Native staging path escaped the repository.'
}

$Natives = @($Natives | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
foreach ($name in $Natives) {
    if (@('rmsd.exe', 'rms-ls.exe', 'rms-test.exe') -notcontains $name) {
        throw "Unknown native executable: $name"
    }
}

New-Item -ItemType Directory -Force -Path $destinationRoot | Out-Null
Get-ChildItem -LiteralPath $destinationRoot -Filter '*.exe' -File |
    Where-Object { $Natives -notcontains $_.Name } |
    Remove-Item -Force

foreach ($name in $Natives) {
    $source = Join-Path $releaseRoot $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Release native executable is missing: $name"
    }
    Copy-Item -LiteralPath $source -Destination (Join-Path $destinationRoot $name) -Force
}
Write-Output "Staged release native executables for Electron Forge: $($Natives -join ', ')."

$noticesPath = Join-Path $repositoryRoot 'target/package-notices/THIRD-PARTY-NOTICES.txt'
& node (Join-Path $repositoryRoot 'tools/third-party-notices.mjs') --natives ($Natives -join ',') --output $noticesPath
if ($LASTEXITCODE -ne 0) {
    throw 'Writing the third-party notices failed.'
}
