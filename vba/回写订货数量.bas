' ============================================================
' VBA 模块：回写实际订货数量到 SQL Server
' 用于采购计划 Excel 表，填写实际订货数量后点击按钮写入数据库
' ============================================================

Option Explicit

' -----------------------------------------------------------
' 数据库连接参数（根据实际情况修改）
' -----------------------------------------------------------
Private Const SERVER_NAME As String = "121.229.175.49,1290"
Private Const DATABASE_NAME As String = "RQZT"
Private Const DB_USER As String = "000000"
Private Const DB_PASSWORD As String = "1000000"

' -----------------------------------------------------------
' 获取数据库连接（使用原来的 Provider 方式）
' -----------------------------------------------------------
Private Function GetConn() As Object
    Dim conn As Object
    Set conn = CreateObject("ADODB.Connection")
    conn.Open "Provider=SQLOLEDB;Server=" & SERVER_NAME & ";Database=" & DATABASE_NAME & _
              ";UID=" & DB_USER & ";Password=" & DB_PASSWORD & ";"
    Set GetConn = conn
End Function

' -----------------------------------------------------------
' 主程序：回写实际订货数量
' 说明：读取当前 sheet 的 A列(商品编码) 和 X列(实际订货)
' -----------------------------------------------------------
Sub 回写实际订货()
    
    Dim conn As Object
    On Error GoTo ConnError
    Set conn = GetConn()
    
    ' 列配置
    Dim colCode As Long, colQty As Long
    colCode = 1   ' A列 - 商品编码
    colQty = 24  ' X列 - 实际订货数量（根据实际调整）
    
    ' 确认列配置
    Dim colInput As String
    colInput = InputBox("请输入'实际订货数量'所在列号（1=A, 24=X）：", "列配置", "24")
    If colInput = "" Then
        MsgBox "已取消"
        conn.Close: Exit Sub
    End If
    colQty = CLng(colInput)
    
    ' 获取最后行
    Dim lastRow As Long
    lastRow = Cells(Rows.Count, colCode).End(xlUp).Row
    
    If lastRow < 2 Then
        MsgBox "没有数据"
        conn.Close: Exit Sub
    End If
    
    ' 统计
    Dim success As Long, fail As Long, skip As Long
    success = 0: fail = 0: skip = 0
    
    Dim i As Long
    For i = 2 To lastRow
        Dim code As String, qty As Variant
        code = Trim(Cells(i, colCode).Value)
        qty = Cells(i, colQty).Value
        
        ' 跳过空行或无效数据
        If code = "" Then
            skip = skip + 1
            GoTo NextRow
        End If
        If IsEmpty(qty) Or qty = "" Or qty = 0 Then
            skip = skip + 1
            GoTo NextRow
        End If
        If Not IsNumeric(qty) Then
            skip = skip + 1
            GoTo NextRow
        End If
        
        ' 调用存储过程写入
        Dim sql As String
        sql = "EXEC dbo.usp_UpdateActualOrder " & _
              "@商品编码='" & Replace(code, "'", "''") & "', " & _
              "@实际订货数量=" & CLng(qty) & ", " & _
              "@操作人='VBA'"
        
        On Error Resume Next
        conn.Execute sql
        On Error GoTo 0
        
        If Err.Number = 0 Then
            success = success + 1
            Cells(i, colQty).Interior.Color = RGB(198, 239, 206)   ' 绿色
        Else
            fail = fail + 1
            Cells(i, colQty).Interior.Color = RGB(255, 199, 206)   ' 红色
            Cells(i, colQty).Interior.Color = RGB(255, 199, 206)
            Err.Clear
        End If
        
        ' 每20行刷新状态
        If i Mod 20 = 0 Then
            Application.StatusBar = "处理中: " & i & "/" & lastRow
            DoEvents
        End If
        
NextRow:
    Next i
    
    Application.StatusBar = False
    conn.Close
    Set conn = Nothing
    
    MsgBox "回写完成！" & vbCrLf & vbCrLf & _
           "成功：" & success & " 条" & vbCrLf & _
           "失败：" & fail & " 条" & vbCrLf & _
           "跳过：" & skip & " 条（空行或0值）", vbInformation

    Exit Sub

ConnError:
    MsgBox "数据库连接失败！" & vbCrLf & vbCrLf & _
           "错误：" & Err.Description & vbCrLf & vbCrLf & _
           "请检查：网络、服务器地址、用户名密码", vbCritical, "连接失败"
    If Not conn Is Nothing Then conn.Close
End Sub

' -----------------------------------------------------------
' 查看订货记录
' -----------------------------------------------------------
Sub 查看订货记录()
    Dim conn As Object
    On Error GoTo ConnError
    Set conn = GetConn()
    
    Dim sql As String, rs As Object
    sql = "SELECT 商品编码, 实际订货数量, 补货状态, 订货时间, 操作人 " & _
          "FROM dbo.Shortage_OrderFeedback " & _
          "ORDER BY 订货时间 DESC"
    
    Set rs = CreateObject("ADODB.Recordset")
    rs.Open sql, conn
    
    If rs.EOF Then
        MsgBox "暂无订货记录"
        rs.Close: conn.Close: Exit Sub
    End If
    
    ' 创建结果 sheet
    Dim ws As Worksheet
    On Error Resume Next
    Set ws = ThisWorkbook.Sheets("订货记录")
    On Error GoTo 0
    
    If ws Is Nothing Then
        Set ws = ThisWorkbook.Worksheets.Add
        ws.Name = "订货记录"
    Else
        ws.Cells.Clear
    End If
    
    ' 表头
    ws.Cells(1, 1).Value = "商品编码"
    ws.Cells(1, 2).Value = "实际订货数量"
    ws.Cells(1, 3).Value = "补货状态"
    ws.Cells(1, 4).Value = "订货时间"
    ws.Cells(1, 5).Value = "操作人"
    
    ' 写入数据
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
    conn.Close
    Set rs = Nothing
    Set conn = Nothing
    
    ws.Columns("A:E").AutoFit
    MsgBox "已生成订货记录表，共 " & (row - 2) & " 条", vbInformation
    Exit Sub

ConnError:
    MsgBox "连接失败：" & Err.Description, vbCritical
    If Not conn Is Nothing Then conn.Close
End Sub

' -----------------------------------------------------------
' 测试连接
' -----------------------------------------------------------
Sub 测试连接()
    Dim conn As Object
    On Error GoTo ConnError
    Set conn = GetConn()
    MsgBox "连接成功！", vbInformation
    conn.Close: Exit Sub

ConnError:
    MsgBox "连接失败：" & Err.Description, vbCritical
    If Not conn Is Nothing Then conn.Close
End Sub

' -----------------------------------------------------------
' 清除颜色标记
' -----------------------------------------------------------
Sub 清除颜色()
    Cells.Interior.ColorIndex = xlNone
    MsgBox "颜色已清除", vbInformation
End Sub
