' =====================================================
' VBA 用户窗体：进度条 (ProgressBarForm)
' 使用方法：
'   1. 在 VBA 编辑器中 Insert > UserForm
'   2. 将窗体命名为 "ProgressBarForm"
'   3. 添加一个 Label (Label1) 和一个 ProgressBar (显示进度)
'   4. 将此类模块命名为 "ProgressBarForm"
' =====================================================

Option Explicit

' 窗体上的控件（需要手动在设计器中添加）
' - Label1   : 显示进度文字
' - Frame1   : 外框
' - Label2   : 进度条填充（用 Label 实现）

Private m_Total As Long
Private m_Current As Long

' 初始化进度条
Public Sub Init(ByVal total As Long)
    m_Total = total
    m_Current = 0
    Me.Caption = "正在回写..."
    Me.Label1.Caption = "准备就绪..."
End Sub

' 更新进度
Public Sub Update(ByVal current As Long)
    m_Current = current
    Dim pct As Double
    If m_Total > 0 Then
        pct = (m_Current / m_Total) * 100
    Else
        pct = 0
    End If
    
    Me.Label1.Caption = "正在处理: " & m_Current & " / " & m_Total & " (" & Format(pct, "0") & "%)"
    Me.Repaint
    
    DoEvents
End Sub

' 关闭进度条
Public Sub Close()
    Unload Me
End Sub
