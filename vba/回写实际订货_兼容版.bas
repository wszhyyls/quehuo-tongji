' =====================================================
' VBA 模块：回写实际订货数量到 SQL Server（兼容版）
' 用途：解决错误 3706 "未找到提供程序"
' 提供3种连接方式，自动降级适配
' =====================================================

Option Explicit

' -----------------------------------------------------------
' 连接参数（请根据实际情况修改）
' -----------------------------------------------------------
Private Const SERVER_NAME As String = "121.229.175.49,1290"
Private Const DATABASE_NAME As String = "RQZT"
Private Const DB_USER As String = "zhyy02"
Private Const DB_PASSWORD As String = "你的密码"   ' <-- 修改为实际密码

' -----------------------------------------------------------
' 获取可用的数据库连接
' 按优先级尝试：MSOLEDBSQL → SQLOLEDB → ODBC
' -----------------------------------------------------------
Private Function GetConnection() As Object
    
    Dim conn As Object
    Set conn = CreateObject("ADODB.Connection")
    
    Dim connStr As String
    
    ' 方式1：Microsoft OLE DB Driver for SQL Server（推荐，最新）
    On Error Resume Next
    connStr = "Provider=MSOLEDBSQL;Server=" & SERVER_NAME & ";Database=" & DATABASE_NAME & _
              ";UID=" & DB_USER & ";PWD=" & DB_PASSWORD & ";TrustServerCertificate=yes;"
    conn.Open connStr
    If Err.Number = 0 Then
        On Error GoTo 0
        Set GetConnection = conn
        Exit Function
    End If
    Err.Clear
    
    ' 方式2：SQL OLE DB Provider（兼容老系统）
    connStr = "Provider=SQLOLEDB;Server=" & SERVER_NAME & ";Database=" & DATABASE_NAME & _
              ";UID=" & DB_USER & ";PWD=" & DB_PASSWORD & ";"
    conn.Open connStr
    If Err.Number = 0 Then
        On Error GoTo 0
        Set GetConnection = conn
        Exit Function
    End If
    Err.Clear
    
    ' 方式3：ODBC 连接（最兼容，需要配置DSN或使用连接字符串）
    ' 免DSN方式：Driver={ODBC Driver 17 for SQL Server}
    connStr = "Driver={ODBC Driver 17 for SQL Server};Server=" & SERVER_NAME & ";Database=" & DATABASE_NAME & _
              ";UID=" & DB_USER & ";PWD=" & DB_PASSWORD & ";TrustServerCertificate=yes;"
    conn.Open connStr
    If Err.Number = 0 Then
        On Error GoTo 0
        Set GetConnection = conn
        Exit Function
    End If
    Err.Clear
    
    ' 方式4：ODBC Driver 11/13
    connStr = "Driver={ODBC Driver 13 for SQL Server};Server=" & SERVER_NAME & ";Database=" & DATABASE_NAME & _
              ";UID=" & DB_USER & ";PWD=" & DB_PASSWORD & ";TrustServerCertificate=yes;"
    conn.Open connStr
    If Err.Number = 0 Then
        On Error GoTo 0
        Set GetConnection = conn
        Exit Function
    End If
    Err.Clear
    
    ' 方式5：SQL Server Native Client 11.0
    connStr = "Provider=SQLNCLI11;Server=" & SERVER_NAME & ";Database=" & DATABASE_NAME & _
              ";UID=" & DB_USER & ";PWD=" & DB_PASSWORD & ";"
    conn.Open connStr
    If Err.Number = 0 Then
        On Error GoTo 0
        Set GetConnection = conn
        Exit Function
    End If
    Err.Clear
    
    On Error GoTo 0
    Set GetConnection = Nothing
    
End Function

