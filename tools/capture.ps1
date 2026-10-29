# DeepCompose window capture: launch the exe, restore its window, save a PNG.
#
# Purpose : verify UI rendering without a human looking at the screen. Escape
#           is sent first so the shot always shows the main view, which makes
#           the capture deterministic across runs.
# Usage   : .\tools\capture.ps1 [-Exe <path>] [-Out <png>] [-WaitSec <seconds>]
#           Path defaults are derived from the repo root (parent of tools\).
# Pitfalls: - A freshly started window can be born minimized; without the
#             restore below the capture is a 160x28 off-screen frame at
#             (-32000,-32000).
#           - PrintWindow may return false on WebView2; the script then falls
#             back to a screen copy, which needs the window in the foreground.
#           - The app process is force-killed at the end, so any unsaved
#             in-app state is lost by design.
# ASCII-only on purpose: Windows PowerShell 5.1 misreads UTF-8 files without BOM.
param(
    [string]$Exe = (Join-Path $PSScriptRoot "..\src-tauri\target\release\deepcompose.exe"),
    [string]$Out = (Join-Path $PSScriptRoot "..\shots\shot-deepcompose.png"),
    [int]$WaitSec = 10
)

$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
# N-55: without ErrorActionPreference, any mid-run cmdlet failure (bitmap
# creation / COM unavailable) printed one red line and kept going, still
# emitting SAVED at the end -- output contradicted reality. Stop = fail fast,
# so the output can be trusted as a verdict.
$ErrorActionPreference = "Stop"

# B12-8: a bare file name has no parent directory -- Split-Path -Parent returns ""
# and New-Item -Path "" terminates the script (ErrorActionPreference=Stop) while the
# app we launched keeps running. Resolve bare names into shots\ (same rule as uiwalk).
if ($Out -notmatch '[\\/]') { $Out = Join-Path $PSScriptRoot "..\shots\$Out" }

Add-Type -AssemblyName System.Drawing

$sig = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinCap {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
    public delegate bool EnumProc(IntPtr h, IntPtr p);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT lpRect);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    // Pick the largest visible top-level window owned by pid (the app window,
    // not WebView2 helper windows). Prefer one whose title matches.
    public static IntPtr Pick(uint pid, string titleLike) {
        IntPtr best = IntPtr.Zero; int bestArea = 0;
        EnumWindows((h, p) => {
            uint wpid; GetWindowThreadProcessId(h, out wpid);
            if (wpid != pid || !IsWindowVisible(h)) return true;
            var t = new StringBuilder(512); GetWindowText(h, t, 512);
            if (!String.IsNullOrEmpty(titleLike) && t.ToString().IndexOf(titleLike) < 0) return true;
            RECT r; GetWindowRect(h, out r);
            int a = (r.Right - r.Left) * (r.Bottom - r.Top);
            if (a > bestArea) { bestArea = a; best = h; }
            return true;
        }, IntPtr.Zero);
        return best;
    }
}
'@
if (-not ("WinCap" -as [type])) { Add-Type -TypeDefinition $sig }

$proc = Start-Process $Exe -PassThru
try {
Start-Sleep -Seconds $WaitSec
$proc.Refresh()

if ($proc.HasExited) {
    Write-Output "FAIL process exited: $($proc.ExitCode)"
    exit 1
}

$h = [WinCap]::Pick([uint32]$proc.Id, $null)
if ($h -eq [IntPtr]::Zero) {
    Write-Output "FAIL no visible window for pid $($proc.Id)"
    Stop-Process -Id $proc.Id -Force
    exit 1
}

# A freshly started window can be born minimized; restore it, else the capture
# is a 160x28 off-screen frame at (-32000,-32000).
if ([WinCap]::IsIconic($h)) { [WinCap]::ShowWindow($h, 9) | Out-Null; Start-Sleep -Milliseconds 800 }
[WinCap]::ShowWindow($h, 5) | Out-Null
Start-Sleep -Milliseconds 400
[WinCap]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 900

# Deterministic view: Escape always returns the app to the main screen
# (App.tsx: keydown Escape -> setView("main")). Without this, whatever the
# pointer happened to click before the capture decides which screen we get.
try {
    $ws = New-Object -ComObject WScript.Shell
    $ws.SendKeys("{ESC}")
    Start-Sleep -Milliseconds 600
} catch {
    Write-Output "WARN SendKeys failed: $_"
}
[WinCap]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 500

$r = New-Object WinCap+RECT
[WinCap]::GetWindowRect($h, [ref]$r) | Out-Null
$w = [int]($r.Right - $r.Left)
$ht = [int]($r.Bottom - $r.Top)
Write-Output "WINDOW $w x $ht  (L=$($r.Left) T=$($r.Top))"

$bmp = New-Object System.Drawing.Bitmap -ArgumentList $w, $ht
if ($null -eq $bmp) {
    Write-Output "FAIL bitmap is null"
    Stop-Process -Id $proc.Id -Force
    exit 1
}

$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$ok = [WinCap]::PrintWindow($h, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()

if (-not $ok) {
    Write-Output "WARN PrintWindow returned false, falling back to screen copy"
    $g2 = [System.Drawing.Graphics]::FromImage($bmp)
    $g2.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size -ArgumentList $w, $ht))
    $g2.Dispose()
}

$dir = Split-Path -Parent $Out
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

Write-Output "SAVED $Out"
} finally {
    # B12-8: fail-fast paths (bitmap / COM / save errors) must still close the app
    # we launched -- otherwise every failed capture leaves a stray GUI process.
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
}
Write-Output "CLOSED"
