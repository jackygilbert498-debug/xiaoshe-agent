[CmdletBinding()]
param(
    [string]$StatePath = (Join-Path $env:LOCALAPPDATA 'Xiaoshe\Acceptance\windows-screen-smoke.json')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class XiaosheAcceptanceNative {
    [DllImport("user32.dll")]
    public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")]
    public static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")]
    public static extern bool HideCaret(IntPtr hwnd);
}
'@

# Per-monitor-v2 DPI awareness keeps UIA rectangles and action coordinates in the
# same physical-pixel space at 125%, 150%, and 200% display scaling.
[XiaosheAcceptanceNative]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
[System.Windows.Forms.Application]::EnableVisualStyles()

$stateDirectory = Split-Path -Parent $StatePath
[System.IO.Directory]::CreateDirectory($stateDirectory) | Out-Null

$form = [System.Windows.Forms.Form]::new()
$form.Name = 'XIAOSHE_SAFE_WINDOW'
$form.AccessibleName = 'Xiaoshe Windows Acceptance'
$form.Text = 'Xiaoshe Windows Acceptance'
$form.StartPosition = 'CenterScreen'
$form.ClientSize = [System.Drawing.Size]::new(720, 390)
$form.TopMost = $true

$heading = [System.Windows.Forms.Label]::new()
$heading.Text = 'Xiaoshe Windows Safe Acceptance'
$heading.Font = [System.Drawing.Font]::new('Microsoft YaHei UI', 18, [System.Drawing.FontStyle]::Bold)
$heading.AutoSize = $true
$heading.Location = [System.Drawing.Point]::new(36, 30)
$form.Controls.Add($heading)

$instructions = [System.Windows.Forms.Label]::new()
$instructions.Text = 'This window contains synthetic data only. UIA may safely inspect every control.'
$instructions.Font = [System.Drawing.Font]::new('Microsoft YaHei UI', 11)
$instructions.AutoSize = $true
$instructions.Location = [System.Drawing.Point]::new(38, 82)
$form.Controls.Add($instructions)

$button = [System.Windows.Forms.Button]::new()
$button.Name = 'XIAOSHE_SAFE_BUTTON'
$button.AccessibleName = 'XIAOSHE_SAFE_BUTTON'
$button.Text = 'Safe click target'
$button.Font = [System.Drawing.Font]::new('Microsoft YaHei UI', 12)
$button.Location = [System.Drawing.Point]::new(40, 132)
$button.Size = [System.Drawing.Size]::new(210, 56)
$form.Controls.Add($button)

$focusButton = [System.Windows.Forms.Button]::new()
$focusButton.Name = 'XIAOSHE_FOCUS_INPUT'
$focusButton.AccessibleName = 'XIAOSHE_FOCUS_INPUT'
$focusButton.Text = 'Focus safe input'
$focusButton.Font = [System.Drawing.Font]::new('Microsoft YaHei UI', 12)
$focusButton.Location = [System.Drawing.Point]::new(280, 132)
$focusButton.Size = [System.Drawing.Size]::new(210, 56)
$form.Controls.Add($focusButton)

$textBox = [System.Windows.Forms.TextBox]::new()
$textBox.Name = 'XIAOSHE_SAFE_INPUT'
$textBox.AccessibleName = 'XIAOSHE_SAFE_INPUT'
$textBox.Font = [System.Drawing.Font]::new('Microsoft YaHei UI', 12)
$textBox.Location = [System.Drawing.Point]::new(40, 218)
$textBox.Size = [System.Drawing.Size]::new(620, 38)
$textBox.Text = 'Synthetic acceptance text only'
$form.Controls.Add($textBox)

$status = [System.Windows.Forms.Label]::new()
$status.Name = 'XIAOSHE_SAFE_STATUS'
$status.AccessibleName = 'XIAOSHE_SAFE_STATUS'
$status.Text = 'READY'
$status.Font = [System.Drawing.Font]::new('Consolas', 12, [System.Drawing.FontStyle]::Bold)
$status.AutoSize = $true
$status.Location = [System.Drawing.Point]::new(40, 295)
$form.Controls.Add($status)

$script:actionCount = 0
function Write-AcceptanceState {
    param([string]$Lifecycle)

    $bounds = $form.Bounds
    $dpi = if ($form.IsHandleCreated) { [XiaosheAcceptanceNative]::GetDpiForWindow($form.Handle) } else { 96 }
    $payload = [ordered]@{
        schema = 1
        lifecycle = $Lifecycle
        processId = $PID
        windowTitle = $form.Text
        windowHandle = if ($form.IsHandleCreated) { $form.Handle.ToInt64() } else { 0 }
        dpi = $dpi
        displayScalePercent = [math]::Round(($dpi / 96.0) * 100)
        physicalScreen = [ordered]@{
            width = [XiaosheAcceptanceNative]::GetSystemMetrics(0)
            height = [XiaosheAcceptanceNative]::GetSystemMetrics(1)
        }
        windowBounds = [ordered]@{ x = $bounds.X; y = $bounds.Y; width = $bounds.Width; height = $bounds.Height }
        controls = [ordered]@{
            button = 'XIAOSHE_SAFE_BUTTON'
            focusInput = 'XIAOSHE_FOCUS_INPUT'
            input = 'XIAOSHE_SAFE_INPUT'
            status = 'XIAOSHE_SAFE_STATUS'
        }
        status = $status.Text
        inputLength = $textBox.TextLength
        actionCount = $script:actionCount
        cleanup = "Close only the window titled '$($form.Text)' or stop process $PID."
        updatedAt = [DateTimeOffset]::Now.ToString('o')
    }
    $payload | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $StatePath -Encoding utf8
}

$button.Add_Click({
    $script:actionCount++
    $status.Text = "CLICKED:$script:actionCount"
    Write-AcceptanceState -Lifecycle 'running'
})
$focusButton.Add_Click({
    $script:actionCount++
    $status.Text = "FOCUSED:$script:actionCount"
    $textBox.Focus() | Out-Null
    [XiaosheAcceptanceNative]::HideCaret($textBox.Handle) | Out-Null
    Write-AcceptanceState -Lifecycle 'running'
})
$textBox.Add_TextChanged({
    if ($form.Visible) {
        [XiaosheAcceptanceNative]::HideCaret($textBox.Handle) | Out-Null
        $status.Text = "TEXT:$($textBox.TextLength)"
        Write-AcceptanceState -Lifecycle 'running'
    }
})
$textBox.Add_KeyDown({
    param($sender, $eventArgs)
    if ($eventArgs.KeyCode -eq [System.Windows.Forms.Keys]::Enter) {
        $script:actionCount++
        $status.Text = "ENTER:$($textBox.TextLength)"
        $eventArgs.SuppressKeyPress = $true
        Write-AcceptanceState -Lifecycle 'running'
    }
})
$form.Add_Shown({
    $form.Activate()
    Write-AcceptanceState -Lifecycle 'running'
})
$form.Add_FormClosed({ Write-AcceptanceState -Lifecycle 'closed' })

[System.Windows.Forms.Application]::Run($form)
