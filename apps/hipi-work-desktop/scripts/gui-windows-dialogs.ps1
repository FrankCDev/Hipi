$ErrorActionPreference = 'Stop'
# Do not search installed/user modules when the first Utility cmdlet is invoked.
# The helper deliberately receives a minimal environment, not the caller's profile.
$PSModuleAutoLoadingPreference = 'None'
function Write-Phase([string]$value) {
    $script:phase = $value
    # Fixed internal constants only; emit before each potentially blocking operation.
    [Console]::Out.WriteLine('{"phase":"' + $value + '"}')
    [Console]::Out.Flush()
}
# No policy override, foreground change, click, close, screenshot, or broad process scan.
try {
    Write-Phase 'utility-import'
    Import-Module -Name ([IO.Path]::Combine($PSHOME, 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop
    Write-Phase 'request'
    $request = $env:HIPI_WINDOW_REQUEST | ConvertFrom-Json
    Write-Phase 'process-lookup'
    $process = [Diagnostics.Process]::GetProcessById([int]$request.pid)
    Write-Phase 'process-handle'
    $heldHandle = $process.Handle
    Write-Phase 'process-start-time'
    $start = $process.StartTime.ToUniversalTime()
    Write-Phase 'process-session'
    $session = $process.SessionId
    Write-Phase 'process-image'
    $binary = [IO.Path]::GetFullPath($process.MainModule.FileName)
    Write-Phase 'session-mismatch'
    if ($session -ne [Diagnostics.Process]::GetCurrentProcess().SessionId) { throw 'identity' }
    Write-Phase 'image-mismatch'
    if (-not [String]::Equals($binary, [IO.Path]::GetFullPath($request.binary), [StringComparison]::OrdinalIgnoreCase)) { throw 'identity' }
    Write-Phase 'process-exited'
    if ($process.HasExited) { throw 'identity' }
    if ($request.mode -eq 'identity') {
        Write-Phase 'spawn-window'
        $spawned = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$request.spawnedAt).UtcDateTime
        if ($start -lt $spawned.AddSeconds(-1) -or $start -gt $spawned.AddSeconds(10)) { throw 'start' }
        @{ status='confirmed'; pid=$process.Id; startTicks=$start.Ticks.ToString(); session=$session } | ConvertTo-Json -Compress
        exit 0
    }
    Write-Phase 'capture-identity'
    if ($request.mode -ne 'capture' -or $start.Ticks.ToString() -ne $request.startTicks -or $session -ne $request.session) { throw 'identity' }
    Write-Phase 'native-compile'
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase
    $references = @(
        [Collections.Generic.HashSet[string]].Assembly.Location,
        [Windows.Automation.AutomationElement].Assembly.Location,
        [Windows.Automation.ControlType].Assembly.Location,
        [Windows.Rect].Assembly.Location
    )
    Add-Type -ReferencedAssemblies $references -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Automation;
public static class HipiOwnedDialogReader {
    delegate bool Callback(IntPtr hwnd, IntPtr value);
    [DllImport("user32.dll")] static extern bool EnumThreadWindows(uint thread, Callback callback, IntPtr value);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, Callback callback, IntPtr value);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder value, int count);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder value, int count);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, UIntPtr count, StringBuilder value, uint flags, uint timeout, out UIntPtr result);
    static bool Owned(IntPtr hwnd, int pid) { uint owner; GetWindowThreadProcessId(hwnd, out owner); return owner == pid; }
    static void Classify(string value, HashSet<string> codes) {
        if (value.Length >= 2047) { codes.Add("TEXT_TRUNCATED"); value = value.Substring(0, 2047); }
        if (value.Contains("A JavaScript error occurred in the main process")) codes.Add("ELECTRON_MAIN_JS_ERROR");
        foreach (string code in new [] { "SyntaxError", "ReferenceError", "TypeError", "ERR_MODULE_NOT_FOUND", "ERR_UNSUPPORTED_ESM_URL_SCHEME", "ENOENT", "EACCES", "EPERM" })
            if (value.Contains(code)) codes.Add(code);
        if (value.Contains("Desktop startup failed. No command was replayed.") || value.Contains("\u684c\u9762\u5e94\u7528\u542f\u52a8\u5931\u8d25\u3002\u6ca1\u6709\u91cd\u653e\u4efb\u4f55\u547d\u4ee4\u3002")) codes.Add("HIPI_STARTUP_FAILED");
    }
    static bool AccessibleOwned(AutomationElement element, IntPtr dialog, int pid) {
        if (!Owned(dialog, pid) || element.Current.ProcessId != pid) return false;
        int native = element.Current.NativeWindowHandle;
        return native == 0 || Owned(new IntPtr(native), pid);
    }
    // TaskDialog's DirectUI text is virtual: there is no Static HWND to send WM_GETTEXT to.
    // Start at this already-verified dialog only. Never use RootElement or a global search.
    static bool ReadAccessible(AutomationElement element, IntPtr dialog, int pid, int depth,
        Stopwatch clock, HashSet<string> codes, ref int controls, ref int readable, ref bool limited) {
        if (clock.ElapsedMilliseconds >= 2000 || controls >= 16 || depth > 4) {
            if (clock.ElapsedMilliseconds >= 2000) codes.Add("UIA_TIME_LIMIT");
            if (controls >= 16) codes.Add("UIA_CONTROL_LIMIT");
            if (depth > 4) codes.Add("UIA_DEPTH_LIMIT");
            limited = true; return false;
        }
        controls++;
        if (!AccessibleOwned(element, dialog, pid)) { codes.Add("IDENTITY_CHANGED"); return false; }
        if (depth == 0) codes.Add("UIA_ROOT_OBSERVED");
        var controlType = element.Current.ControlType;
        if (controlType == ControlType.Text) {
            if (!AccessibleOwned(element, dialog, pid)) { codes.Add("IDENTITY_CHANGED"); return false; }
            string value = element.Current.Name;
            if (!AccessibleOwned(element, dialog, pid)) { codes.Add("IDENTITY_CHANGED"); return false; }
            if (value.Length == 0) codes.Add("UIA_TEXT_EMPTY");
            Classify(value, codes);
            readable++;
            codes.Add("TASK_DIALOG_TEXT_OBSERVED");
        } else if (controlType == ControlType.Pane) codes.Add("UIA_PANE_OBSERVED");
        else if (controlType == ControlType.Hyperlink) codes.Add("UIA_HYPERLINK_OBSERVED");
        else if (controlType == ControlType.Custom) codes.Add("UIA_CUSTOM_OBSERVED");
        else if (controlType == ControlType.Button) codes.Add("UIA_BUTTON_OBSERVED");
        else if (controlType == ControlType.Window) codes.Add("UIA_WINDOW_OBSERVED");
        else codes.Add("UIA_OTHER_OBSERVED");
        if (clock.ElapsedMilliseconds >= 2000 || controls >= 16) {
            codes.Add(clock.ElapsedMilliseconds >= 2000 ? "UIA_TIME_LIMIT" : "UIA_CONTROL_LIMIT");
            limited = true; return false;
        }
        var child = TreeWalker.RawViewWalker.GetFirstChild(element);
        while (child != null) {
            if (!ReadAccessible(child, dialog, pid, depth + 1, clock, codes, ref controls, ref readable, ref limited)) return false;
            if (clock.ElapsedMilliseconds >= 2000 || controls >= 16) {
                codes.Add(clock.ElapsedMilliseconds >= 2000 ? "UIA_TIME_LIMIT" : "UIA_CONTROL_LIMIT");
                limited = true; return false;
            }
            child = TreeWalker.RawViewWalker.GetNextSibling(child);
        }
        return true;
    }
    public static string[] Read(Process process) {
        var codes = new HashSet<string>();
        var clock = Stopwatch.StartNew();
        int windows = 0, controls = 0;
        bool limited = false;
        foreach (ProcessThread thread in process.Threads) {
            if (clock.ElapsedMilliseconds >= 2000 || windows >= 8) {
                codes.Add(clock.ElapsedMilliseconds >= 2000 ? "NATIVE_TIME_LIMIT" : "NATIVE_WINDOW_LIMIT");
                limited = true; break;
            }
            bool enumerated = EnumThreadWindows((uint)thread.Id, delegate(IntPtr hwnd, IntPtr ignored) {
                if (clock.ElapsedMilliseconds >= 2000 || windows++ >= 8) {
                    codes.Add(clock.ElapsedMilliseconds >= 2000 ? "NATIVE_TIME_LIMIT" : "NATIVE_WINDOW_LIMIT");
                    limited = true; return false;
                }
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
                bool taskDialog = false;
                EnumChildWindows(hwnd, delegate(IntPtr child, IntPtr unused) {
                    if (clock.ElapsedMilliseconds >= 2000 || controls++ >= 16) {
                        codes.Add(clock.ElapsedMilliseconds >= 2000 ? "NATIVE_TIME_LIMIT" : "NATIVE_CONTROL_LIMIT");
                        limited = true; return false;
                    }
                    if (!Owned(child, process.Id)) { codes.Add("IDENTITY_CHANGED"); return false; }
                    var childKind = new StringBuilder(64);
                    if (GetClassName(child, childKind, childKind.Capacity) == 0) { codes.Add("ENUMERATION_UNAVAILABLE"); return false; }
                    if (childKind.ToString() == "DirectUIHWND") {
                        taskDialog = true; codes.Add("DIRECTUI_CONTROL_OBSERVED");
                        // TaskDialog text is virtual. Select UIA now, preserving the remaining shared budget.
                        // Enumerating the rest of this native subtree cannot read its text and can exhaust all 16 controls.
                        return false;
                    }
                    if (childKind.ToString() == "SysLink") codes.Add("SYSLINK_CONTROL_OBSERVED");
                    if (childKind.ToString() != "Static") return true;
                    codes.Add("STATIC_CONTROL_OBSERVED");
                    var text = new StringBuilder(2048); UIntPtr length;
                    // WM_GETTEXT only; never broadcast or wait without a timeout.
                    if (SendMessageTimeout(child, 13, (UIntPtr)2048, text, 0x22, 100, out length) == IntPtr.Zero) { codes.Add("TEXT_UNAVAILABLE"); return true; }
                    if (!Owned(child, process.Id)) { codes.Add("IDENTITY_CHANGED"); return false; }
                    readable++;
                    Classify(text.ToString(), codes);
                    return true;
                }, IntPtr.Zero);
                // Different representation, not a retry after any denied or failed native read.
                if (taskDialog && !limited && !codes.Contains("TEXT_UNAVAILABLE") &&
                    !codes.Contains("IDENTITY_CHANGED") && !codes.Contains("ENUMERATION_UNAVAILABLE")) {
                    try {
                        if (!Owned(hwnd, process.Id)) { codes.Add("IDENTITY_CHANGED"); return false; }
                        var dialog = AutomationElement.FromHandle(hwnd);
                        if (!ReadAccessible(dialog, hwnd, process.Id, 0, clock, codes, ref controls, ref readable, ref limited)) return false;
                        if (!Owned(hwnd, process.Id)) { codes.Add("IDENTITY_CHANGED"); return false; }
                    } catch { codes.Add("ENUMERATION_UNAVAILABLE"); return false; }
                }
                if (readable == 0) codes.Add("TEXT_UNAVAILABLE");
                return true;
            }, IntPtr.Zero);
            if (!enumerated && !limited) codes.Add("ENUMERATION_UNAVAILABLE");
            if (codes.Contains("IDENTITY_CHANGED") || codes.Contains("ENUMERATION_UNAVAILABLE")) break;
        }
        if (limited) codes.Add("LIMIT_REACHED");
        if (codes.Count == 0) codes.Add("NO_MATCHING_DIALOG_OBSERVED");
        var result = new string[codes.Count]; codes.CopyTo(result); Array.Sort(result); return result;
    }
}
'@
    Write-Phase 'native-query'
    $codes = [HipiOwnedDialogReader]::Read($process)
    Write-Phase 'post-query-identity'
    if ($process.HasExited -or $process.StartTime.ToUniversalTime().Ticks.ToString() -ne $request.startTicks) { throw 'changed' }
    @{ status='observed'; codes=@($codes) } | ConvertTo-Json -Compress
} catch {
    # Never serialize exceptions, command lines, paths, window titles or raw text.
    # This must also work when Utility (including ConvertTo-Json) failed to load.
    [Console]::Out.WriteLine('{"status":"unknown","reason":"' + $script:phase + '"}')
} finally {
    if ($null -ne $process) { $process.Dispose() }
}
