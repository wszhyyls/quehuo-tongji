Option Explicit

' ============================================================
' 数据库连接参数
' ============================================================
Const SERVER_NAME = "121.229.175.49,1290"
Const DATABASE_NAME = "RQZT"
Const DB_USER = "000000"
Const DB_PASSWORD = "1000000"

' 列号定义
Const COL_STORE = 1        ' A列 - 门店名称
Const COL_PRODUCT = 2      ' B列 - 商品编码
Const COL_CONFIRM = 24     ' X列 - 标准库存数量确认

' 工作表名称
Const CONFIG_SHEET = "Config"
Const DATA_SHEET = "标准库存"

' 连接字符串（兼容所有Windows）
Const CONN_STRING = "Driver={ODBC Driver 17 for SQL Server};Server=" & SERVER_NAME & ";Database=" & DATABASE_NAME & ";UID=" & DB_USER & ";PWD=" & DB_PASSWORD & ";TrustServerCertificate=yes;"

' 获取数据库连接（使用原来的 Provider 方式）
Private Function GetConnOriginal() As Object
    Dim conn As Object
    Set conn = CreateObject("ADODB.Connection")
    On Error Resume Next
    conn.Open "Provider=SQLOLEDB;Server=" & SERVER_NAME & ";Database=" & DATABASE_NAME & _
              ";UID=" & DB_USER & ";Password=" & DB_PASSWORD & ";"
    If Err.Number = 0 Then
        Set GetConnOriginal = conn
        Exit Function
    End If
    Set GetConnOriginal = Nothing
End Function

' ============================================================
' 辅助函数
' ============================================================
Private Function GetLastOpTime(opType As String) As String
    Dim wsConfig As Worksheet, i As Long
    On Error Resume Next
    Set wsConfig = ThisWorkbook.Sheets(CONFIG_SHEET)
    If wsConfig Is Nothing Then GetLastOpTime = "未知": Exit Function
    For i = 2 To wsConfig.Cells(wsConfig.Rows.count, 1).End(xlUp).Row
        If Trim(wsConfig.Cells(i, 1).Value) = opType Then
            GetLastOpTime = wsConfig.Cells(i, 2).Value
            If GetLastOpTime = "" Then GetLastOpTime = "从未执行"
            Exit Function
        End If
    Next i
    GetLastOpTime = "从未执行"
    On Error GoTo 0
End Function

Private Sub UpdateOpTime(opType As String)
    Dim wsConfig As Worksheet, i As Long, found As Boolean, j As Long
    Dim defaultOps As Variant
    defaultOps = Array("全量刷新", "数据刷新", "确认标准库存", "手动同步", "重置确认值", "生成采购计划", "拆分导出", "导入门店确认值", "导出采购计划")
    
    On Error Resume Next
    Set wsConfig = ThisWorkbook.Sheets(CONFIG_SHEET)
    If wsConfig Is Nothing Then
        Set wsConfig = ThisWorkbook.Sheets.Add
        wsConfig.Name = CONFIG_SHEET
        wsConfig.Range("A1").Value = "操作名称"
        wsConfig.Range("B1").Value = "最后时间"
        For j = LBound(defaultOps) To UBound(defaultOps)
            wsConfig.Cells(j + 2, 1).Value = defaultOps(j)
            wsConfig.Cells(j + 2, 2).Value = ""
        Next j
        wsConfig.Columns("A:B").AutoFit
    End If
    found = False
    For i = 2 To wsConfig.Cells(wsConfig.Rows.count, 1).End(xlUp).Row
        If Trim(wsConfig.Cells(i, 1).Value) = opType Then
            wsConfig.Cells(i, 2).Value = Format(Now, "yyyy-mm-dd HH:MM:ss")
            found = True
            Exit For
        End If
    Next i
    If Not found Then
        wsConfig.Cells(wsConfig.Cells(wsConfig.Rows.count, 1).End(xlUp).Row + 1, 1).Value = opType
        wsConfig.Cells(wsConfig.Cells(wsConfig.Rows.count, 1).End(xlUp).Row, 2).Value = Format(Now, "yyyy-mm-dd HH:MM:ss")
    End If
    On Error GoTo 0
End Sub

' -----------------------------------------------------------
' 获取数据库连接（ODBC自动降级）
' -----------------------------------------------------------
Private Function GetConn() As Object
    Dim conn As Object
    Set conn = CreateObject("ADODB.Connection")
    
    Dim s As String
    
    ' 方式1：ODBC Driver 17
    s = "Driver={ODBC Driver 17 for SQL Server};Server=" & SERVER_NAME & ";Database=" & DATABASE_NAME & ";UID=" & DB_USER & ";PWD=" & DB_PASSWORD & ";TrustServerCertificate=yes;"
    On Error Resume Next
    conn.Open s
    If Err.Number = 0 Then
        On Error GoTo 0
        Set GetConn = conn
        Exit Function
    End If
    Err.Clear
    
    ' 方式2：ODBC Driver 13
    s = "Driver={ODBC Driver 13 for SQL Server};Server=" & SERVER_NAME & ";Database=" & DATABASE_NAME & ";UID=" & DB_USER & ";PWD=" & DB_PASSWORD & ";"
    conn.Open s
    If Err.Number = 0 Then
        On Error GoTo 0
        Set GetConn = conn
        Exit Function
    End If
    Err.Clear
    
    ' 方式3：SQL Server Native Client
    s = "Driver={SQL Server Native Client 11.0};Server=" & SERVER_NAME & ";Database=" & DATABASE_NAME & ";UID=" & DB_USER & ";PWD=" & DB_PASSWORD & ";"
    conn.Open s
    If Err.Number = 0 Then
        On Error GoTo 0
        Set GetConn = conn
        Exit Function
    End If
    Err.Clear
    
    On Error GoTo 0
    Set GetConn = Nothing
End Function

Sub ExecuteNonQuery(sql As String)
    Dim conn As Object
    Set conn = GetConn()
    If conn Is Nothing Then
        MsgBox "数据库连接失败！", vbCritical
        Exit Sub
    End If
    conn.CommandTimeout = 600
    conn.Execute sql
    conn.Close
    Set conn = Nothing
End Sub

' ============================================================
' 刷新标准库存表（仅一次 RefreshAll）
' ============================================================
Sub RefreshStandardStockTable()
    ThisWorkbook.RefreshAll
    ' 商品编码文本格式
    Dim ws As Worksheet
    Set ws = ThisWorkbook.Sheets(DATA_SHEET)
    If Not ws Is Nothing Then
        ws.Columns(COL_PRODUCT).NumberFormat = "@"
        Dim lastRow As Long
        lastRow = ws.Cells(ws.Rows.count, COL_PRODUCT).End(xlUp).Row
        If lastRow >= 2 Then
            ws.Range(ws.Cells(2, COL_PRODUCT), ws.Cells(lastRow, COL_PRODUCT)).NumberFormat = "@"
        End If
    End If
End Sub

