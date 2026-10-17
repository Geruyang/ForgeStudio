# 用 UIAutomation 操控"选择文件夹"原生对话框：地址栏 SetValue 路径 → Invoke"选择文件夹"按钮
# 用法: powershell -File filedialog-uia.ps1 [-Shot <png路径>] [-Dir <目标目录>]
param(
  [string]$Dir = 'E:\AiProject\agent-design\ForgeDesk-zcode\engineering\fixtures\sample-tool',
  [string]$Shot = ''
)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing

# Win32 枚举找"选择文件夹"对话框句柄（比 UIA 树搜索可靠），再 FromHandle 转 UIA 元素
Add-Type @'
using System; using System.Runtime.InteropServices; using System.Text;
public class FDU {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
}
'@
$hwnd = [IntPtr]::Zero
$deadline = (Get-Date).AddSeconds(10)
while ($hwnd -eq [IntPtr]::Zero -and (Get-Date) -lt $deadline) {
  $script:found = [IntPtr]::Zero
  $cb = { param($h, $l) if ([FDU]::IsWindowVisible($h)) { $c = New-Object System.Text.StringBuilder 256; [void][FDU]::GetClassName($h, $c, 256); if ($c.ToString() -eq '#32770') { $t = New-Object System.Text.StringBuilder 256; [void][FDU]::GetWindowText($h, $t, 256); if ($t.ToString() -match '选择文件夹|Select Folder') { $script:found = $h } } }; $true }
  [void][FDU]::EnumWindows($cb, [IntPtr]::Zero)
  if ($script:found -ne [IntPtr]::Zero) { $hwnd = $script:found } else { Start-Sleep -Milliseconds 400 }
}
if ($hwnd -eq [IntPtr]::Zero) { Write-Output 'DIALOG-NOT-FOUND'; exit 1 }
$dlg = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
Write-Output "DIALOG: $($dlg.Current.Name) hwnd=$hwnd"

# 截图（可选）
if ($Shot) {
  Add-Type -AssemblyName System.Windows.Forms
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($vs.X, $vs.Y, 0, 0, $bmp.Size)
  $bmp.Save($Shot, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Output "SHOT: $Shot"
}

# 显式前台化对话框后键盘导航：Alt+D 聚焦地址栏 → 路径 → Enter（定位）→ Enter（确认）
# （Win11 文件对话框地址栏是自定义控件，UIA ValuePattern 不可用；唯一标准 Edit 是搜索框——勿动）
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System.Runtime.InteropServices;
public class FDFG {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
}
'@
[void][FDFG]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 800
[System.Windows.Forms.SendKeys]::SendWait('%d')
Start-Sleep -Milliseconds 700
[System.Windows.Forms.SendKeys]::SendWait($Dir)
Start-Sleep -Milliseconds 500
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Start-Sleep -Milliseconds 1800
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Start-Sleep -Milliseconds 1000
Write-Output 'UIA-DONE'
