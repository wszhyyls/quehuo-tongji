param(
  [string]$SupabaseUrl = "https://qswpgnnedqvuegwfbprd.supabase.co",
  [string]$SupabaseAnonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzd3Bnbm5lZHF2dWVnd2ZicHJkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg3Mjc0NjEsImV4cCI6MjA5NDMwMzQ2MX0.mY_nlWoHc5UYDHB9jOif0zkYJ2OVx79KTgejcSGkhBI",
  [string]$DeviceId = "dev_test_001_$(Get-Random -Minimum 1000 -Maximum 9999)",
  [string]$EmployeePhone = "15305479520",
  [string]$EmployeePassword = "123456",
  [string]$AdminUsername = "admin",
  [string]$AdminPassword = "wszh123456"
)

function Invoke-EdgeFunction {
  param(
    [Parameter(Mandatory=$true)][string]$Path,
    [Parameter(Mandatory=$true)][hashtable]$Body,
    [Parameter(Mandatory=$false)][string]$AccessToken = ""
  )

  $url = "$SupabaseUrl$Path"

  # Supabase edge requires apikey header for many setups
  $headers = @{
    "Content-Type" = "application/json"
    "apikey" = $SupabaseAnonKey
  }

  if ($AccessToken -and $AccessToken.Trim().Length -gt 0) {
    $headers["Authorization"] = "Bearer $AccessToken"
  }

  $json = $Body | ConvertTo-Json -Depth 30 -Compress

  # Print full response body; also capture status via catch (PS doesn't always expose status)
  $resp = Invoke-RestMethod -Method POST -Uri $url -Headers $headers -Body $json -ErrorAction Stop
  return $resp
}

function Invoke-EdgeFunctionRaw {
  param(
    [Parameter(Mandatory=$true)][string]$Path,
    [Parameter(Mandatory=$true)][hashtable]$Body,
    [Parameter(Mandatory=$false)][string]$AccessToken = ""
  )

  $url = "$SupabaseUrl$Path"
  $headers = @{
    "Content-Type" = "application/json"
    "apikey" = $SupabaseAnonKey
  }
  if ($AccessToken -and $AccessToken.Trim().Length -gt 0) {
    $headers["Authorization"] = "Bearer $AccessToken"
  }

  $json = $Body | ConvertTo-Json -Depth 30 -Compress

  # Use Invoke-WebRequest to get status code and raw body
  $result = Invoke-WebRequest -Method POST -Uri $url -Headers $headers -Body $json -ContentType "application/json" -ErrorAction Stop
  $text = $result.Content
  try { $parsed = $text | ConvertFrom-Json } catch { $parsed = $text }
  return @{
    statusCode = [int]$result.StatusCode
    raw = $text
    parsed = $parsed
  }
}

function Try-Call {
  param(
    [Parameter(Mandatory=$true)][string]$Name,
    [Parameter(Mandatory=$true)][scriptblock]$CallBlock
  )
  try {
    $r = & $CallBlock
    return @{
      ok = $true
      result = $r
    }
  } catch {
    # Try to extract status code/body from exception
    $errMsg = $_.Exception.Message
    $webResp = $_.Exception.Response
    return @{
      ok = $false
      error = $errMsg
      httpStatus = "unknown"
      raw = $webResp
    }
  }
}

$results = @{}
$accessToken = ""

# 1) 员工登录（触发设备授权链路）
$employee_login = Try-Call -Name "employee_login_initial" -CallBlock {
  $body = @{
    action = "store_login"
    params = @{
      username = $EmployeePhone
      password = $EmployeePassword
      device_id = $DeviceId
    }
  }
  $res = Invoke-EdgeFunctionRaw -Path "/functions/v1/query-shortage-data" -Body $body
  $res.parsed | Out-Null

  # If success, extract access_token for later actions
  if ($res.parsed -and $res.parsed.data -and $res.parsed.data.session -and $res.parsed.data.session.access_token) {
    $script:accessToken = $res.parsed.data.session.access_token
  }
  return $res
}
$results["employee_login_initial"] = $employee_login