' -----------------------------------------------------------
' 主程序：回写实际订货数量
' -----------------------------------------------------------
Sub 上传订货数量()
    
    ' 1. 获取连接
    Dim conn As Object
    Set conn = GetConnection()
    
    If conn Is Nothing Then
        MsgBox "无法连接到数据库！" & vbCrLf & vbCrLf & _
               "请尝试以下方案：" & vbCrLf & _
               "1. 安装 SQL Server ODBC 驱动" & vbCrLf & _
               "2. 检查网络连接" & vbCrLf & _
               "3. 修改连接字符串（见代码注释）", _
               vbCritical, "连接失败"
        Exit Sub
    End If
    
    ' 2. 确认列配置
    Dim colCode As String, colQty As String
    colCode = "A"   ' 商品编码列
    colQty = "X"    ' 实际订货数量列（根据你的表调整）
    
    ' 如果列不固定，可以弹出确认框
    ' colQty = InputBox("请输入'实际订货'所在列字母：", "列配置", "X")
    
    ' 3. 获取数据范围
    Dim lastRow As Long
    lastRow = Cells(Rows.Count, colCode).End(xlUp).Row
    
    If lastRow < 2 Then
        MsgBox "没有找到数据", vbExclamation
        conn.Close
        Exit Sub
    End If
    
    ' 4. 开始写入
    Dim successCount As Long, failCount As Long
    successCount = 0
    failCount = 0
    
    Dim i As Long
    For i = 2 To lastRow
        
        Dim productCode As String
        Dim actualQty As Variant
        
        productCode = Trim(Cells(i, colCode).Value)
        actualQty = Cells(i, colQty).Value
        
        ' 跳过空行或无效数据
        If productCode = "" Then GoTo NextRow
        If Not IsNumeric(actualQty) Then GoTo NextRow
        If actualQty = "" Or actualQty = 0 Then GoTo NextRow
        
        ' 调用存储过程
        Dim sql As String
        sql = "EXEC dbo.usp_UpdateActualOrder " & _
              "@商品编码='" & Replace(productCode, "'", "''") & "', " & _
              "@实际订货数量=" & CLng(actualQty) & ", " & _
              "@操作人='VBA'"
        
        On Error Resume Next
        conn.Execute sql
        On Error GoTo 0
        
        If Err.Number = 0 Then
            successCount = successCount + 1
            Cells(i, colQty).Interior.Color = RGB(198, 239, 206)   ' 绿色
        Else
            failCount = failCount + 1
            Cells(i, colQty).Interior.Color = RGB(255, 199, 206)   ' 红色
            Err.Clear
        End If
        
        ' 每10行刷新一次界面，避免卡顿
        If i Mod 10 = 0 Then
            Application.StatusBar = "正在上传：" & i & " / " & lastRow
            DoEvents
        End If
        
NextRow:
    Next i
    
    ' 5. 完成
    Application.StatusBar = False
    conn.Close
    Set conn = Nothing
    
    MsgBox "上传完成！" & vbCrLf & _
           "成功：" & successCount & " 条" & vbCrLf & _
           "失败：" & failCount & " 条", vbInformation, "回写结果"
    
End Sub

' -----------------------------------------------------------
' 查看订货状态
' -----------------------------------------------------------
Sub 查看订货状态()
    
    Dim conn As Object
    Set conn = GetConnection()
    
    If conn Is Nothing Then
        MsgBox "无法连接到数据库！", vbCritical
        Exit Sub
    End If
    
    Dim sql As String
    sql = "SELECT 商品编码, 实际订货数量, 补货状态, 订货时间, 操作人 " & _
          "FROM dbo.Shortage_OrderFeedback " & _
          "ORDER BY 订货时间 DESC"
    
    Dim rs As Object
    Set rs = CreateObject("ADODB.Recordset")
    rs.Open sql, conn
    
    If rs.EOF Then
        MsgBox "暂无订货记录"
        conn.Close
        Exit Sub
    End If
    
    ' 创建结果表
    Dim ws As Worksheet
    On Error Resume Next
    Set ws = ThisWorkbook.Worksheets("订货状态查询")
    On Error GoTo 0
    
    If ws Is Nothing Then
        Set ws = ThisWorkbook.Worksheets.Add
        ws.Name = "订货状态查询"
    Else
        ws.Cells.Clear
    End If
    
    ' 表头
    ws.Cells(1, 1).Value = "商品编码"
    ws.Cells(1, 2).Value = "实际订货数量"
    ws.Cells(1, 3).Value = "补货状态"
    ws.Cells(1, 4).Value = "订货时间"
    ws.Cells(1, 5).Value = "操作人"
    
    Dim row As Long
    row = 2
    Do While Not rs.EOF
        ws.Cells(row, 1).Value = rs("商品编码").Value
        ws.Cells(row, 2).Value = rs("实际订货数量").Value
        ws.Cells(row, 3).Value = rs("补货状态").Value
        ws.Cells(row, 4).Value = rs("订货时间").Value
        ws.Cells(row, 5).Value = rs("操作人").Value
        row = row + 1
        rs.MoveNext
    Loop
    
    rs.Close
    Set rs = Nothing
    conn.Close
    Set conn = Nothing
    
    ws.Columns("A:E").AutoFit
    MsgBox "已生成订货状态查询表，共 " & (row - 2) & " 条记录", vbInformation
    
End Sub

' -----------------------------------------------------------
' 清除颜色标记
' -----------------------------------------------------------
Sub 清除颜色标记()
    Cells.ClearFormats
    MsgBox "颜色标记已清除", vbInformation
End Sub

' -----------------------------------------------------------
' 测试数据库连接
' -----------------------------------------------------------
Sub 测试连接()
    
    Dim conn As Object
    Set conn = GetConnection()
    
    If conn Is Nothing Then
        MsgBox "连接失败！", vbCritical
    Else
        MsgBox "连接成功！" & vbCrLf & "数据库: " & conn.DefaultDatabase, vbInformation
        conn.Close
    End If
    
End Sub
