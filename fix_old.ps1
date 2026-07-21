$KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzd3Bnbm5lZHF2dWVnd2ZicHJkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODcyNzQ2MSwiZXhwIjoyMDk0MzAzNDYxfQ.gkgIKEqBXtUMz9op1Q9nUnvIZVA4KOsdycQoAAigE4U'
$body = '{"replenish_status":"厂家断货","remark":"已逾1个月未到货，标记为厂家断货"}'
$headers = @{
    "apikey" = $KEY
    "Authorization" = "Bearer $KEY"
    "Content-Type" = "application/json"
    "Prefer" = "return=representation"
}
$url = 'https://qswpgnnedqvuegwfbprd.supabase.co/rest/v1/reports?product_code=eq.1110101&created_at=lt.2026-06-01'
$resp = Invoke-RestMethod -Uri $url -Method Patch -Headers $headers -Body $body
$resp | ConvertTo-Json -Depth 3
