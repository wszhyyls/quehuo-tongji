' =====================================================
' VBA 模块：上传订货数量（ODBC版 - 无需额外安装）
' 适用：Office 2019 / 2016 / 365，直接使用Windows自带ODBC
' =====================================================

Option Explicit

' -----------------------------------------------------------
' 数据库连接参数
' -----------------------------------------------------------
Private Const SERVER As String = "121.229.175.49,1290"
Private Const DB As String = "RQZT"
Private Const USER As String = "zhyy02"
Private Const PWD As String = "你的密码"   ' <-- 改成你的密码

' -----------------------------------------------------------
' 核心函数：创建数据库连接
' -----------------------------------------------------------
Private Function OpenConn() As Object
    Dim conn As Object
    Set conn = CreateObject("ADODB.Connection")
    
    ' ODBC连接字符串 - 不需要任何额外安装的驱动
    Dim s As String
    s = "Driver={ODBC Driver 17 for SQL Server};" & _
        "Server=" & SERVER & ";" & _
        "Database=" & DB & ";" & _
        "UID=" & USER & ";PWD=" & PWD & ";" & _
        "TrustServerCertificate=yes;"
    
    On Error Resume Next
    conn.Open s
    On Error GoTo 0
    
    If conn.State = 1 Then
        Set OpenConn = conn
    Else
        ' 降级：尝试ODBC Driver 13
        s = "Driver={ODBC Driver 13 for SQL Server};" & _
            "Server=" & SERVER & ";" & _
            "Database=" & DB & ";" & _
            "UID=" & USER & ";PWD=" & PWD & ";" & _
            "TrustServerCertificate=yes;"
        On Error Resume Next
        conn.Open s
        On Error GoTo 0
        
        If conn.State = 1 Then
            Set OpenConn = conn
        Else
            Set OpenConn = Nothing
        End If
    End If
End Function

' -----------------------------------------------------------
' 主程序：上传订货数量
' -----------------------------------------------------------
Sub 上传订货数量()
    
    Dim conn As Object
    Set conn = OpenConn()
    
    If conn Is Nothing Then
        MsgBox "连接失败！" & vbCrLf & "请检查网络和密码", vbCritical, "错误"
        Exit Sub
    End If
    
    ' 列配置（根据截图：A=商品编码，X=实际订货）
    Dim colCode As String, colQty As String
    colCode = "A"
    colQty = "X"
    
    ' 获取最后行
    Dim lastRow As Long
    lastRow = Cells(Rows.Count, colCode).End(xlUp).Row
    If lastRow < 2 Then
        MsgBox "没有数据", vbExclamation
        conn.Close: Exit Sub
    End If
    
    ' 循环写入
    Dim success As Long, fail As Long
    success = 0: fail = 0
    
    Dim i As Long
    For i = 2 To lastRow
        Dim code As String, qty As Variant
        code = Trim(Cells(i, colCode).Value)
        qty = Cells(i, colQty).Value
        
        ' 跳过空行或0
        If code = "" Then GoTo NextRow
        If Not IsNumeric(qty) Then GoTo NextRow
        If qty = 0 Or qty = "" Then GoTo NextRow
        
        ' 执行存储过程
        Dim sql As String
        sql = "EXEC dbo.usp_UpdateActualOrder @商品编码='" & Replace(code, "'", "''") & "',@实际订货数量=" & CLng(qty) & ",@操作人='VBA'"
        
        On Error Resume Next
        conn.Execute sql
        On Error GoTo 0
        
        If Err.Number = 0 Then
            success = success + 1
            Cells(i, colQty).Interior.Color = RGB(198, 239, 206)  ' 绿
        Else
            fail = fail + 1
            Cells(i, colQty).Interior.Color = RGB(255, 199, 206)  ' 红
            Err.Clear
        End If
        
        ' 每20行更新状态栏
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

' -----------------------------------------------------------
' 查看订货记录
' -----------------------------------------------------------
Sub 查看订货记录()
    Dim conn As Object
    Set conn = OpenConn()
    If conn Is Nothing Then MsgBox "连接失败", vbCritical: Exit Sub
    
    Dim sql As String, rs As Object
    sql = "SELECT 商品编码,实际订货数量,补货状态,订货时间,操作人 FROM dbo.Shortage_OrderFeedback ORDER BY 订货时间 DESC"
    Set rs = CreateObject("ADODB.Recordset")
    rs.Open sql, conn
    
    If rs.EOF Then
        MsgBox "暂无记录"
        rs.Close: conn.Close: Exit Sub
    End If
    
    ' 写入新sheet
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
    
    ' 表头
    ws.Range("A1:E1") = Array("商品编码", "实际订货数量", "补货状态", "订货时间", "操作人")
    ws.Range("A2").CopyFromRecordset rs
    ws.Columns("A:E").AutoFit
    
    rs.Close: conn.Close
    MsgBox "已生成订货记录表", vbInformation
End Sub

' -----------------------------------------------------------
' 清除颜色
' -----------------------------------------------------------
Sub 清除颜色()
    Cells.Interior.ColorIndex = xlNone
End Sub
