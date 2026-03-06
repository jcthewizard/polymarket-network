param(
    [string]$OutputPath = "dist/polymarket-app.zip"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$outputFullPath = Join-Path $repoRoot $OutputPath
$outputDir = Split-Path -Parent $outputFullPath

if (-not (Test-Path $outputDir)) {
    New-Item -ItemType Directory -Path $outputDir | Out-Null
}

if (Test-Path $outputFullPath) {
    Remove-Item $outputFullPath -Force
}

$excludePatterns = @(
    '.git',
    '.github',
    '.venv',
    'venv',
    '__pycache__',
    '.pytest_cache',
    'data',
    'dist',
    '.env'
)

$files = Get-ChildItem -Path $repoRoot -Recurse -File | Where-Object {
    $relativePath = $_.FullName.Substring($repoRoot.Length + 1).Replace('\', '/')

    if ($relativePath -like 'tmp_*.json') {
        return $false
    }

    foreach ($pattern in $excludePatterns) {
        if ($relativePath -eq $pattern -or $relativePath.StartsWith("$pattern/")) {
            return $false
        }
    }

    return $true
}

if (-not $files) {
    throw "No files selected for packaging."
}

$stagingRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("polymarket-package-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $stagingRoot | Out-Null

try {
    foreach ($file in $files) {
        $relativePath = $file.FullName.Substring($repoRoot.Length + 1)
        $destination = Join-Path $stagingRoot $relativePath
        $destinationDir = Split-Path -Parent $destination
        if (-not (Test-Path $destinationDir)) {
            New-Item -ItemType Directory -Path $destinationDir -Force | Out-Null
        }
        Copy-Item $file.FullName $destination
    }

    Compress-Archive -Path (Join-Path $stagingRoot '*') -DestinationPath $outputFullPath -Force
}
finally {
    if (Test-Path $stagingRoot) {
        Remove-Item $stagingRoot -Recurse -Force
    }
}

Write-Host "Created package: $outputFullPath"
