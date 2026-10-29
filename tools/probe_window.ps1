# Verify window geometry memory on the real DeepCompose exe, end to end.
# (Renamed from probe_writerd_window.ps1 during the DeepCompose rebrand.)
#
# Purpose : prove the app remembers its window rect across restarts. Each case
#           prints PASS/FAIL with the measured numbers:
#             T0 clean first run      -> default 1440x900, centred
#             T1 resize + close       -> window_state.json records the new rect
#             T2 relaunch             -> comes back at the resized rect (memory works)
#             T3 maximise + close     -> state keeps the restorable rect + maximized=true
#             T4 relaunch             -> starts maximized; unmaximise returns the old size
#             T5 bogus off-screen     -> falls back to the centred default (no lost window)
# Usage   : .\tools\probe_window.ps1 [-Exe <path>] [-StateFile <json>] [-WaitSec <n>]
#           Default -Exe is the packaged build release\DeepCompose.exe.
#           The script rewrites and finally deletes nothing outside -StateFile,
#           and it only stops app instances launched from the same -Exe path
#           between cases (never the user's other DeepCompose windows).
# Pitfalls: - -StateFile defaults to %APPDATA%\com.writerd\writerD\
#             window_state.json: that legacy dir is a frozen disk contract (the
#             app still uses it after the rename). Do not rebrand this path.
#           - window_state.json stores the CLIENT size (set_size -> tao
#             set_inner_size), not the outer rect; assertions use client metrics
#             and accept a frame-height difference on the outer rect.
#           - JSON is read/written through embedded python snippets on purpose:
#             PowerShell 5.1 JSON + encoding round-trips are not trustworthy
#             for this file.
#           - Needs a real interactive desktop session and ~2 minutes to run.
# ASCII-only on purpose: Windows PowerShell 5.1 misreads UTF-8 files without BOM.
param(
    [string]$Exe = (Join-Path $PSScriptRoot "..\release\DeepCompose.exe"),
    [string]$StateFile = "$env:APPDATA\com.writerd\writerD\window_state.json",
    [int]$WaitSec = 12
)

$ErrorActionPreference = "Stop"

