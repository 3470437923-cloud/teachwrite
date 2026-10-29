# DeepCompose end-to-end LIVE chat check: drives the real exe with whatever
# provider is already configured in shared_preferences.json (does NOT touch
# prefs, unlike e2e_chat.ps1 which seeds the mock provider).
#
# Purpose : smoke-test the real backend path:
#             1) launch deepcompose.exe
#             2) click the composer, type a prompt, press Enter
#             3) wait for the reply, capture the window
# Usage   : .\tools\e2e_live.ps1 [-Exe <path>] [-Out <png>] [-Prompt <text>]
#           [-WaitSec <n>] [-AfterSendSec <n>]
# Pitfalls: - Talks to the user's real configured provider; a slow or dead
#             upstream just yields no visible reply once -AfterSendSec runs out.
#           - The prompt is typed with raw SendKeys, so keep -Prompt ASCII: a
#             Chinese IME would swallow the keystrokes (e2e_chat.ps1 pastes via
#             clipboard for exactly this reason).
#           - PrintWindow on an unfocused WebView2 can return a blank frame, so
#             the window is re-foregrounded right before the capture.
# ASCII-only source (Windows PowerShell 5.1 misreads UTF-8 without BOM).
param(
    [string]$Exe = (Join-Path $PSScriptRoot "..\src-tauri\target\release\deepcompose.exe"),
    [string]$Out = (Join-Path $PSScriptRoot "..\shots\shot-live.png"),
    [string]$Prompt = "List the files in the chapter content folder of the current book.",
    [int]$WaitSec = 8,
    [int]$AfterSendSec = 45
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$sig = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class E2E {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
    public delegate bool EnumProc(IntPtr h, IntPtr p);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

    public static IntPtr Pick(uint pid) {
        IntPtr best = IntPtr.Zero; int area = 0;
        EnumWindows((h, p) => {
            uint wpid; GetWindowThreadProcessId(h, out wpid);
            if (wpid != pid || !IsWindowVisible(h)) return true;
            RECT r; GetWindowRect(h, out r);
            int a = (r.Right - r.Left) * (r.Bottom - r.Top);
            if (a > area) { area = a; best = h; }
            return true;
        }, IntPtr.Zero);
        return best;
    }
    public static void Click(int x, int y) {
        SetCursorPos(x, y);
        System.Threading.Thread.Sleep(150);
        mouse_event(0x0002, 0, 0, 0, IntPtr.Zero);
        System.Threading.Thread.Sleep(60);
        mouse_event(0x0004, 0, 0, 0, IntPtr.Zero);
    }
}
'@
if (-not ("E2E" -as [type])) { Add-Type -TypeDefinition $sig }

# N-16: only clear leftovers running THIS script's -Exe path -- never kill by
# name, which would take down other DeepCompose instances the user has open.
$exePath = if (Test-Path $Exe) { (Get-Item $Exe).FullName } else { $null }
if ($exePath) {
    Get-Process -Name deepcompose -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and $_.Path -eq $exePath } |
        Stop-Process -Force
    Start-Sleep -Milliseconds 500
}
$proc = Start-Process $Exe -PassThru
try {
Start-Sleep -Seconds $WaitSec
$proc.Refresh()
if ($proc.HasExited) { Write-Output "FAIL exited: $($proc.ExitCode)"; exit 1 }

$h = [E2E]::Pick([uint32]$proc.Id)
if ($h -eq [IntPtr]::Zero) { Write-Output "FAIL no window"; Stop-Process -Id $proc.Id -Force; exit 1 }
if ([E2E]::IsIconic($h)) { [E2E]::ShowWindow($h, 9) | Out-Null; Start-Sleep -Milliseconds 700 }
[E2E]::ShowWindow($h, 5) | Out-Null
[E2E]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 900

$r = New-Object E2E+RECT
[E2E]::GetWindowRect($h, [ref]$r) | Out-Null
$w = $r.Right - $r.Left; $ht = $r.Bottom - $r.Top
Write-Output "WINDOW $w x $ht at ($($r.Left),$($r.Top))"

# click the composer (inside the chat column, lower area)
$cx = $r.Left + [int]($w * 0.25)
$cy = $r.Top + $ht - 90
Write-Output "CLICK ($cx,$cy)"
[E2E]::Click($cx, $cy)
Start-Sleep -Milliseconds 600
$ws = New-Object -ComObject WScript.Shell
$ws.SendKeys($Prompt)
Start-Sleep -Milliseconds 500
$ws.SendKeys("{ENTER}")
Start-Sleep -Milliseconds 400
$ws.SendKeys("{ENTER}")
Write-Output "SENT"
Start-Sleep -Seconds $AfterSendSec

# focus + capture (PrintWindow on an unfocused WebView2 can return a blank frame)
[E2E]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 900
$bmp = New-Object System.Drawing.Bitmap -ArgumentList $w, $ht
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[E2E]::PrintWindow($h, $hdc, 2) | Out-Null
$g.ReleaseHdc($hdc)
$g.Dispose()
$dir = Split-Path -Parent $Out
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "SAVED $Out"

} finally {
    # N-16 + B12-8: stop only the process we started (see note above), and do it on
    # the exception path too -- capture/COM/SendKeys failures used to leak the app.
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
}
Write-Output "CLOSED"