' ============================================================
' 1. 全量刷新（精简弹窗）
' ============================================================
Sub FullRefresh()
    Dim startTime As Double, elapsedSeconds As Long
    Dim answer As Integer, lastTime As String
    
    startTime = Timer
    lastTime = GetLastOpTime("全量刷新")
    
    answer = MsgBox("[全量刷新] 将执行以下操作：" & vbCrLf & vbCrLf & _
                    "[√] 重新计算所有销售、库存、在途、排名、标记、标准库存" & vbCrLf & _
                    "[√] 补全"有在途无销售无库存"的商品" & vbCrLf & _
                    "[√] 保留您手工确认的标准库存值" & vbCrLf & _
                    "[√] 完成后自动生成采购计划" & vbCrLf & vbCrLf & _
                    "上次全量刷新时间：" & lastTime & vbCrLf & vbCrLf & _
                    "预计耗时 10-20 秒。" & vbCrLf & vbCrLf & _
                    "是否继续？", vbYesNo + vbQuestion + vbDefaultButton2, "确认全量刷新")
    If answer <> vbYes Then Exit Sub
    
    On Error GoTo ErrorHandler
    Application.StatusBar = "正在执行全量刷新..."
    DoEvents
    
    ExecuteNonQuery "EXEC dbo.SPFXB @RefreshRanking = 1;"
    
    UpdateOpTime "全量刷新"
    UpdateOpTime "数据刷新"
    
    RefreshStandardStockTable
    
    ' 静默生成采购计划
    GeneratePurchasePlan Silent:=True
    
    elapsedSeconds = CLng(Timer - startTime)
    
    Application.StatusBar = False
    MsgBox "[全量刷新完成]" & vbCrLf & vbCrLf & _
           "[√] 所有数据已更新" & vbCrLf & _
           "[√] 手工确认值已保留" & vbCrLf & _
           "[√] 采购计划已同步更新" & vbCrLf & _
           "[√] 数据已按门店、A-E类优先、排名升序排列" & vbCrLf & vbCrLf & _
           "[耗时] " & elapsedSeconds & " 秒", vbInformation, "全量刷新完成"
    Exit Sub
    
ErrorHandler:
    Application.StatusBar = False
    MsgBox "[全量刷新失败]" & vbCrLf & vbCrLf & _
           "错误信息: " & Err.Description, vbCritical, "全量刷新失败"
End Sub

' ============================================================
' 2. 数据刷新（增量）
' ============================================================
Sub DataRefresh()
    Dim startTime As Double, elapsedSeconds As Long
    Dim answer As Integer, lastTime As String
    
    startTime = Timer
    lastTime = GetLastOpTime("数据刷新")
    
    answer = MsgBox("[数据刷新] 将执行以下操作：" & vbCrLf & vbCrLf & _
                    "[√] 更新销售、库存、在途数据" & vbCrLf & _
                    "[√] 重新计算派生字段（标准差、安全库存、门店计划）" & vbCrLf & _
                    "[√] 不更新排名、标记、自动标准库存" & vbCrLf & _
                    "[√] 保留手工确认值" & vbCrLf & _
                    "[√] 完成后自动生成采购计划" & vbCrLf & vbCrLf & _
                    "上次数据刷新时间：" & lastTime & vbCrLf & vbCrLf & _
                    "预计耗时 5-15 秒。" & vbCrLf & vbCrLf & _
                    "是否继续？", vbYesNo + vbQuestion + vbDefaultButton2, "确认数据刷新")
    If answer <> vbYes Then Exit Sub
    
    On Error GoTo ErrorHandler
    Call IncrementalSync
    
    RefreshStandardStockTable
    
    GeneratePurchasePlan Silent:=True
    
    elapsedSeconds = CLng(Timer - startTime)
    
    Application.StatusBar = False
    MsgBox "[数据刷新完成]" & vbCrLf & vbCrLf & _
           "[√] 销售、库存数据已更新" & vbCrLf & _
           "[√] 派生字段已重新计算" & vbCrLf & _
           "[√] 采购计划已同步更新" & vbCrLf & vbCrLf & _
           "[耗时] " & elapsedSeconds & " 秒", vbInformation, "数据刷新完成"
    Exit Sub
    
ErrorHandler:
    Application.StatusBar = False
    MsgBox "[数据刷新失败]" & vbCrLf & vbCrLf & _
           "错误信息: " & Err.Description, vbCritical, "数据刷新失败"
End Sub

Private Sub IncrementalSync()
    ExecuteNonQuery "EXEC dbo.SPFXB @RefreshRanking = 0;"
    UpdateOpTime "数据刷新"
End Sub

' ============================================================
' 3. 手工确认标准库存（保持原有确认窗口）
' ============================================================
Private Sub ConfirmStandardStock()
    Dim startTime As Double
    Dim elapsedSeconds As Long
    Dim answer As Integer
    Dim conn As Object, ws As Worksheet
    Dim lastRow As Long, i As Long, updateCount As Integer
    Dim storeName As String, productCode As String, newValue As Variant
    Dim dict As Object, rs As Object, key As String
    Dim lastTime As String
    
    startTime = Timer
    lastTime = GetLastOpTime("确认标准库存")
    
    answer = MsgBox("[手工确认] 将执行以下操作：" & vbCrLf & vbCrLf & _
                    "[√] 将您在当前工作表修改的「标准库存数量确认」值写入数据库" & vbCrLf & _
                    "[√] 重新计算派生字段（标准差、安全库存、门店计划）" & vbCrLf & _
                    "[√] 自动更新采购计划表" & vbCrLf & vbCrLf & _
                    "上次确认时间：" & lastTime & vbCrLf & vbCrLf & _
                    "预计耗时 1-3 秒。" & vbCrLf & vbCrLf & _
                    "是否继续？", vbYesNo + vbQuestion + vbDefaultButton2, "确认标准库存")
    If answer <> vbYes Then Exit Sub
    
    On Error GoTo ErrorHandler
    
    Set ws = ActiveSheet
    lastRow = ws.Cells(ws.Rows.count, COL_STORE).End(xlUp).Row
    If lastRow < 2 Then
        MsgBox "没有数据行，请先执行[数据刷新]或[全量刷新]。", vbExclamation
        Exit Sub
    End If
    
    Application.StatusBar = "正在连接数据库..."
    DoEvents
    
    Set conn = GetConn()
    If conn Is Nothing Then
        MsgBox "数据库连接失败！", vbCritical
        Exit Sub
    End If
    conn.CommandTimeout = 60
    
    Set dict = CreateObject("Scripting.Dictionary")
    Set rs = CreateObject("ADODB.Recordset")
    rs.Open "SELECT [门店名称], [商品编码], [标准库存数量确认] FROM dbo.SPFXB_Result", conn
    Do While Not rs.EOF
        key = rs.Fields(0).Value & "|" & rs.Fields(1).Value
        dict(key) = rs.Fields(2).Value
        rs.MoveNext
    Loop
    rs.Close
    
    updateCount = 0
    For i = 2 To lastRow
        storeName = ws.Cells(i, COL_STORE).Value
        productCode = ws.Cells(i, COL_PRODUCT).Value
        newValue = ws.Cells(i, COL_CONFIRM).Value
        If storeName <> "" And productCode <> "" And IsNumeric(newValue) Then
            key = storeName & "|" & productCode
            If dict.Exists(key) Then
                If CDbl(newValue) <> CDbl(dict(key)) Then
                    conn.Execute "UPDATE dbo.SPFXB_Result SET [标准库存数量确认] = " & newValue & _
                                 " WHERE [门店名称] = '" & Replace(storeName, "'", "''") & "' " & _
                                 "AND [商品编码] = '" & Replace(productCode, "'", "''") & "'"
                    updateCount = updateCount + 1
                End If
            End If
        End If
    Next i
    
    If updateCount > 0 Then
        conn.Execute "EXEC dbo.SPFXB_RefreshDerived;"
    End If
    
    conn.Close
    Set conn = Nothing
    
    UpdateOpTime "确认标准库存"
    GeneratePurchasePlan Silent:=True
    
    elapsedSeconds = CLng(Timer - startTime)
    
    Application.StatusBar = False
    
    If updateCount > 0 Then
        MsgBox "[手工确认完成]" & vbCrLf & vbCrLf & _
               "[√] 已更新 " & updateCount & " 条确认值" & vbCrLf & _
               "[√] 派生字段已重新计算" & vbCrLf & _
               "[√] 采购计划已自动更新" & vbCrLf & vbCrLf & _
               "[耗时] " & elapsedSeconds & " 秒", vbInformation, "确认标准库存完成"
    Else
        MsgBox "[手工确认]" & vbCrLf & vbCrLf & _
               "未检测到确认值修改。" & vbCrLf & vbCrLf & _
               "采购计划已刷新（数据无变化）。" & vbCrLf & vbCrLf & _
               "[耗时] " & elapsedSeconds & " 秒", vbInformation, "确认标准库存"
    End If
    
    Exit Sub
    
