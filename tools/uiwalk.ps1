# DeepCompose UI walkthrough driver: launch the exe, run a click/keys/capture
# step list, then kill it.
#
# Purpose : scripted UI acceptance without a human at the screen. Steps are
#           semicolon-separated, each "action|arg":
#             click|x,y   click window-relative coords (window top-left = 0,0)
#             keys|text   SendKeys text (supports {ENTER}, ^a, ...)
#             cap|out.png capture the window to a PNG (parent dirs created)
#             wait|ms     sleep
# Usage   : .\tools\uiwalk.ps1 -Steps "wait|2000;click|640,400;cap|shots\w1.png"
#           [-Exe <path>]
# Pitfalls: - Click coords are relative to the window rect measured at startup;
#             moving or resizing the window mid-run invalidates them.
#           - An ALT tap is injected around SetForegroundWindow (see below):
#             without it Windows silently rejects the foreground switch for a
#             background process and clicks/keys land somewhere else.
#           - SendKeys goes through the active keyboard layout; a Chinese IME
#             swallows raw ASCII keystrokes (e2e_chat.ps1 pastes via clipboard
#             instead).
# ASCII-only source (Windows PowerShell 5.1 misreads UTF-8 without BOM).
param(
    [string]$Exe = (Join-Path $PSScriptRoot "..\src-tauri\target\release\deepcompose.exe"),
    [string]$Steps = ""
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$sig = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class UW {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
    public delegate bool EnumProc(IntPtr h, IntPtr p);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
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
if (-not ("UW" -as [type])) { Add-Type -TypeDefinition $sig }

# N-16: the old implementation killed ALL deepcompose processes by name -- that
# also closed instances the user had open from another checkout or install.
# Here we only clear leftovers whose path matches this script's -Exe (those are
# from a previous uiwalk run), and at the end we only stop the process we started.
$exePath = if (Test-Path $Exe) { (Get-Item $Exe).FullName } else { $null }
if ($exePath) {
    Get-Process -Name deepcompose -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and $_.Path -eq $exePath } |
        Stop-Process -Force
    Start-Sleep -Milliseconds 500
}
$proc = Start-Process $Exe -PassThru
Start-Sleep -Seconds 9
$proc.Refresh()
# N-54: failure paths must also stop the process we started -- otherwise every
# failed run leaks one deepcompose process in the background (and the next run's
# cleanup would then be tempted to kill by name again).
if ($proc.HasExited) { Write-Output "FAIL exited: $($proc.ExitCode)"; exit 1 }

$h = [UW]::Pick([uint32]$proc.Id)
if ($h -eq [IntPtr]::Zero) {
    Write-Output "FAIL no window"
    Stop-Process -Id $proc.Id -Force
    exit 1
}
if ([UW]::IsIconic($h)) { [UW]::ShowWindow($h, 9) | Out-Null; Start-Sleep -Milliseconds 700 }
[UW]::ShowWindow($h, 5) | Out-Null
# ALT trick: release the foreground lock, otherwise SetForegroundWindow from a
# background process is silently rejected by the OS.
[UW]::keybd_event(0x12, 0, 0, [IntPtr]::Zero)
[UW]::SetForegroundWindow($h) | Out-Null
[UW]::keybd_event(0x12, 0, 2, [IntPtr]::Zero)
Start-Sleep -Milliseconds 900
[UW]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 400

$r = New-Object UW+RECT
[UW]::GetWindowRect($h, [ref]$r) | Out-Null
Write-Output "WINDOW $($r.Right - $r.Left) x $($r.Bottom - $r.Top) at ($($r.Left),$($r.Top))"
$ox = $r.Left; $oy = $r.Top

$ws = New-Object -ComObject WScript.Shell

function Save-Shot([string]$out) {
    $w = $r.Right - $r.Left; $ht = $r.Bottom - $r.Top
    [UW]::SetForegroundWindow($h) | Out-Null
    Start-Sleep -Milliseconds 700
    $bmp = New-Object System.Drawing.Bitmap -ArgumentList $w, $ht
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $hdc = $g.GetHdc()
    [UW]::PrintWindow($h, $hdc, 2) | Out-Null
    $g.ReleaseHdc($hdc)
    $g.Dispose()
    $dir = Split-Path -Parent $out
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Output "CAP $out"
}

# steps: semicolon-separated. Each: action|arg1|arg2
# N-54: validate each step's argument shape before acting -- a bare/missing
# "cap" argument made Split-Path receive an empty string and crash, killing the
# whole walk silently mid-run. Bad steps are skipped with a WARN instead.
$items = $Steps -split ";"
$shotsDir = Join-Path $PSScriptRoot "..\shots"
foreach ($it in $items) {
    $t = $it.Trim()
    if ($t -eq "") { continue }
    $p = $t -split "\|"
    switch ($p[0].Trim()) {
        "click" {
            if ($p.Count -lt 2 -or $p[1].Trim() -notmatch '^\d+\s*,\s*\d+$') {
                Write-Output "WARN bad click step (need 'click|x,y'): $t"
                continue
            }
            $xy = $p[1] -split ","
            $x = [int]$xy[0] + $ox
            $y = [int]$xy[1] + $oy
            [UW]::Click($x, $y)
            Write-Output "CLICK $x,$y"
            Start-Sleep -Milliseconds 900
        }
        "keys" {
            if ($p.Count -lt 2) { Write-Output "WARN bad keys step: $t"; continue }
            $ws.SendKeys($p[1]) | Out-Null
            Write-Output "KEYS $($p[1])"
            Start-Sleep -Milliseconds 500
        }
        "cap" {
            if ($p.Count -lt 2 -or [string]::IsNullOrWhiteSpace($p[1])) {
                Write-Output "WARN bad cap step (need 'cap|out.png'): $t"
                continue
            }
            # bare file names (no directory) land in shots\ so Split-Path -Parent
            # never receives an empty string
            $out = $p[1].Trim()
            if ($out -notmatch '[\\/]') { $out = Join-Path $shotsDir $out }
            Save-Shot $out
        }
        "wait" {
            if ($p.Count -lt 2 -or $p[1].Trim() -notmatch '^\d+$') {
                Write-Output "WARN bad wait step (need 'wait|ms'): $t"
                continue
            }
            Start-Sleep -Milliseconds ([int]$p[1])
        }
        default {
            Write-Output "WARN unknown step: $t"
        }
    }
}

# N-16: stop only the process we started (see header note); tolerate prior exit
if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
Write-Output "DONE"
