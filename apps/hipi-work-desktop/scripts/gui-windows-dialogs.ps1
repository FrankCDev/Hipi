$ErrorActionPreference = 'Stop'
$phase = 'request'
# No policy override, foreground change, click, close, screenshot, or broad process scan.
try {
    $request = $env:HIPI_WINDOW_REQUEST | ConvertFrom-Json
    $phase = 'process-lookup'
    $process = [Diagnostics.Process]::GetProcessById([int]$request.pid)
    $phase = 'process-handle'
    $heldHandle = $process.Handle
    $phase = 'process-start-time'
    $start = $process.StartTime.ToUniversalTime()
    $phase = 'process-session'
    $session = $process.SessionId
    $phase = 'process-image'
    $binary = [IO.Path]::GetFullPath($process.MainModule.FileName)
    $phase = 'session-mismatch'
    if ($session -ne [Diagnostics.Process]::GetCurrentProcess().SessionId) { throw 'identity' }
    $phase = 'image-mismatch'
    if (-not [String]::Equals($binary, [IO.Path]::GetFullPath($request.binary), [StringComparison]::OrdinalIgnoreCase)) { throw 'identity' }
    $phase = 'process-exited'
    if ($process.HasExited) { throw 'identity' }
    if ($request.mode -eq 'identity') {
        $phase = 'spawn-window'
        $spawned = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$request.spawnedAt).UtcDateTime
        if ($start -lt $spawned.AddSeconds(-1) -or $start -gt $spawned.AddSeconds(10)) { throw 'start' }
        @{ status='confirmed'; pid=$process.Id; startTicks=$start.Ticks.ToString(); session=$session } | ConvertTo-Json -Compress
        exit 0
    }
    $phase = 'capture-identity'
    if ($request.mode -ne 'capture' -or $start.Ticks.ToString() -ne $request.startTicks -or $session -ne $request.session) { throw 'identity' }
    $phase = 'native-compile'
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class HipiOwnedDialogReader {
    delegate bool Callback(IntPtr hwnd, IntPtr value);
    [DllImport("user32.dll")] static extern bool EnumThreadWindows(uint thread, Callback callback, IntPtr value);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, Callback callback, IntPtr value);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder value, int count);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder value, int count);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, UIntPtr count, StringBuilder value, uint flags, uint timeout, out UIntPtr result);
    static bool Owned(IntPtr hwnd, int pid) { uint owner; GetWindowThreadProcessId(hwnd, out owner); return owner == pid; }
    public static string[] Read(Process process) {
        var codes = new HashSet<string>();
        var clock = Stopwatch.StartNew();
        int windows = 0, controls = 0;
        bool limited = false;
        foreach (ProcessThread thread in process.Threads) {
            if (clock.ElapsedMilliseconds >= 2000 || windows >= 8) { limited = true; break; }
            bool enumerated = EnumThreadWindows((uint)thread.Id, delegate(IntPtr hwnd, IntPtr ignored) {
                if (clock.ElapsedMilliseconds >= 2000 || windows++ >= 8) { limited = true; return false; }
                if (!Owned(hwnd, process.Id)) { codes.Add("IDENTITY_CHANGED"); return false; }
                var kind = new StringBuilder(64);
                if (GetClassName(hwnd, kind, kind.Capacity) == 0) { codes.Add("ENUMERATION_UNAVAILABLE"); return false; }
                if (kind.ToString() != "#32770") return true;
                var title = new StringBuilder(512);
                GetWindowText(hwnd, title, title.Capacity);
                if (!Owned(hwnd, process.Id)) { codes.Add("IDENTITY_CHANGED"); return false; }
                if (title.ToString() != "Hipi Work" && title.ToString() != "Error") { codes.Add("UNKNOWN_DIALOG"); return true; }
                codes.Add("OWNED_ERROR_DIALOG");
                int readable = 0;
                EnumChildWindows(hwnd, delegate(IntPtr child, IntPtr unused) {
                    if (clock.ElapsedMilliseconds >= 2000 || controls++ >= 16) { limited = true; return false; }
                    if (!Owned(child, process.Id)) { codes.Add("IDENTITY_CHANGED"); return false; }
                    var childKind = new StringBuilder(64);
                    if (GetClassName(child, childKind, childKind.Capacity) == 0) { codes.Add("ENUMERATION_UNAVAILABLE"); return false; }
                    if (childKind.ToString() != "Static") return true;
                    var text = new StringBuilder(2048); UIntPtr length;
                    // WM_GETTEXT only; never broadcast or wait without a timeout.
                    if (SendMessageTimeout(child, 13, (UIntPtr)2048, text, 0x22, 100, out length) == IntPtr.Zero) { codes.Add("TEXT_UNAVAILABLE"); return true; }
                    if (!Owned(child, process.Id)) { codes.Add("IDENTITY_CHANGED"); return false; }
                    readable++;
                    string value = text.ToString();
                    if (value.Length >= 2047) codes.Add("TEXT_TRUNCATED");
                    if (value.Contains("A JavaScript error occurred in the main process")) codes.Add("ELECTRON_MAIN_JS_ERROR");
                    foreach (string code in new [] { "SyntaxError", "ReferenceError", "TypeError", "ERR_MODULE_NOT_FOUND", "ERR_UNSUPPORTED_ESM_URL_SCHEME", "ENOENT", "EACCES", "EPERM" })
                        if (value.Contains(code)) codes.Add(code);
                    if (value.Contains("Desktop startup failed. No command was replayed.") || value.Contains("\u684c\u9762\u5e94\u7528\u542f\u52a8\u5931\u8d25\u3002\u6ca1\u6709\u91cd\u653e\u4efb\u4f55\u547d\u4ee4\u3002")) codes.Add("HIPI_STARTUP_FAILED");
                    return true;
                }, IntPtr.Zero);
                if (readable == 0) codes.Add("TEXT_UNAVAILABLE");
                return true;
            }, IntPtr.Zero);
            if (!enumerated && !limited) codes.Add("ENUMERATION_UNAVAILABLE");
        }
        if (limited) codes.Add("LIMIT_REACHED");
        if (codes.Count == 0) codes.Add("NO_MATCHING_DIALOG_OBSERVED");
        var result = new string[codes.Count]; codes.CopyTo(result); Array.Sort(result); return result;
    }
}
'@
    $phase = 'native-query'
    $codes = [HipiOwnedDialogReader]::Read($process)
    $phase = 'post-query-identity'
    if ($process.HasExited -or $process.StartTime.ToUniversalTime().Ticks.ToString() -ne $request.startTicks) { throw 'changed' }
    @{ status='observed'; codes=@($codes) } | ConvertTo-Json -Compress
} catch {
    # Never serialize exceptions, command lines, paths, window titles or raw text.
    @{ status='unknown'; reason=$phase } | ConvertTo-Json -Compress
} finally {
    if ($null -ne $process) { $process.Dispose() }
}
