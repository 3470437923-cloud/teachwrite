# Measure a Tauri window's resize affordances and maximize behaviour for real.
#
# Purpose : answer two questions with numbers instead of opinions:
#   1. can the OS resize this window by dragging its edge?  (WS_THICKFRAME)
#      A frameless Tauri window with decorations:false keeps WS_THICKFRAME only
#      if the runtime sets it; without it the only resize path is maximize.
#   2. does clicking maximise actually change the size?  (rect before/after
#      WM_SYSCOMMAND SC_MAXIMIZE)  If the default window already fills the work
#      area, maximise is visually a no-op.
# Usage   : .\tools\probe_win_style.ps1 [-Exe <path>] [-WaitSec <seconds>]
#           Default -Exe is the packaged build release\DeepCompose.exe.
# Pitfalls: - Needs a real interactive desktop session; measurements taken in a
#             locked or headless session are not meaningful.
#           - Stops leftovers running THIS build's exe first (never instances
#             from another path) and force-kills its own probe instance at the
#             end, so unsaved state of that probe copy is lost.
# ASCII-only on purpose: Windows PowerShell 5.1 misreads UTF-8 files without BOM.
param(
    [string]$Exe = (Join-Path $PSScriptRoot "..\release\DeepCompose.exe"),
    [int]$WaitSec = 12
)

$ErrorActionPreference = "Stop"

$sig = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinStyle {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
    public delegate bool EnumProc(IntPtr h, IntPtr p);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
    [DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint a, uint b, ref RECT r, uint c);
    [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    public static IntPtr Pick(uint pid) {
        IntPtr best = IntPtr.Zero; int bestArea = 0;
        EnumWindows((h, p) => {
            uint wpid; GetWindowThreadProcessId(h, out wpid);
            if (wpid != pid || !IsWindowVisible(h)) return true;
            RECT r; GetWindowRect(h, out r);
            int a = (r.Right - r.Left) * (r.Bottom - r.Top);
            if (a > bestArea) { bestArea = a; best = h; }
            return true;
        }, IntPtr.Zero);
        return best;
    }
}
'@
if (-not ("WinStyle" -as [type])) { Add-Type -TypeDefinition $sig }

function Rect-Of([IntPtr]$h) {
    $r = New-Object WinStyle+RECT
    [WinStyle]::GetWindowRect($h, [ref]$r) | Out-Null
    return @{ x = $r.Left; y = $r.Top; w = $r.Right - $r.Left; h = $r.Bottom - $r.Top }
}
function Fmt($r) { return ("{0}x{1} at ({2},{3})" -f $r.w, $r.h, $r.x, $r.y) }

# --- screen and work area -------------------------------------------------
$sw = [WinStyle]::GetSystemMetrics(0)
$sh = [WinStyle]::GetSystemMetrics(1)
$wa = New-Object WinStyle+RECT
[WinStyle]::SystemParametersInfo(0x0030, 0, [ref]$wa, 0) | Out-Null   # SPI_GETWORKAREA
Write-Output "screen    = ${sw}x${sh}"
Write-Output ("workarea  = {0}x{1} at ({2},{3})" -f ($wa.Right - $wa.Left), ($wa.Bottom - $wa.Top), $wa.Left, $wa.Top)
Write-Output ""

# N-16: only stop leftovers running THIS script's -Exe (a previous probe run).
# Killing by process name would also take down DeepCompose instances the user
# has open from another checkout or installed copy.
$exePath = if (Test-Path $Exe) { (Get-Item $Exe).FullName } else { $null }
if ($exePath) {
    Get-Process -Name deepcompose -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and $_.Path -eq $exePath } |
        Stop-Process -Force
}
Start-Sleep -Seconds 1

$proc = Start-Process $Exe -PassThru
Start-Sleep -Seconds $WaitSec
$proc.Refresh()
if ($proc.HasExited) { Write-Output "FAIL exited: $($proc.ExitCode)"; exit 1 }

$h = [WinStyle]::Pick([uint32]$proc.Id)
if ($h -eq [IntPtr]::Zero) { Write-Output "FAIL no window"; Stop-Process -Id $proc.Id -Force; exit 1 }

if ([WinStyle]::IsIconic($h)) { [WinStyle]::ShowWindow($h, 9) | Out-Null; Start-Sleep -Milliseconds 900 }
Start-Sleep -Milliseconds 600

# --- window styles --------------------------------------------------------
$GWL_STYLE = -16
$style = [int64][WinStyle]::GetWindowLongPtr($h, $GWL_STYLE)
$flags = [ordered]@{
    "WS_THICKFRAME (drag edge to resize)" = 0x00040000
    "WS_MAXIMIZEBOX"                      = 0x00010000
    "WS_MINIMIZEBOX"                      = 0x00020000
    "WS_CAPTION"                          = 0x00C00000
    "WS_SYSMENU"                          = 0x00080000
    # B12-8: 0x80000000 without the L suffix is an Int32 in Windows PowerShell 5.1
    # (-2147483648); the -band against an Int64 style sign-extends it, so a real
    # WS_POPUP window reported "no". Force the Int64 literal.
    "WS_POPUP"                            = 0x80000000L
}
Write-Output ("style = 0x{0:X8}" -f $style)
foreach ($k in $flags.Keys) {
    $on = ($style -band $flags[$k]) -eq $flags[$k]
    Write-Output ("  {0,-38} {1}" -f $k, $(if ($on) { "YES" } else { "no" }))
}
Write-Output ""

# --- maximise / restore behaviour ----------------------------------------
$r0 = Rect-Of $h
Write-Output "before maximise : $(Fmt $r0)  zoomed=$([WinStyle]::IsZoomed($h))"

[WinStyle]::SendMessage($h, 0x0112, [IntPtr]0xF030, [IntPtr]::Zero) | Out-Null   # WM_SYSCOMMAND SC_MAXIMIZE
Start-Sleep -Milliseconds 1200
$r1 = Rect-Of $h
Write-Output "after  maximise : $(Fmt $r1)  zoomed=$([WinStyle]::IsZoomed($h))"

[WinStyle]::SendMessage($h, 0x0112, [IntPtr]0xF120, [IntPtr]::Zero) | Out-Null   # WM_SYSCOMMAND SC_RESTORE
Start-Sleep -Milliseconds 1200
$r2 = Rect-Of $h
Write-Output "after  restore  : $(Fmt $r2)  zoomed=$([WinStyle]::IsZoomed($h))"

$dw = [math]::Abs($r1.w - $r0.w); $dh = [math]::Abs($r1.h - $r0.h)
Write-Output ""
Write-Output "maximise changed size by ${dw}x${dh} px"
$frac = [math]::Round(100.0 * $r0.w * $r0.h / (($wa.Right - $wa.Left) * ($wa.Bottom - $wa.Top)))
Write-Output "the startup window already covers ${frac}% of the work area"
if ($dw -le 8 -and $dh -le 8) {
    Write-Output "VERDICT: maximise is visually a no-op at the default size"
} else {
    Write-Output "VERDICT: maximise does change the size"
}

Stop-Process -Id $proc.Id -Force
Write-Output ""
Write-Output "DONE"