# Test-only native modal; a timer closes only this fixture thread's own window.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class HipiFixtureExit {
    delegate bool Callback(IntPtr hwnd, IntPtr ignored);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool EnumThreadWindows(uint id, Callback callback, IntPtr ignored);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr a, IntPtr b);
    public static void CloseOwnFixture() {
        EnumThreadWindows(GetCurrentThreadId(), delegate(IntPtr hwnd, IntPtr unused) {
            PostMessage(hwnd, 0x10, IntPtr.Zero, IntPtr.Zero); return true;
        }, IntPtr.Zero);
    }
}
'@
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 20000
$timer.Add_Tick({ $timer.Stop(); [HipiFixtureExit]::CloseOwnFixture() })
$timer.Start()
$ready = New-Object System.Windows.Forms.Timer
$ready.Interval = 100
$ready.Add_Tick({ $ready.Stop(); [Console]::Out.WriteLine('HIPI_FIXTURE_READY') })
$ready.Start()
try {
    $text = 'A JavaScript error occurred in the main process: ERR_MODULE_NOT_FOUND private-fixture-secret must not be emitted'
    if ($env:HIPI_DIALOG_DECOY -eq '1') { $text = 'ReferenceError unrelated-owned-test-decoy must not be collected' }
    [void][System.Windows.Forms.MessageBox]::Show($text, 'Hipi Work')
} finally { $ready.Dispose(); $timer.Dispose() }