ErrorHandler:
    Application.StatusBar = False
    MsgBox "[手工确认失败]" & vbCrLf & vbCrLf & _
           "错误信息: " & Err.Description, vbCritical, "确认标准库存失败"
    If Not conn Is Nothing Then conn.Close
    Set conn = Nothing
End Sub

' ============================================================
' 4. 导入门店确认值（批量更新 + 差值过大提醒）
' ============================================================
Private Sub ImportStoreConfirm()
    Dim folderPath As String, fileName As String
    Dim wb As Workbook, ws As Worksheet, conn As Object
    Dim totalUpdate As Long, totalReset As Long
    Dim i As Long, lastRow As Long, col As Long
    Dim storeName As String, productCode As String, confirmValue As Variant
    Dim answer As Integer
    Dim fld As FileDialog
    Dim startTime As Double, elapsedSeconds As Long
    
    ' 动态列号
    Dim confirmCol As Long
    
    ' 批量 SQL
    Dim sqlBatch As String
    Const MAX_BATCH_LEN As Long = 32000
    Dim sqlPart As String
    Dim batchCount As Long
    
    ' 用于差异提醒
    Dim dictStdStock As Object          ' 存储系统标准库存
    Dim stdStock As Variant
    Dim diff As Double
    Dim alertMsg As String              ' 收集所有差值过大的商品
    Dim alertCount As Long              ' 差值过大商品数量
    
    startTime = Timer
    
    Set fld = Application.FileDialog(msoFileDialogFolderPicker)
    fld.Title = "请选择门店回传文件所在的文件夹"
    fld.InitialFileName = ThisWorkbook.Path & "\"
    If fld.Show = -1 Then
        folderPath = fld.SelectedItems(1)
    Else
        Exit Sub
    End If
    
    answer = MsgBox("将从以下文件夹导入门店确认值：" & vbCrLf & folderPath & vbCrLf & vbCrLf & _
                    "规则：" & vbCrLf & _
                    "· 有数值的 → 更新为手工确认值" & vbCrLf & _
                    "· 空白的 → 重置为系统自动计算的标准库存" & vbCrLf & _
                    "· 确认值与系统标准库存相差超过50 → 提示但不阻止" & vbCrLf & vbCrLf & _
                    "是否继续？", vbYesNo + vbQuestion, "导入门店确认值")
    If answer <> vbYes Then Exit Sub
    
    Application.ScreenUpdating = False
    Application.DisplayAlerts = False
    Application.StatusBar = "正在连接数据库..."
    DoEvents
    
    Set conn = GetConn()
    If conn Is Nothing Then
        MsgBox "数据库连接失败！", vbCritical
        Exit Sub
    End If
    conn.CommandTimeout = 600
    
    totalUpdate = 0
    totalReset = 0
    fileName = Dir(folderPath & "\*.xlsx")
    
    Do While fileName <> ""
        Application.StatusBar = "正在处理文件: " & fileName
        DoEvents
        
        ' 提取门店名称
        storeName = Left(fileName, InStrRev(fileName, "标准库存确认表") - 1)
        If storeName = "" Then
            Set wb = Workbooks.Open(folderPath & "\" & fileName, ReadOnly:=True)
            Set ws = wb.Sheets(1)
            storeName = Trim(ws.Cells(2, 1).Value)
            wb.Close False
        End If
        
        If storeName = "" Then
            MsgBox "无法识别门店名称，跳过文件：" & fileName, vbExclamation
            fileName = Dir()
            GoTo NextFile
        End If
        
        Set wb = Workbooks.Open(folderPath & "\" & fileName, ReadOnly:=True)
        Set ws = wb.Sheets(1)
        
        lastRow = ws.Cells(ws.Rows.count, 1).End(xlUp).Row
        If lastRow < 2 Then
            wb.Close False
            fileName = Dir()
            GoTo NextFile
        End If
        
        ' 动态查找确认列
        confirmCol = 0
        For col = 1 To ws.Cells(1, ws.Columns.count).End(xlToLeft).Column
            If Trim(ws.Cells(1, col).Value) = "标准库存数量确认" Then
                confirmCol = col
                Exit For
            End If
        Next col
        If confirmCol = 0 Then
            MsgBox "文件 " & fileName & " 中未找到"标准库存数量确认"列，跳过。", vbExclamation
            wb.Close False
            fileName = Dir()
            GoTo NextFile
        End If
        
        ' ========== 提前获取该门店的系统标准库存 ==========
        Set dictStdStock = CreateObject("Scripting.Dictionary")
        Dim rs As Object
        Set rs = CreateObject("ADODB.Recordset")
        rs.Open "SELECT [商品编码], [标准库存数量] FROM dbo.SPFXB_Result WHERE [门店名称] = '" & _
                 Replace(storeName, "'", "''") & "'", conn
        Do While Not rs.EOF
            dictStdStock(CStr(rs.Fields(0).Value)) = CDbl(rs.Fields(1).Value)
            rs.MoveNext
        Loop
        rs.Close
        Set rs = Nothing
        
        ' 初始化提醒信息
        alertMsg = ""
        alertCount = 0
        
        ' ========== 批量拼接 SQL ==========
        sqlBatch = ""
        batchCount = 0
        
        For i = 2 To lastRow
            productCode = Trim(ws.Cells(i, 2).Value)
            confirmValue = ws.Cells(i, confirmCol).Value
            
            If productCode <> "" Then
                If IsEmpty(confirmValue) Or confirmValue = "" Then
                    ' 重置为系统默认
                    sqlPart = "UPDATE dbo.SPFXB_Result SET [标准库存数量确认] = [标准库存数量]" & _
                              " WHERE [门店名称] = '" & Replace(storeName, "'", "''") & "'" & _
                              " AND [商品编码] = '" & Replace(productCode, "'", "''") & "';"
                    totalReset = totalReset + 1
                ElseIf IsNumeric(confirmValue) Then
                    ' 检查与标准库存的差值
                    If dictStdStock.Exists(productCode) Then
                        stdStock = dictStdStock(productCode)
                        diff = Abs(CDbl(confirmValue) - stdStock)
                        If diff > 50 Then
                            alertMsg = alertMsg & "商品 " & productCode & _
                                       "：确认值=" & confirmValue & _
                                       "，标准库存=" & stdStock & _
                                       "，差值=" & diff & vbCrLf
                            alertCount = alertCount + 1
                        End If
                    End If
                    
                    sqlPart = "UPDATE dbo.SPFXB_Result SET [标准库存数量确认] = " & confirmValue & _
                              " WHERE [门店名称] = '" & Replace(storeName, "'", "''") & "'" & _
                              " AND [商品编码] = '" & Replace(productCode, "'", "''") & "';"
                    totalUpdate = totalUpdate + 1
                Else
                    sqlPart = ""
                End If
                
                If Len(sqlPart) > 0 Then
                    If Len(sqlBatch) + Len(sqlPart) > MAX_BATCH_LEN And sqlBatch <> "" Then
                        conn.Execute sqlBatch
                        sqlBatch = ""
                        batchCount = batchCount + 1
                    End If
                    sqlBatch = sqlBatch & sqlPart
                End If
            End If
        Next i
        
        If sqlBatch <> "" Then
            conn.Execute sqlBatch
            batchCount = batchCount + 1
        End If
        
        ' 如果有差值过大，弹窗提醒
        If alertCount > 0 Then
            MsgBox "门店【" & storeName & "】存在 " & alertCount & " 个商品确认值与系统标准库存差距超过50：" & vbCrLf & vbCrLf & _
                   alertMsg & vbCrLf & _
                   "系统已仍按您提供的确认值更新，如需修正请重新上传文件。", vbExclamation, "确认值异常提醒"
        End If
        
        wb.Close SaveChanges:=False
        fileName = Dir()
        
NextFile:
    Loop
    
    If totalUpdate + totalReset > 0 Then
        conn.Execute "EXEC dbo.SPFXB_RefreshDerived;"
    End If
    
    conn.Close
    Set conn = Nothing
    
    UpdateOpTime "导入门店确认值"
    
    ManualIncrementalSync Silent:=True
    GeneratePurchasePlan Silent:=True
    
    elapsedSeconds = CLng(Timer - startTime)
    
    Application.StatusBar = False
    Application.ScreenUpdating = True
    Application.DisplayAlerts = True
    
    MsgBox "导入完成！" & vbCrLf & vbCrLf & _
           "已更新手工确认值：" & totalUpdate & " 条" & vbCrLf & _
           "已重置空白为系统默认值：" & totalReset & " 条" & vbCrLf & _
           "采购计划已同步更新" & vbCrLf & vbCrLf & _
           "耗时：" & elapsedSeconds & " 秒", vbInformation, "导入门店确认值"
End Sub

' ============================================================
' 5. 手动增量同步（增加 Silent 参数）
' ============================================================
Sub ManualIncrementalSync(Optional Silent As Boolean = False)
    Dim startTime As Double, elapsedSeconds As Long
    Dim answer As Integer, lastTime As String
    
    startTime = Timer
    lastTime = GetLastOpTime("手动同步")
    
    If Not Silent Then
        answer = MsgBox("[手动同步] 将执行以下操作：" & vbCrLf & vbCrLf & _
                        "[√] 从数据库拉取最新数据（不执行存储过程）" & vbCrLf & _
                        "[√] 刷新当前工作表" & vbCrLf & vbCrLf & _
                        "上次手动同步时间：" & lastTime & vbCrLf & vbCrLf & _
                        "预计耗时 1-5 秒。" & vbCrLf & vbCrLf & _
                        "是否继续？", vbYesNo + vbQuestion + vbDefaultButton2, "确认手动同步")
        If answer <> vbYes Then Exit Sub
    End If
    
    On Error GoTo ErrorHandler
    RefreshStandardStockTable
    UpdateOpTime "手动同步"
    elapsedSeconds = CLng(Timer - startTime)
    
    If Not Silent Then
        MsgBox "[手动同步完成]" & vbCrLf & vbCrLf & _
               "[√] 数据已刷新" & vbCrLf & _
               "[耗时] " & elapsedSeconds & " 秒", vbInformation, "手动同步完成"
    End If
    Exit Sub
    
ErrorHandler:
    Application.StatusBar = False
    If Not Silent Then MsgBox "[手动同步失败]" & vbCrLf & vbCrLf & "错误信息: " & Err.Description, vbCritical, "手动同步失败"
End Sub

' ============================================================
' 6. 生成采购计划（修复备份编码 + chkKey 变量声明）
' ============================================================
Sub GeneratePurchasePlan(Optional Silent As Boolean = False)
    Dim conn As Object, rs As Object, ws As Worksheet
    Dim lastRow As Long, dataRow As Long, i As Integer, colCount As Integer
    Dim firstDataRow As Integer, lastTime As String
    Dim dictActual As Object              ' 备份的实际订货值
    Dim actualCol As Long                 ' 原"实际订货"列号
    Dim productCode As String
    Dim actualValue As Variant
    Dim clearActual As Boolean            ' 是否清空实际订货列
    Dim userResponse As VbMsgBoxResult    ' 用于接收三按钮响应
    Dim wsBackup As Worksheet             ' 备份工作表
    Dim destRow As Long
    Dim hasValidData As Boolean           ' 是否存在非空白数据
    Dim chkKey As Variant                 ' 遍历字典用
    Dim bKey As Variant                   ' 遍历字典用
    Dim newActualCol As Long

    lastTime = GetLastOpTime("生成采购计划")

    ' ================= 手动调用时的弹窗确认 =================
    If Not Silent Then
        AppActivate Application.Caption
        If MsgBox("将重新生成采购计划表，覆盖现有「采购计划」工作表。" & vbCrLf & vbCrLf & _
                  "上次生成时间：" & lastTime & vbCrLf & vbCrLf & _
                  "是否继续？", vbYesNo + vbQuestion, "生成采购计划") = vbNo Then Exit Sub

        userResponse = MsgBox("是否清空「实际订货」列中已有的订货数量？" & vbCrLf & vbCrLf & _
                             "是(Y) - 清空所有订货记录" & vbCrLf & _
                             "否(N) - 保留已有订货数量" & vbCrLf & _
                             "取消   - 退出操作", vbYesNoCancel + vbQuestion, "清空实际订货")
        Select Case userResponse
            Case vbYes: clearActual = True
            Case vbNo:  clearActual = False
            Case vbCancel:
                Application.StatusBar = False
                Exit Sub
        End Select
    Else
        clearActual = False
    End If

    Application.StatusBar = "正在生成采购计划..."
    DoEvents

    On Error GoTo ErrorHandler

    ' ================= 获取采购计划工作表 =================
    On Error Resume Next
    Set ws = ThisWorkbook.Sheets("采购计划")
    If ws Is Nothing Then
        Set ws = ThisWorkbook.Sheets.Add
        ws.Name = "采购计划"
    End If
    On Error GoTo 0

    ' ================= 查找并备份"实际订货"列 =================
    Set dictActual = CreateObject("Scripting.Dictionary")
    actualCol = 0
    If ws.Cells(1, 1).Value <> "" Then
        For i = 1 To ws.Cells(1, ws.Columns.count).End(xlToLeft).Column
            If Trim(ws.Cells(1, i).Value) = "实际订货" Then
                actualCol = i
                Exit For
            End If
        Next i

        If actualCol > 0 Then
            lastRow = ws.Cells(ws.Rows.count, 1).End(xlUp).Row
            For i = 2 To lastRow
                productCode = Trim(ws.Cells(i, 1).Text)
                If productCode <> "" Then
                    actualValue = ws.Cells(i, actualCol).Value
                    dictActual(productCode) = actualValue
                End If
            Next i
        End If
    End If

    ' ================= 自动备份到隐藏工作表 =================
    On Error Resume Next
    Set wsBackup = ThisWorkbook.Sheets("采购计划_备份")
    If wsBackup Is Nothing Then
        Set wsBackup = ThisWorkbook.Sheets.Add
        wsBackup.Name = "采购计划_备份"
        wsBackup.Visible = xlSheetHidden
    End If
    On Error GoTo 0

    hasValidData = False
    If dictActual.count > 0 Then
        For Each chkKey In dictActual.Keys
            If Not IsEmpty(dictActual(chkKey)) And Trim(dictActual(chkKey)) <> "" Then
                If IsNumeric(dictActual(chkKey)) Then
                    If CDbl(dictActual(chkKey)) <> 0 Then hasValidData = True: Exit For
                Else
                    hasValidData = True: Exit For
                End If
            End If
        Next chkKey
    End If

    If hasValidData Then
        wsBackup.Cells.Clear
        wsBackup.Columns(1).NumberFormat = "@"
        wsBackup.Range("A1").Value = "商品编码"
        wsBackup.Range("B1").Value = "实际订货"
        wsBackup.Range("C1").Value = Format(Now, "yyyy-mm-dd HH:MM:ss")
        destRow = 2
        For Each bKey In dictActual.Keys
            wsBackup.Cells(destRow, 1).NumberFormat = "@"
            wsBackup.Cells(destRow, 1).Value = CStr(bKey)
            wsBackup.Cells(destRow, 2).Value = dictActual(bKey)
            destRow = destRow + 1
        Next bKey
    Else
        wsBackup.Cells.Clear
    End If

    ' ================= 清空原有数据 =================
    firstDataRow = 2
    On Error Resume Next
    lastRow = ws.Cells(ws.Rows.count, 1).End(xlUp).Row
    If lastRow >= firstDataRow Then
        ws.Rows(firstDataRow & ":" & lastRow).ClearContents
    End If
    On Error GoTo 0

    ' ================= 执行存储过程获取新数据 =================
    Set conn = GetConn()
    If conn Is Nothing Then
        MsgBox "数据库连接失败！", vbCritical
        Exit Sub
    End If
    conn.CommandTimeout = 120

    Set rs = CreateObject("ADODB.Recordset")
    rs.Open "EXEC dbo.usp_GetPurchasePlan", conn

    colCount = rs.Fields.count

    If ws.Cells(1, 1).Value = "" Then
        For i = 0 To colCount - 1
            ws.Cells(1, i + 1).Value = rs.Fields(i).Name
        Next i
        With ws.Rows(1)
            .Font.Bold = True
            .Interior.Color = RGB(0, 102, 204)
            .Font.Color = RGB(255, 255, 255)
        End With
        ws.Columns("A:Z").AutoFit
    End If

    ws.Columns(1).NumberFormat = "@"

    dataRow = firstDataRow
    Do While Not rs.EOF
        For i = 0 To colCount - 1
            If i = 0 Then
                ws.Cells(dataRow, i + 1).NumberFormat = "@"
                ws.Cells(dataRow, i + 1).Value = rs.Fields(i).Value
            Else
                ws.Cells(dataRow, i + 1).Value = rs.Fields(i).Value
            End If
        Next i
        dataRow = dataRow + 1
        rs.MoveNext
    Loop

    rs.Close
    conn.Close
    Set rs = Nothing
    Set conn = Nothing

    ' ================= 回填实际订货值（如果不清空） =================
    If Not clearActual And actualCol > 0 Then
        newActualCol = 0
        For i = 1 To ws.Cells(1, ws.Columns.count).End(xlToLeft).Column
            If Trim(ws.Cells(1, i).Value) = "实际订货" Then
                newActualCol = i
                Exit For
            End If
        Next i

        If newActualCol = 0 And dictActual.count > 0 Then
            newActualCol = ws.Cells(1, ws.Columns.count).End(xlToLeft).Column + 1
            ws.Cells(1, newActualCol).Value = "实际订货"
            ws.Cells(1, newActualCol).Font.Bold = True
        End If

        If newActualCol > 0 Then
            For i = 2 To dataRow - 1
                productCode = Trim(ws.Cells(i, 1).Text)
                If productCode <> "" And dictActual.Exists(productCode) Then
                    ws.Cells(i, newActualCol).Value = dictActual(productCode)
                End If
            Next i
        End If
    End If

    UpdateOpTime "生成采购计划"

    Application.StatusBar = False

    If Not Silent Then
        AppActivate Application.Caption
        MsgBox "采购计划已更新，共 " & (dataRow - firstDataRow) & " 行数据。" & vbCrLf & _
               IIf(clearActual, "「实际订货」列已清空。", "「实际订货」列数据已保留。"), vbInformation
    End If
    Exit Sub

ErrorHandler:
    Application.StatusBar = False
    If Not Silent Then
        MsgBox "生成采购计划失败: " & Err.Description, vbCritical
    End If
    If Not conn Is Nothing Then conn.Close
End Sub

' ============================================================
' 恢复实际订货数据
' ============================================================
Sub RestoreActualOrder()
    Dim wsPlan As Worksheet, wsBackup As Worksheet
    Dim lastRow As Long, i As Long, actualCol As Long
    Dim productCode As String, backupDict As Object
    Dim answer As Integer
    Dim backupTime As String

    On Error Resume Next
    Set wsPlan = ThisWorkbook.Sheets("采购计划")
    Set wsBackup = ThisWorkbook.Sheets("采购计划_备份")
    On Error GoTo 0

    If wsPlan Is Nothing Then
        MsgBox ""采购计划"工作表不存在。", vbExclamation
        Exit Sub
    End If
    If wsBackup Is Nothing Then
        MsgBox "未找到历史备份，无法恢复。", vbExclamation
        Exit Sub
    End If

    ' 读取备份时间
    backupTime = Trim(wsBackup.Cells(1, 3).Text)
    If backupTime = "" Then backupTime = "未知"

    answer = MsgBox("将用备份数据恢复"实际订货"列。" & vbCrLf & vbCrLf & _
                    "备份时间：" & backupTime & vbCrLf & vbCrLf & _
                    "当前订货数据将被覆盖，是否继续？", vbYesNo + vbQuestion, "恢复实际订货")
    If answer <> vbYes Then Exit Sub

    ' 构建字典
    Set backupDict = CreateObject("Scripting.Dictionary")
    lastRow = wsBackup.Cells(wsBackup.Rows.count, 1).End(xlUp).Row
    If lastRow < 2 Then
        MsgBox "备份表中没有数据。", vbExclamation
        Exit Sub
    End If
    For i = 2 To lastRow
        productCode = Trim(wsBackup.Cells(i, 1).Text)
        If productCode <> "" Then
            backupDict(productCode) = wsBackup.Cells(i, 2).Value
        End If
    Next i

    ' 在采购计划表中查找"实际订货"列
    actualCol = 0
    For i = 1 To wsPlan.Cells(1, wsPlan.Columns.count).End(xlToLeft).Column
        If Trim(wsPlan.Cells(1, i).Value) = "实际订货" Then
            actualCol = i
            Exit For
        End If
    Next i
    If actualCol = 0 Then
        actualCol = wsPlan.Cells(1, wsPlan.Columns.count).End(xlToLeft).Column + 1
        wsPlan.Cells(1, actualCol).Value = "实际订货"
        wsPlan.Cells(1, actualCol).Font.Bold = True
    End If

    ' 回填数据
    Dim rowCount As Long
    rowCount = wsPlan.Cells(wsPlan.Rows.count, 1).End(xlUp).Row
    For i = 2 To rowCount
        productCode = Trim(wsPlan.Cells(i, 1).Text)
        If backupDict.Exists(productCode) Then
            wsPlan.Cells(i, actualCol).Value = backupDict(productCode)
        End If
    Next i

    MsgBox "已成功恢复 " & backupDict.count & " 条实际订货记录。" & vbCrLf & _
           "恢复的备份时间：" & backupTime, vbInformation
End Sub

' ============================================================
' 7. 按门店拆分导出
' ============================================================
Sub SplitByStore()
    Dim wsSource As Worksheet
    Dim wbNew As Workbook
    Dim wsNew As Worksheet
    Dim lastRow As Long, i As Long, col As Long, lastCol As Long
    Dim storeName As Variant
    Dim dict As Object
    Dim arrStores() As String
    Dim savePath As String
    Dim excludeCols As Object
    Dim headerName As String
    Dim key As Variant
    Dim answer As Integer
    Dim startTime As Double
    Dim elapsedSeconds As Integer
    Dim todayStr As String
    Dim fileName As String
    Dim safeName As String
    Dim confirmCol As Long
    Dim remarkCol As Long
    Dim shp As Object
    Dim lastTime As String
    Dim visibleRange As Range
    Dim tbl As ListObject
    Dim foundRemark As Boolean

    lastTime = GetLastOpTime("拆分导出")

    answer = MsgBox("[按门店拆分导出] 将执行以下操作：" & vbCrLf & vbCrLf & _
                    "[√] 按门店拆分数据到独立 Excel 文件" & vbCrLf & _
                    "[√] 排除敏感字段，清空确认列" & vbCrLf & _
                    "[√] 备注列可编辑，并提供下拉选项" & vbCrLf & _
                    "[√] 删除按钮，生成无宏文件" & vbCrLf & _
                    "[√] 保留原工作表格式、列宽、单元格样式" & vbCrLf & _
                    "[√] 仅数据区域添加边框，开启筛选模式" & vbCrLf & vbCrLf & _
                    "上次导出时间：" & lastTime & vbCrLf & vbCrLf & _
                    "预计耗时 15-30 秒。" & vbCrLf & vbCrLf & _
                    "是否继续？", vbYesNo + vbQuestion + vbDefaultButton2, "确认拆分导出")
    If answer <> vbYes Then Exit Sub

    startTime = Timer
    Application.ScreenUpdating = False
    Application.DisplayAlerts = False

    On Error GoTo ErrorHandler

    todayStr = Format(Date, "yyyymmdd")
    Set wsSource = ThisWorkbook.Sheets(DATA_SHEET)
    lastRow = wsSource.Cells(wsSource.Rows.count, 1).End(xlUp).Row

    ' 敏感列定义
    Set excludeCols = CreateObject("Scripting.Dictionary")
    excludeCols("最近进价") = True
    excludeCols("库存数量") = True
    excludeCols("在途数量") = True
    excludeCols("门店库存汇总") = True
    excludeCols("配送中心库存数量") = True
    excludeCols("前90天销售金额") = True
    excludeCols("门店库存标准差") = True
    excludeCols("安全库存下限") = True
    excludeCols("门店计划") = True
    excludeCols("库存日期") = True

    ' 查找确认列和备注列
    confirmCol = 0
    remarkCol = 0
    For col = 1 To wsSource.Cells(1, wsSource.Columns.count).End(xlToLeft).Column
        headerName = Trim(wsSource.Cells(1, col).Value)
        If headerName = "标准库存数量确认" Then confirmCol = col
        If headerName = "备注" Then remarkCol = col
    Next col

    ' 收集所有门店
    Set dict = CreateObject("Scripting.Dictionary")
    For i = 2 To lastRow
        storeName = Trim(wsSource.Cells(i, 1).Value)
        If storeName <> "" Then dict(storeName) = True
    Next i

    If dict.count = 0 Then
        MsgBox "标准库存工作表中没有可导出的门店数据。", vbExclamation
        GoTo CleanUp
    End If

    ReDim arrStores(1 To dict.count)
    i = 1
    For Each key In dict.Keys
        arrStores(i) = key
        i = i + 1
    Next key

    savePath = ThisWorkbook.Path & "\门店库存拆分\"
    If ThisWorkbook.Path = "" Then
        savePath = Environ("USERPROFILE") & "\Desktop\门店库存拆分\"
    End If
    On Error Resume Next
    MkDir savePath
    On Error GoTo ErrorHandler

    For i = 1 To UBound(arrStores)
        storeName = arrStores(i)
        Application.StatusBar = "正在处理 " & storeName & " (" & i & "/" & UBound(arrStores) & ")"
        DoEvents

        wsSource.Copy
        Set wbNew = ActiveWorkbook
        Set wsNew = wbNew.Sheets(1)

        On Error Resume Next
        For Each tbl In wsNew.ListObjects
            tbl.Unlist
        Next tbl
        On Error GoTo ErrorHandler

        On Error Resume Next
        For Each shp In wsNew.Shapes
            shp.Delete
        Next shp
        On Error GoTo ErrorHandler

        lastRow = wsNew.Cells(wsNew.Rows.count, 1).End(xlUp).Row
        If lastRow > 1 Then
            With wsNew.Range("A1").Resize(lastRow, 1)
                .AutoFilter Field:=1, Criteria1:="<>" & storeName
                Set visibleRange = .Offset(1, 0).Resize(lastRow - 1, 1).SpecialCells(xlCellTypeVisible)
                If Not visibleRange Is Nothing Then visibleRange.EntireRow.Delete
                .AutoFilter
            End With
        End If

        lastRow = wsNew.Cells(wsNew.Rows.count, 1).End(xlUp).Row

        If confirmCol > 0 And lastRow >= 2 Then
            wsNew.Range(wsNew.Cells(2, confirmCol), wsNew.Cells(lastRow, confirmCol)).ClearContents
        End If

        For col = wsNew.UsedRange.Columns.count To 1 Step -1
            headerName = Trim(wsNew.Cells(1, col).Value)
            If excludeCols.Exists(headerName) Then
                wsNew.Columns(col).Delete
            End If
        Next col

        foundRemark = False
        For col = 1 To wsNew.UsedRange.Columns.count
            If Trim(wsNew.Cells(1, col).Value) = "备注" Then
                foundRemark = True
                remarkCol = col
                Exit For
            End If
        Next col

        If foundRemark Then
            wsNew.Columns(remarkCol).Hidden = False
            If lastRow >= 2 Then
                wsNew.Range(wsNew.Cells(2, remarkCol), wsNew.Cells(lastRow, remarkCol)).ClearContents
            End If
        Else
            remarkCol = wsNew.UsedRange.Columns.count + 1
            wsNew.Cells(1, remarkCol).Value = "备注"
            wsNew.Columns(1).Copy
            wsNew.Columns(remarkCol).PasteSpecial Paste:=xlPasteFormats
            Application.CutCopyMode = False
            wsNew.Columns(remarkCol).ColumnWidth = 20
            wsNew.Cells(1, remarkCol).Font.Bold = True
        End If

        If remarkCol > 0 And lastRow >= 2 Then
            With wsNew.Range(wsNew.Cells(2, remarkCol), wsNew.Cells(lastRow, remarkCol)).Validation
                .Delete
                .Add Type:=xlValidateList, AlertStyle:=xlValidAlertStop, _
                     Operator:=xlBetween, Formula1:="顾客订购,效期处理,滞销处理,季节性产品,活动促销"
                .IgnoreBlank = True
                .InCellDropdown = True
                .ShowInput = True
                .ShowError = True
            End With
        End If

        wsNew.Columns(2).NumberFormat = "@"

        lastRow = wsNew.Cells(wsNew.Rows.count, 1).End(xlUp).Row
        lastCol = wsNew.Cells(1, wsNew.Columns.count).End(xlToLeft).Column
        If lastRow >= 2 And lastCol >= 1 Then
            With wsNew.Range(wsNew.Cells(1, 1), wsNew.Cells(lastRow, lastCol))
                With .Borders(xlEdgeTop)
                    .LineStyle = xlContinuous
                    .Weight = xlThin
                End With
                With .Borders(xlEdgeBottom)
                    .LineStyle = xlContinuous
                    .Weight = xlThin
                End With
                With .Borders(xlEdgeLeft)
                    .LineStyle = xlContinuous
                    .Weight = xlThin
                End With
                With .Borders(xlEdgeRight)
                    .LineStyle = xlContinuous
                    .Weight = xlThin
                End With
                With .Borders(xlInsideVertical)
                    .LineStyle = xlContinuous
                    .Weight = xlThin
                End With
                With .Borders(xlInsideHorizontal)
                    .LineStyle = xlContinuous
                    .Weight = xlThin
                End With
            End With
        End If

        If lastRow >= 2 Then
            wsNew.Range("A1").CurrentRegion.AutoFilter
        End If

        Application.Goto wsNew.Range("A1"), True

        safeName = storeName
        safeName = Replace(safeName, "/", "_")
        safeName = Replace(safeName, "\", "_")
        safeName = Replace(safeName, ":", "_")
        safeName = Replace(safeName, "*", "_")
        safeName = Replace(safeName, "?", "_")
        safeName = Replace(safeName, Chr(34), "_")
        safeName = Replace(safeName, "<", "_")
        safeName = Replace(safeName, ">", "_")
        safeName = Replace(safeName, "|", "_")

        fileName = safeName & "标准库存确认表" & todayStr & ".xlsx"
        wbNew.SaveAs savePath & fileName, 51
        wbNew.Close SaveChanges:=False
    Next i

    UpdateOpTime "拆分导出"

    elapsedSeconds = Int(Timer - startTime)

    Application.StatusBar = False
    MsgBox "拆分导出完成！" & vbCrLf & vbCrLf & _
           "生成 " & UBound(arrStores) & " 个文件" & vbCrLf & _
           "保存位置：" & savePath & vbCrLf & _
           "耗时：" & elapsedSeconds & " 秒", vbInformation, "拆分导出完成"

CleanUp:
    Application.ScreenUpdating = True
    Application.DisplayAlerts = True
    Exit Sub

ErrorHandler:
    Application.StatusBar = False
    MsgBox "拆分导出失败！" & vbCrLf & vbCrLf & _
           "错误信息：" & Err.Description, vbCritical, "拆分导出失败"
    Resume CleanUp
End Sub

' ============================================================
' 8. 重置标准库存确认值
' ============================================================
Sub ResetConfirmToStandard()
    Dim answer As Integer, startTime As Double, elapsedSeconds As Long
    Dim conn As Object, lastTime As String
    
    startTime = Timer
    lastTime = GetLastOpTime("重置确认值")
    
    answer = MsgBox("[重置确认值] 将执行以下操作：" & vbCrLf & vbCrLf & _
                    "[√] 将所有商品的【标准库存数量确认】重置为系统自动计算的标准库存" & vbCrLf & _
                    "[√] 重新计算派生字段" & vbCrLf & _
                    "[√] 刷新标准库存表和采购计划表" & vbCrLf & vbCrLf & _
                    "上次重置时间：" & lastTime & vbCrLf & vbCrLf & _
                    "注意：此操作将覆盖您所有手工修改的确认值，不可撤销！" & vbCrLf & vbCrLf & _
                    "预计耗时 2-5 秒。" & vbCrLf & vbCrLf & _
                    "是否继续？", vbYesNo + vbQuestion + vbDefaultButton2, "确认重置")
    If answer <> vbYes Then Exit Sub
    
    On Error GoTo ErrorHandler
    Application.StatusBar = "正在重置确认值..."
    DoEvents
    
    Set conn = GetConn()
    If conn Is Nothing Then
        MsgBox "数据库连接失败！", vbCritical
        Exit Sub
    End If
    conn.CommandTimeout = 60
    conn.Execute "UPDATE dbo.SPFXB_Result SET [标准库存数量确认] = [标准库存数量];"
    conn.Execute "EXEC dbo.SPFXB_RefreshDerived;"
    conn.Close
    Set conn = Nothing
    
    UpdateOpTime "重置确认值"
    
    ManualIncrementalSync Silent:=True
    GeneratePurchasePlan Silent:=True
    
    elapsedSeconds = CLng(Timer - startTime)
    
    Application.StatusBar = False
    MsgBox "[重置确认值完成]" & vbCrLf & vbCrLf & _
           "[√] 所有确认值已重置为系统自动计算的标准库存" & vbCrLf & _
           "[√] 派生字段已重新计算" & vbCrLf & _
           "[√] 标准库存表和采购计划表已更新" & vbCrLf & vbCrLf & _
           "[耗时] " & elapsedSeconds & " 秒", vbInformation, "重置确认值完成"
    Exit Sub
    
ErrorHandler:
    Application.StatusBar = False
    MsgBox "[重置确认值失败]" & vbCrLf & vbCrLf & _
           "错误信息: " & Err.Description, vbCritical, "重置确认值失败"
    If Not conn Is Nothing Then conn.Close
End Sub

' ============================================================
' 9. 合并按钮：确认标准库存 / 导入门店确认值
' ============================================================
Sub StockConfirmOrImport()
    Dim res As Integer
    res = MsgBox("请选择操作：" & vbCrLf & vbCrLf & _
                 "是(Y) - 手工确认（当前工作表修改）" & vbCrLf & _
                 "否(N) - 文件导入（门店回传文件）" & vbCrLf & _
                 "取消 - 退出", _
                 vbYesNoCancel + vbQuestion, "确认/导入标准库存")
    Select Case res
        Case vbYes: Call ConfirmStandardStock
        Case vbNo: Call ImportStoreConfirm
        Case vbCancel: ' 退出
    End Select
End Sub

' ============================================================
' 10. 导出采购计划表
' ============================================================
Sub ExportPurchasePlan()
    Dim wsSource As Worksheet
    Dim wbNew As Workbook
    Dim wsNew As Worksheet
    Dim savePath As String
    Dim todayStr As String
    Dim fileName As String
    Dim answer As Integer
    Dim shp As Object
    Dim wsTemp As Worksheet
    Dim vbComp As Object
    Dim lastTime As String
    
    lastTime = GetLastOpTime("导出采购计划")
    
    answer = MsgBox("[导出采购计划] 将执行以下操作：" & vbCrLf & vbCrLf & _
                    "[√] 将当前「采购计划」工作表导出为独立Excel文件" & vbCrLf & _
                    "[√] 保留原列宽、行高、单元格格式" & vbCrLf & _
                    "[√] 删除新文件中的所有按钮和VBA代码" & vbCrLf & _
                    "[√] 文件名格式：采购计划_YYYYMMDD.xlsx" & vbCrLf & vbCrLf & _
                    "上次导出时间：" & lastTime & vbCrLf & vbCrLf & _
                    "是否继续？", vbYesNo + vbQuestion, "导出采购计划")
    If answer <> vbYes Then Exit Sub
    
    Application.ScreenUpdating = False
    Application.DisplayAlerts = False
    
    On Error GoTo ErrorHandler
    
    todayStr = Format(Date, "yyyymmdd")
    Set wsSource = ThisWorkbook.Sheets("采购计划")
    If wsSource Is Nothing Then
        MsgBox "找不到工作表「采购计划」，请先生成采购计划。", vbCritical
        Exit Sub
    End If
    
    wsSource.Copy
    Set wbNew = ActiveWorkbook
    Set wsNew = wbNew.Sheets(1)
    
    On Error Resume Next
    For Each wsTemp In wbNew.Sheets
        For Each shp In wsTemp.Shapes
            shp.Delete
        Next shp
    Next wsTemp
    For Each vbComp In wbNew.VBProject.VBComponents
        wbNew.VBProject.VBComponents.Remove vbComp
    Next vbComp
    On Error GoTo ErrorHandler
    
    Application.Goto wsNew.Range("A1"), True
    
    savePath = ThisWorkbook.Path & "\门店库存拆分\"
    If ThisWorkbook.Path = "" Then
        savePath = Environ("USERPROFILE") & "\Desktop\门店库存拆分\"
    End If
    On Error Resume Next
    MkDir savePath
    On Error GoTo ErrorHandler
    
    fileName = "采购计划_" & todayStr & ".xlsx"
    wbNew.SaveAs savePath & fileName, 51
    wbNew.Close SaveChanges:=False
    
    UpdateOpTime "导出采购计划"
    
    Application.StatusBar = False
    MsgBox "导出完成！" & vbCrLf & vbCrLf & _
           "文件名称：" & fileName & vbCrLf & _
           "保存位置：" & savePath, vbInformation, "导出采购计划"
    
CleanUp:
    Application.ScreenUpdating = True
    Application.DisplayAlerts = True
    Exit Sub
    
ErrorHandler:
    Application.StatusBar = False
    MsgBox "导出采购计划失败！" & vbCrLf & vbCrLf & _
           "错误信息：" & Err.Description, vbCritical, "导出失败"
    Resume CleanUp
End Sub

' ============================================================
' 上传订货数量（写入 Shortage_OrderFeedback 表）
' 使用原来的 Provider 连接方式
' ============================================================
Sub 上传订货数量()
    Dim conn As Object
    Set conn = GetConnOriginal()
    
    If conn Is Nothing Then
        MsgBox "连接失败！请检查网络和密码", vbCritical, "错误"
        Exit Sub
    End If
    
    ' 列配置（A=商品编码，X=实际订货，根据你的表调整）
    Dim colCode As String, colQty As String
    colCode = "A"
    colQty = "X"
    
    Dim lastRow As Long
    lastRow = Cells(Rows.count, colCode).End(xlUp).Row
    If lastRow < 2 Then
        MsgBox "没有数据", vbExclamation
        conn.Close: Exit Sub
    End If
    
    Dim success As Long, fail As Long
    success = 0: fail = 0
    
    Dim i As Long
    For i = 2 To lastRow
        Dim code As String, qty As Variant
        code = Trim(Cells(i, colCode).Value)
        qty = Cells(i, colQty).Value
        
        If code = "" Then GoTo NextRow
        If Not IsNumeric(qty) Then GoTo NextRow
        If qty = 0 Or qty = "" Then GoTo NextRow
        
        Dim sql As String
        sql = "EXEC dbo.usp_UpdateActualOrder @商品编码='" & Replace(code, "'", "''") & "',@实际订货数量=" & CLng(qty) & ",@操作人='VBA'"
        
        On Error Resume Next
        conn.Execute sql
        On Error GoTo 0
        
        If Err.Number = 0 Then
            success = success + 1
            Cells(i, colQty).Interior.Color = RGB(198, 239, 206)
        Else
            fail = fail + 1
            Cells(i, colQty).Interior.Color = RGB(255, 199, 206)
            Err.Clear
        End If
        
        If i Mod 20 = 0 Then
            Application.StatusBar = "上传中: " & i & "/" & lastRow
            DoEvents
        End If
        
NextRow:
    Next i
    
    Application.StatusBar = False
    conn.Close
    Set conn = Nothing
    
    MsgBox "上传完成！" & vbCrLf & "成功：" & success & " 条" & vbCrLf & "失败：" & fail & " 条", vbInformation
End Sub

' ============================================================
' 查看订货记录
' ============================================================
Sub 查看订货记录()
    Dim conn As Object
    Set conn = GetConn()
    If conn Is Nothing Then MsgBox "连接失败", vbCritical: Exit Sub
    
    Dim sql As String, rs As Object
    sql = "SELECT 商品编码,实际订货数量,补货状态,订货时间,操作人 FROM dbo.Shortage_OrderFeedback ORDER BY 订货时间 DESC"
    Set rs = CreateObject("ADODB.Recordset")
    rs.Open sql, conn
    
    If rs.EOF Then
        MsgBox "暂无记录"
        rs.Close: conn.Close: Exit Sub
    End If
    
    Dim ws As Worksheet
    On Error Resume Next
    Set ws = Worksheets("订货记录")
    On Error GoTo 0
    If ws Is Nothing Then
        Set ws = Worksheets.Add
        ws.Name = "订货记录"
    Else
        ws.Cells.Clear
    End If
    
    ws.Range("A1:E1") = Array("商品编码", "实际订货数量", "补货状态", "订货时间", "操作人")
    ws.Range("A2").CopyFromRecordset rs
    ws.Columns("A:E").AutoFit
    
    rs.Close: conn.Close
    MsgBox "已生成订货记录表", vbInformation
End Sub

' ============================================================
' 测试连接
' ============================================================
Sub 测试连接()
    Dim conn As Object
    Set conn = GetConn()
    If conn Is Nothing Then
        MsgBox "连接失败！", vbCritical
    Else
        MsgBox "连接成功！", vbInformation
        conn.Close
    End If
End Sub

' ============================================================
' 清除颜色
' ============================================================
Sub 清除颜色()
    Cells.Interior.ColorIndex = xlNone
End Sub