$sig = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WProbe {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
    public delegate bool EnumProc(IntPtr h, IntPtr p);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
    [DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint a, uint b, ref RECT r, uint c);
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    // Pick the largest visible top-level window owned by pid (the app window,
    // not WebView2 helper windows).
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
if (-not ("WProbe" -as [type])) { Add-Type -TypeDefinition $sig }

$pass = 0; $fail = 0
function Check([string]$name, [bool]$ok, [string]$detail) {
    if ($ok) { $script:pass++; Write-Output ("  PASS  {0}  {1}" -f $name, $detail) }
    else { $script:fail++; Write-Output ("  FAIL  {0}  {1}" -f $name, $detail) }
}

function Rect-Of([IntPtr]$h) {
    $r = New-Object WProbe+RECT
    [WProbe]::GetWindowRect($h, [ref]$r) | Out-Null
    return @{ x = $r.Left; y = $r.Top; w = $r.Right - $r.Left; h = $r.Bottom - $r.Top }
}
function Fmt($r) { return ("{0}x{1} at ({2},{3})" -f $r.w, $r.h, $r.x, $r.y) }

# Client-area size: window state stores the client area (set_size -> tao set_inner_size)
function Client-Of([IntPtr]$h) {
    $r = New-Object WProbe+RECT
    [WProbe]::GetClientRect($h, [ref]$r) | Out-Null
    return @{ w = $r.Right - $r.Left; h = $r.Bottom - $r.Top }
}

# --- state file helpers (python, never PowerShell JSON parsing) -----------
$pyRead = @'
import json, sys
try:
    d = json.load(open(sys.argv[1], encoding="utf-8"))
    print("%d %d %d %d %s" % (d.get("x", 0), d.get("y", 0), d.get("w", 0), d.get("h", 0), str(d.get("maximized", False)).lower()))
except Exception as e:
    print("MISSING %s" % e)
'@
$pyWrite = @'
import json, sys
json.dump({"x": int(sys.argv[2]), "y": int(sys.argv[3]), "w": int(sys.argv[4]), "h": int(sys.argv[5]), "maximized": sys.argv[6] == "true"},
          open(sys.argv[1], "w", encoding="utf-8"), ensure_ascii=False)
'@
function Read-State {
    $out = ($pyRead | python - $StateFile) -join "`n"
    return $out.Trim()
}

$wa = New-Object WProbe+RECT
[WProbe]::SystemParametersInfo(0x0030, 0, [ref]$wa, 0) | Out-Null   # SPI_GETWORKAREA
$waW = $wa.Right - $wa.Left; $waH = $wa.Bottom - $wa.Top
Write-Output "screen    = $([WProbe]::GetSystemMetrics(0))x$([WProbe]::GetSystemMetrics(1))"
Write-Output "workarea  = ${waW}x${waH} at ($($wa.Left),$($wa.Top))"
Write-Output "statefile = $StateFile"
Write-Output ""

function Launch([string]$tag) {
    # Kill leftovers first so the fresh instance owns the only app window.
    # N-16: scoped to THIS script's -Exe path (the previous case's instance) --
    # never kill by process name, which would close the user's own windows too.
    $exePath = if (Test-Path $Exe) { (Get-Item $Exe).FullName } else { $null }
    if ($exePath) {
        Get-Process -Name deepcompose -ErrorAction SilentlyContinue |
            Where-Object { $_.Path -and $_.Path -eq $exePath } |
            Stop-Process -Force
    }
    Start-Sleep -Milliseconds 800
    $proc = Start-Process $Exe -PassThru
    Start-Sleep -Seconds $WaitSec
    $proc.Refresh()
    if ($proc.HasExited) { Write-Output "  [$tag] FAIL process exited: $($proc.ExitCode)"; return $null }
    $h = [WProbe]::Pick([uint32]$proc.Id)
    if ($h -eq [IntPtr]::Zero) { Write-Output "  [$tag] FAIL no visible window"; Stop-Process -Id $proc.Id -Force; return $null }
    # A window born minimized must be restored before measuring, else the rect
    # is the off-screen (-32000,-32000) placeholder.
    if ([WProbe]::IsIconic($h)) { [WProbe]::ShowWindow($h, 9) | Out-Null; Start-Sleep -Milliseconds 800 }
    Start-Sleep -Milliseconds 600
    return @{ proc = $proc; hwnd = $h; rect = (Rect-Of $h) }
}

function Close-App($s) {
    # Close via WM_CLOSE (not kill): the app only persists window state on a
    # graceful close. Force-kill is the fallback after 12s of no exit.
    [WProbe]::SendMessage($s.hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null   # WM_CLOSE
    for ($i = 0; $i -lt 24; $i++) {
        Start-Sleep -Milliseconds 500
        $s.proc.Refresh()
        if ($s.proc.HasExited) { return $true }
    }
    Stop-Process -Id $s.proc.Id -Force
    return $false
}

# -- T0: clean first run ---------------------------------------------------
Write-Output "T0 clean first run (no state file)"
if (Test-Path $StateFile) { Remove-Item $StateFile -Force }
$s = Launch "T0"
if ($null -eq $s) { exit 1 }
$r0 = $s.rect
$c0 = Client-Of $s.hwnd
# Tauri center:true centres the CLIENT area, while GetWindowRect includes the frame,
# so the outer rect sits half a frame away from "outer-centred". Accept either.
$expOuter = @{ x = [int]($wa.Left + ($waW - $r0.w) / 2); y = [int]($wa.Top + ($waH - $r0.h) / 2) }
$expClient = @{ x = [int]($wa.Left + ($waW - $c0.w) / 2); y = [int]($wa.Top + ($waH - $c0.h) / 2) }
$centred = ([math]::Abs($r0.x - $expOuter.x) -le 12 -and [math]::Abs($r0.y - $expOuter.y) -le 12) -or
           ([math]::Abs($r0.x - $expClient.x) -le 12 -and [math]::Abs($r0.y - $expClient.y) -le 12)
Check "T0 default size ~1440x900" ([math]::Abs($c0.w - 1440) -le 8 -and [math]::Abs($c0.h - 900) -le 8) ("outer $(Fmt $r0), client $($c0.w)x$($c0.h)")
Check "T0 centred" $centred ("outer-centred ({0},{1}) / client-centred ({2},{3}), got ({4},{5})" -f $expOuter.x, $expOuter.y, $expClient.x, $expClient.y, $r0.x, $r0.y)
Check "T0 leaves room for maximise" ($waW - $r0.w -gt 300) ("width left = {0}px" -f ($waW - $r0.w))
Write-Output ""

# -- T1/T2: resize -> close -> relaunch ------------------------------------
Write-Output "T1 resize to 1200x760 at (120,80), then close"
[WProbe]::ShowWindow($s.hwnd, 9) | Out-Null
Start-Sleep -Milliseconds 600
[WProbe]::MoveWindow($s.hwnd, 120, 80, 1200, 760, $true) | Out-Null
Start-Sleep -Seconds 2
$moved = Rect-Of $s.hwnd
$clientMoved = Client-Of $s.hwnd
Write-Output "  rect after move: $(Fmt $moved)   client: $($clientMoved.w)x$($clientMoved.h)"
$closed = Close-App $s
Start-Sleep -Seconds 2
$st = Read-State
Write-Output "  state now: $st"
$h1 = $closed
Check "T1 closed by WM_CLOSE" $h1 ""
$parts = $st -split '\s+'
# The state stores the CLIENT size (set_size is the inner metric), not the outer rect
Check "T1 state recorded the client size" ($parts.Count -ge 4 -and $parts[2] -eq "$($clientMoved.w)" -and $parts[3] -eq "$($clientMoved.h)") "expected $($clientMoved.w)x$($clientMoved.h), got '$st'"
Check "T1 state recorded the position" ($parts.Count -ge 4 -and $parts[0] -eq "120" -and $parts[1] -eq "80") "got '$st'"
Write-Output ""

Write-Output "T2 relaunch -> should come back at 1200x760 (120,80)"
$s = Launch "T2"
if ($null -eq $s) { exit 1 }
$r2 = $s.rect
$c2 = Client-Of $s.hwnd
Write-Output "  rect: $(Fmt $r2)   client: $($c2.w)x$($c2.h)"
# Assert on the CLIENT size: that is what we store and restore. The outer rect can be
# ~30px taller because Windows recomputes the non-client frame after a programmatic
# set_inner_size (measured: 9px at creation, 39px afterwards) - not a state bug.
Check "T2 restored client size" ($c2.w -eq $clientMoved.w -and $c2.h -eq $clientMoved.h) "expected $($clientMoved.w)x$($clientMoved.h), got $($c2.w)x$($c2.h)"
Check "T2 restored position" ([math]::Abs($r2.x - 120) -le 4 -and [math]::Abs($r2.y - 80) -le 4) ("expected (120,80), got ({0},{1})" -f $r2.x, $r2.y)
Write-Output ""

# -- T3/T4: maximise -> close -> relaunch ---------------------------------
Write-Output "T3 maximise, then close"
[WProbe]::SendMessage($s.hwnd, 0x0112, [IntPtr]0xF030, [IntPtr]::Zero) | Out-Null   # WM_SYSCOMMAND SC_MAXIMIZE
Start-Sleep -Milliseconds 1500
Write-Output "  zoomed = $([WProbe]::IsZoomed($s.hwnd))  rect = $(Fmt (Rect-Of $s.hwnd))"
Close-App $s | Out-Null
Start-Sleep -Seconds 2
$st = Read-State
Write-Output "  state now: $st"
$parts = $st -split '\s+'
Check "T3 kept the restorable rect" ($parts.Count -ge 5 -and $parts[2] -eq "$($clientMoved.w)" -and $parts[3] -eq "$($clientMoved.h)") "expected the pre-maximise client size $($clientMoved.w)x$($clientMoved.h), got '$st'"
Check "T3 flagged maximized" ($parts.Count -ge 5 -and $parts[4] -eq "true") "got '$st'"
Write-Output ""

Write-Output "T4 relaunch -> should start maximized"
$s = Launch "T4"
if ($null -eq $s) { exit 1 }
$zoomed = [WProbe]::IsZoomed($s.hwnd)
Write-Output "  zoomed = $zoomed  rect = $(Fmt $s.rect)"
Check "T4 started maximized" $zoomed (Fmt $s.rect)
[WProbe]::SendMessage($s.hwnd, 0x0112, [IntPtr]0xF120, [IntPtr]::Zero) | Out-Null   # WM_SYSCOMMAND SC_RESTORE
Start-Sleep -Milliseconds 1500
$r4 = Rect-Of $s.hwnd
$c4 = Client-Of $s.hwnd
Write-Output "  after restore: $(Fmt $r4)   client: $($c4.w)x$($c4.h)"
Check "T4 unmaximise returns the old client size" ($c4.w -eq $clientMoved.w -and $c4.h -eq $clientMoved.h) "expected $($clientMoved.w)x$($clientMoved.h), got $($c4.w)x$($c4.h)"
Check "T4 unmaximise returns the old position" ([math]::Abs($r4.x - 120) -le 6 -and [math]::Abs($r4.y - 80) -le 6) ("expected (120,80), got ({0},{1})" -f $r4.x, $r4.y)
Close-App $s | Out-Null
Start-Sleep -Seconds 2
Write-Output ""

# -- T5: bogus off-screen state -------------------------------------------
Write-Output "T5 bogus off-screen state -> must fall back to the centred default"
$pyWrite | python - $StateFile 99999 99999 1440 900 false
Write-Output "  state written: $(Read-State)"
$s = Launch "T5"
if ($null -eq $s) { exit 1 }
$r5 = $s.rect
# On-screen = the rect intersects the work area at all (not merely x<right).
$onScreen = $r5.x -lt ($wa.Right) -and $r5.y -lt ($wa.Bottom) -and ($r5.x + $r5.w) -gt $wa.Left -and ($r5.y + $r5.h) -gt $wa.Top
Write-Output "  rect: $(Fmt $r5)"
Check "T5 window is on screen" $onScreen (Fmt $r5)
Check "T5 fell back to the default size" ([math]::Abs($r5.w - 1456) -le 24 -and [math]::Abs($r5.h - 909) -le 24) (Fmt $r5)
Close-App $s | Out-Null
Start-Sleep -Seconds 1

Write-Output ""
Write-Output "RESULT  pass=$pass fail=$fail"
if (Test-Path $StateFile) { Write-Output "final state file: $(Read-State)" }
Write-Output "DONE"
