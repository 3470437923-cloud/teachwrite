# DeepCompose end-to-end chat check: drive the real exe with a mock provider.
#
# Purpose : prove the full loop (Rust stream relay -> protocol parse -> tool
#           dispatch -> persistence -> UI render) without a real API key:
#             1) point prefs at the local mock provider
#             2) launch deepcompose.exe, click the composer, paste a prompt,
#                click the send button
#             3) wait, capture the window, report what is on screen
# Usage   : start the mock first:   python tools\mock_provider.py 8899
#           then:  .\tools\e2e_chat.ps1 [-Exe <path>] [-Out <png>]
#                  [-Prompt <text>] [-WaitSec <n>] [-AfterSendSec <n>]
# Pitfalls: - Overwrites shared_preferences.json under
#             %APPDATA%\com.writerd\writerD. That legacy dir is a frozen disk
#             contract (the app still uses it after the rename); never rebrand
#             this path.
#           - Text goes in via clipboard paste: raw SendKeys keystrokes get
#             swallowed by the Chinese IME, and SendKeys ENTER is unreliable in
#             WebView2, so the round send button is clicked instead.
#           - Click targets are window-relative pixel offsets tuned for the
#             default layout; odd window sizes can misplace them.
# ASCII-only source (Windows PowerShell 5.1 misreads UTF-8 without BOM).
param(
    [string]$Exe = (Join-Path $PSScriptRoot "..\src-tauri\target\release\deepcompose.exe"),
    [string]$Out = (Join-Path $PSScriptRoot "..\shots\shot-chat.png"),
    [string]$Prompt = "List chapters",
    [int]$WaitSec = 8,
    [int]$AfterSendSec = 25
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

# E-2: Legacy default accent (violet). 0xFF7C6AFF == 4286343935, same value as
# LEGACY_DEFAULT_ACCENT in SettingsScreen.tsx -- both sides must change together;
# at least each side now spells the number exactly once.
$LEGACY_DEFAULT_ACCENT = 4286343935

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
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
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
        mouse_event(0x0002, 0, 0, 0, IntPtr.Zero); // left down
        System.Threading.Thread.Sleep(60);
        mouse_event(0x0004, 0, 0, 0, IntPtr.Zero); // left up
    }
}
'@
if (-not ("E2E" -as [type])) { Add-Type -TypeDefinition $sig }

# 1) point prefs at the mock provider.
# NOTE: com.writerd\writerD is the frozen legacy config dir (disk contract):
# the app still reads/writes it after the DeepCompose rename. Do not rebrand.
$prefsDir = Join-Path $env:APPDATA "com.writerd\writerD"
New-Item -ItemType Directory -Force -Path $prefsDir | Out-Null
$prefsFile = Join-Path $prefsDir "shared_preferences.json"

# N-07 (B12 batch 8 re-fix): back up the REAL prefs BEFORE any write. The batch-6
# attempt put this block after the mock write, so the "backup" captured the mock
# config and `finally` restored mock values over the user's live key -- the real
# config was gone with no residue. Order matters: copy first, then overwrite.
$backup = "$prefsFile.e2e-backup"
if (Test-Path $prefsFile) {
    Copy-Item $prefsFile $backup -Force
    Write-Output "PREFS backed up -> $backup"
}

$prefs = @{
    "flutter.llm_base_url"          = "http://127.0.0.1:8899"
    "flutter.api_key"               = "mock-key"
    "flutter.model"                 = "mock-model"
    "flutter.temperature"           = 0.8
    "flutter.use_anthropic_format"  = $false
    "flutter.context_limit"         = 1000000
    "flutter.reserved_output_tokens"= 16000
    "flutter.auto_clear_context"    = $true
    "flutter.is_dark_mode"          = $true
    "flutter.custom_accent_color"   = $LEGACY_DEFAULT_ACCENT
    "flutter.novel_projects"        = ""
    "flutter.current_novel_project" = ""
}
($prefs | ConvertTo-Json -Compress) | Set-Content -LiteralPath $prefsFile -Encoding UTF8
# Set-Content -Encoding UTF8 on PowerShell 5.1 writes a BOM. The app tolerates
# it, but the test tooling should still emit a clean file so BOM trouble never
# gets mixed up with product trouble - strip the BOM when present.
# N-53: the old $bytes[3..($bytes.Length-1)] reversed into range [3,2] when the
# file was exactly 3 bytes (BOM only), writing an out-of-bounds null + 0xBF dirty
# file. Copy by length instead; a 3-byte file now yields a correct empty file.
$bytes = [System.IO.File]::ReadAllBytes($prefsFile)
if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    $body = New-Object byte[] ($bytes.Length - 3)
    if ($body.Length -gt 0) { [Array]::Copy($bytes, 3, $body, 0, $body.Length) }
    [System.IO.File]::WriteAllBytes($prefsFile, $body)
    Write-Output "PREFS BOM stripped"
}
Write-Output "PREFS -> $prefsFile"

try {

# 2) launch
# N-16: only clear leftovers running THIS script's -Exe path; never kill by name
$exePath = if (Test-Path $Exe) { (Get-Item $Exe).FullName } else { $null }
if ($exePath) {
    Get-Process -Name deepcompose -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and $_.Path -eq $exePath } |
        Stop-Process -Force
    Start-Sleep -Milliseconds 500
}
$proc = Start-Process $Exe -PassThru
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

# 3) click the composer textarea, type, Enter
# composer box sits above the statusbar (~44px) and is ~147px tall;
# aim for its vertical centre so the click lands inside the textarea.
$cx = $r.Left + [int]($w * 0.85)
$cy = $r.Top + $ht - 120
Write-Output "CLICK ($cx,$cy)"
[E2E]::Click($cx, $cy)
Start-Sleep -Milliseconds 600
$ws = New-Object -ComObject WScript.Shell
# Type via clipboard paste: raw SendKeys keystrokes get swallowed by the
# Chinese IME (they land as an uncommitted composition string, so React state
# stays empty and send is a no-op). Paste bypasses the IME entirely.
$Prompt.Trim() | clip.exe
Start-Sleep -Milliseconds 300
$ws.SendKeys("^v")
Start-Sleep -Milliseconds 500
# Enter via SendKeys is unreliable in WebView2; click the round send button
# (bottom-right of the composer) instead.
[E2E]::Click($r.Left + $w - 63, $r.Top + $ht - 94)
Write-Output "SENT"
Start-Sleep -Seconds $AfterSendSec

# 4) capture
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
    # N-16/N-07: stop only the process we started; always restore user prefs
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
    if (Test-Path $backup) {
        Copy-Item $backup $prefsFile -Force
        Remove-Item $backup -Force
        Write-Output "PREFS restored from backup"
    }
}
Write-Output "CLOSED"