$pendingDeviceId = $null
$pendingEmployeeId = $null
if ($employee_login.ok -and $employee_login.result.parsed -and $employee_login.result.parsed.data) {
  if ($employee_login.result.parsed.data.pending_device_id) { $pendingDeviceId = $employee_login.result.parsed.data.pending_device_id }
  if ($employee_login.result.parsed.data.pending_employee_id) { $pendingEmployeeId = $employee_login.result.parsed.data.pending_employee_id }
}

# 2) 管理员登录（用于授权设备）
$admin_login = Try-Call -Name "admin_login" -CallBlock {
  $adminDevice = "admin_dev_test_001_$(Get-Random -Minimum 1000 -Maximum 9999)"
  $body = @{
    action = "store_login"
    params = @{
      username = $AdminUsername
      password = $AdminPassword
      device_id = $adminDevice
    }
  }
  $res = Invoke-EdgeFunctionRaw -Path "/functions/v1/query-shortage-data" -Body $body
  # extract token too
  if ($res.parsed -and $res.parsed.data -and $res.parsed.data.session -and $res.parsed.data.session.access_token) {
    # not used elsewhere, but could be
  }
  return $res
}
$results["admin_login"] = $admin_login

# 3) 若员工设备未授权，则由管理员调用 authorize_device 授权
if ($pendingDeviceId) {
  $authorize = Try-Call -Name "authorize_device_employee" -CallBlock {
    $body = @{
      action = "authorize_device"
      params = @{
        device_id = $pendingDeviceId
        target_type = "employee"
        target_id = $pendingEmployeeId
        authorize = $true
      }
    }
    return (Invoke-EdgeFunctionRaw -Path "/functions/v1/query-shortage-data" -Body $body)
  }
  $results["authorize_device_employee"] = $authorize
} else {
  $results["authorize_device_employee"] = @{ ok = $false; error = "pending_device_id is null (employee device already authorized?)" }
}

# 4) 重试员工登录
$deviceForRetry = if ($pendingDeviceId) { $pendingDeviceId } else { $DeviceId }
$employee_login_after_authorize = Try-Call -Name "employee_login_after_authorize" -CallBlock {
  $body = @{
    action = "store_login"
    params = @{
      username = $EmployeePhone
      password = $EmployeePassword
      device_id = $deviceForRetry
    }
  }
  $res = Invoke-EdgeFunctionRaw -Path "/functions/v1/query-shortage-data" -Body $body
  if ($res.parsed -and $res.parsed.data -and $res.parsed.data.session -and $res.parsed.data.session.access_token) {
    $script:accessToken = $res.parsed.data.session.access_token
  }
  return $res
}
$results["employee_login_after_authorize"] = $employee_login_after_authorize

# 5) 获取同步元数据
$get_sync_metadata = Try-Call -Name "get_sync_metadata" -CallBlock {
  $body = @{
    action = "get_sync_metadata"
    params = @{}
  }
  return (Invoke-EdgeFunctionRaw -Path "/functions/v1/query-shortage-data" -Body $body)
}
$results["get_sync_metadata"] = $get_sync_metadata

# 6) 库存增量同步
$sync_inventory_incremental = Try-Call -Name "sync_inventory_incremental" -CallBlock {
  $body = @{
    action = "sync_inventory_incremental"
    params = @{
      since = $null
    }
  }
  return (Invoke-EdgeFunctionRaw -Path "/functions/v1/query-shortage-data" -Body $body)
}
$results["sync_inventory_incremental"] = $sync_inventory_incremental

# 7) 库存全量同步
$sync_inventory_full = Try-Call -Name "sync_inventory_full" -CallBlock {
  $body = @{
    action = "sync_inventory_full"
    params = @{}
  }
  return (Invoke-EdgeFunctionRaw -Path "/functions/v1/query-shortage-data" -Body $body)
}
$results["sync_inventory_full"] = $sync_inventory_full

# 8) 更新检查接口
$check_update_health = Try-Call -Name "check_update_health" -CallBlock {
  $body = @{ action = "health" }
  # check-update is a different function folder
  return (Invoke-EdgeFunctionRaw -Path "/functions/v1/check-update" -Body $body)
}
$results["check_update_health"] = $check_update_health

# 输出完整结果（不做截断）
$results | ConvertTo-Json -Depth 60
