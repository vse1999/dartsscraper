$ErrorActionPreference = 'Stop'
$configuration = @{}
Get-Content .env.local | ForEach-Object {
  if ($_ -match '^([^#=]+)=(.*)$') { $configuration[$matches[1]] = $matches[2].Trim('"') }
}
$owner = [long]$configuration['ALLOWED_USER_ID']
$payload = @{
  update_id = [int](Get-Random -Minimum 100000000 -Maximum 2000000000)
  message = @{
    message_id = [int](Get-Random -Minimum 100000 -Maximum 999999)
    date = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    chat = @{ id = $owner; type = 'private' }
    from = @{ id = $owner; is_bot = $false; first_name = 'Owner' }
    text = '/modus today'
    entities = @(@{ offset = 0; length = 6; type = 'bot_command' })
  }
} | ConvertTo-Json -Depth 8 -Compress
$timer = [Diagnostics.Stopwatch]::StartNew()
$response = Invoke-WebRequest -Uri 'https://dartsscraper.vercel.app/api/telegram-webhook' -Method POST -Headers @{ 'x-telegram-bot-api-secret-token' = $configuration['WEBHOOK_SECRET'] } -ContentType 'application/json' -Body $payload
$timer.Stop()
Write-Output "WEBHOOK_STATUS=$($response.StatusCode)"
Write-Output "ACK_MS=$($timer.ElapsedMilliseconds)"
