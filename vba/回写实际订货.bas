' =====================================================
' VBA 模块：回写实际订货数量到 SQL Server
' 用途：在采购计划 Excel 表中填写实际订货数量后，点击按钮写入 RQZT 数据库
' 表：dbo.Shortage_OrderFeedback
' 存储过程：dbo.usp_UpdateActualOrder
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
' 主程序：回写实际订货数量
' 假设 Excel 列布局：
'   A列 = 商品编码
'   X列 = 实际订货数量  （根据你的表调整列号）
' -----------------------------------------------------------
Sub 回写实际订货()
    
    Dim conn As Object
    Set conn = CreateObject("ADODB.Connection")
    
    ' 连接 SQL Server
    On Error GoTo ConnError
    conn.Open "Provider=SQLOLEDB;Server=" & SERVER_NAME & ";Database=" & DATABASE_NAME & _
              ";UID=" & DB_USER & ";PWD=" & DB_PASSWORD & ";"
    On Error GoTo 0
    
    ' 确认列配置
    Dim colCode As String, colQty As String
    colCode = "A"                       ' 商品编码所在列
    colQty = InputBox("请输入'实际订货数量'所在列的字母：", "列配置", "X")
    If colQty = "" Then
        MsgBox "已取消操作"
        conn.Close
        Exit Sub
    End If
    
    ' 获取最后一行
    Dim lastRow As Long
    lastRow = Cells(Rows.Count, colCode).End(xlUp).Row
    
    If lastRow < 2 Then
        MsgBox "没有找到数据（从第2行开始）"
        conn.Close
        Exit Sub
    End If
    
    ' 进度条
    Dim progBar As Object
    Set progBar = CreateProgressBar(lastRow - 1)
    
    ' 开始写入
    Dim successCount As Long
    Dim failCount As Long
    Dim errorLog As String
    successCount = 0
    failCount = 0
    errorLog = ""
    
    Dim i As Long
    For i = 2 To lastRow   ' 从第2行开始（跳过表头）
        
        ' 更新进度
        progBar.Update i - 1
        
        Dim productCode As String
        Dim actualQty As Variant
        
        productCode = Trim(Cells(i, colCode).Value)
        actualQty = Cells(i, colQty).Value
        
        ' 跳过空行或无效数据
        If productCode = "" Then GoTo NextRow
        If Not IsNumeric(actualQty) Then GoTo NextRow
        If actualQty = "" Or actualQty = 0 Then GoTo NextRow
        
        ' 调用存储过程写入
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
            ' 标绿
            Cells(i, colQty).Interior.Color = RGB(198, 239, 206)
        Else
            failCount = failCount + 1
            errorLog = errorLog & "行" & i & ": " & productCode & " - " & Err.Description & vbCrLf
            ' 标红
            Cells(i, colQty).Interior.Color = RGB(255, 199, 206)
            Err.Clear
        End If
        
NextRow:
    Next i
    
    ' 关闭进度条
    progBar.Close
    
    ' 完成提示
    conn.Close
    Set conn = Nothing
    
    Dim msg As String
    msg = "写入完成！" & vbCrLf & _
          "成功：" & successCount & " 条" & vbCrLf & _
          "失败：" & failCount & " 条"
    
    If failCount > 0 Then
        msg = msg & vbCrLf & vbCrLf & "错误日志：" & vbCrLf & Left(errorLog, 500)
    End If
    
    MsgBox msg, vbInformation, "回写实际订货"
    
    Exit Sub

ConnError:
    MsgBox "数据库连接失败！" & vbCrLf & vbCrLf & Err.Description, vbCritical, "连接错误"
    Exit Sub

End Sub

' -----------------------------------------------------------
' 查看当前订货状态
' -----------------------------------------------------------
Sub 查看订货状态()
    
    Dim conn As Object
    Set conn = CreateObject("ADODB.Connection")
    
    On Error GoTo ConnError
    conn.Open "Provider=SQLOLEDB;Server=" & SERVER_NAME & ";Database=" & DATABASE_NAME & _
              ";UID=" & DB_USER & ";PWD=" & DB_PASSWORD & ";"
    On Error GoTo 0
    
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
    Set ws = ThisWorkbook.Worksheets.Add
    ws.Name = "订货状态查询"
    
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
    
    ' 格式化
    ws.Columns("A:E").AutoFit
    
    MsgBox "已生成订货状态查询表，共 " & (row - 2) & " 条记录", vbInformation

    Exit Sub

ConnError:
    MsgBox "数据库连接失败！" & vbCrLf & vbCrLf & Err.Description, vbCritical, "连接错误"
    Exit Sub

End Sub

' -----------------------------------------------------------
' 清除当前 sheet 中的颜色标记
' -----------------------------------------------------------
Sub 清除颜色标记()
    Cells.ClearFormats
    MsgBox "颜色标记已清除"
End Sub

' =====================================================
' 辅助函数：简单进度条
' =====================================================
Private Function CreateProgressBar(total As Long) As Object
    
    Dim prog As Object
    Set prog = New ProgressBarForm
    prog.Init total
    prog.Show
    prog.Repaint
    
    Set CreateProgressBar = prog
    
End Function
