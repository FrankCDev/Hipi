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
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    struct ActivationContext {
        public uint size, flags;
        public string source;
        public ushort architecture, language;
        public string directory;
        public IntPtr resource;
        public string application;
        public IntPtr module;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateActCtx(ref ActivationContext context);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool ActivateActCtx(IntPtr context, out UIntPtr cookie);
    [DllImport("kernel32.dll")] static extern bool DeactivateActCtx(uint flags, UIntPtr cookie);
    [DllImport("kernel32.dll")] static extern void ReleaseActCtx(IntPtr context);
    [DllImport("comctl32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, PreserveSig=false)]
    static extern void TaskDialog(IntPtr parent, IntPtr instance, string title, string instruction, string text, uint buttons, IntPtr icon, out int button);
    public static void ShowTaskDialog(string manifest, string text) {
        var settings = new ActivationContext();
        settings.size = (uint)Marshal.SizeOf(typeof(ActivationContext));
        settings.source = manifest;
        IntPtr context = CreateActCtx(ref settings);
        if (context == new IntPtr(-1)) throw new InvalidOperationException("Fixture activation unavailable");
        UIntPtr cookie;
        if (!ActivateActCtx(context, out cookie)) { ReleaseActCtx(context); throw new InvalidOperationException("Fixture activation failed"); }
        try {
            int button;
            // The same Common Controls v6 DirectUI dialog family used by Electron ShowErrorBox.
            TaskDialog(IntPtr.Zero, IntPtr.Zero, "Error", "Hipi Work", text, 9, new IntPtr(-2), out button);
        } finally { DeactivateActCtx(0, cookie); ReleaseActCtx(context); }
    }
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
    if ($env:HIPI_DIALOG_KIND -eq 'task') {
        [HipiFixtureExit]::ShowTaskDialog([IO.Path]::Combine($PSScriptRoot, 'gui-windows-dialog-fixture.manifest'), $text)
    } else { [void][System.Windows.Forms.MessageBox]::Show($text, 'Hipi Work') }
} finally { $ready.Dispose(); $timer.Dispose() }
