param(
  [string]$Model = "gemma4:12b",
  [int]$ChatPort = 3210
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ollamaUrl = "http://127.0.0.1:11434"
$chatUrl = "http://127.0.0.1:$ChatPort"

function Test-HttpEndpoint {
  param([Parameter(Mandatory = $true)][string]$Uri)
  try {
    $null = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 2
    return $true
  } catch {
    return $false
  }
}

function Wait-ForHttpEndpoint {
  param(
    [Parameter(Mandatory = $true)][string]$Uri,
    [int]$Attempts = 30
  )
  for ($attempt = 1; $attempt -le $Attempts; $attempt += 1) {
    if (Test-HttpEndpoint -Uri $Uri) {
      return
    }
    Start-Sleep -Seconds 1
  }
  throw "Timed out waiting for $Uri."
}

Set-Location -LiteralPath $projectRoot
$ollamaCommand = Get-Command ollama -ErrorAction SilentlyContinue
if ($null -eq $ollamaCommand) {
  throw "Ollama is not installed or is not on PATH. Install Ollama, then run this file again."
}

if (-not (Test-HttpEndpoint -Uri "$ollamaUrl/api/tags")) {
  Write-Host "Starting Ollama..."
  Start-Process -FilePath $ollamaCommand.Source -ArgumentList @("serve") -WindowStyle Hidden | Out-Null
  Wait-ForHttpEndpoint -Uri "$ollamaUrl/api/tags"
}

$tags = Invoke-RestMethod -Uri "$ollamaUrl/api/tags" -TimeoutSec 5
$modelExists = @($tags.models | Where-Object { $_.name -eq $Model }).Count -gt 0
if (-not $modelExists) {
  Write-Host "Downloading $Model (first run only)..."
  & $ollamaCommand.Source pull $Model
  if ($LASTEXITCODE -ne 0) {
    throw "Ollama could not download $Model."
  }
}

$chatProcess = $null
if (-not (Test-HttpEndpoint -Uri $chatUrl)) {
  $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if ($null -eq $npmCommand) {
    throw "npm.cmd was not found. Install Node.js, then run this file again."
  }
  Write-Host "Starting the local chatbot..."
  $chatProcess = Start-Process -FilePath $npmCommand.Source -ArgumentList @("run", "chat") -WorkingDirectory $projectRoot -PassThru
  Wait-ForHttpEndpoint -Uri $chatUrl
}

Start-Process -FilePath $chatUrl | Out-Null
Write-Host "Chatbot ready: $chatUrl"
Write-Host "Ask: today MODUS all matches and player averages"
Write-Host "Close the chatbot terminal or press Ctrl+C there to stop."

if ($null -ne $chatProcess) {
  Wait-Process -Id $chatProcess.Id
}
