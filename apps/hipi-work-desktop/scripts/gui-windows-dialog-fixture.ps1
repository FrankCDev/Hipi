# Test-only native modal; a timer closes only this fixture thread's own window.
$ErrorActionPreference = 'Stop'
try {
    [Console]::Out.WriteLine('HIPI_FIXTURE_PHASE:forms-load')
    Add-Type -AssemblyName System.Windows.Forms
    [Console]::Out.WriteLine('HIPI_FIXTURE_PHASE:native-compile')
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
    [DllImport("comctl32.dll", CharSet=CharSet.Unicode, ExactSpelling=true)]
    static extern int TaskDialog(IntPtr parent, IntPtr instance, string title, string instruction, string text, uint buttons, IntPtr icon, out int button);
    static void Phase(string phase) { Console.Out.WriteLine("HIPI_FIXTURE_PHASE:" + phase); Console.Out.Flush(); }
    static bool Failure(string code) { Console.Out.WriteLine("HIPI_FIXTURE_FAILURE:" + code); Console.Out.Flush(); return false; }
    static bool NativeFailure(int error) {
        switch (error) {
            case 2: return Failure("ERROR_FILE_NOT_FOUND");
            case 3: return Failure("ERROR_PATH_NOT_FOUND");
            case 5: return Failure("ERROR_ACCESS_DENIED");
            case 87: return Failure("ERROR_INVALID_PARAMETER");
            case 14001: return Failure("ERROR_SXS_CANT_GEN_ACTCTX");
            default: return Failure("ACTIVATION_NATIVE_FAILURE");
        }
    }
    public static bool ShowTaskDialog(string manifest, string text) {
        var settings = new ActivationContext();
        settings.size = (uint)Marshal.SizeOf(typeof(ActivationContext));
        settings.source = manifest;
        Phase("activation-create");
        IntPtr context = CreateActCtx(ref settings);
        if (context == new IntPtr(-1)) return NativeFailure(Marshal.GetLastWin32Error());
        UIntPtr cookie;
        Phase("activation-activate");
        if (!ActivateActCtx(context, out cookie)) {
            int error = Marshal.GetLastWin32Error();
            ReleaseActCtx(context);
            return NativeFailure(error);
        }
        try {
            int button;
            // The same Common Controls v6 DirectUI dialog family used by Electron ShowErrorBox.
            // TD_ERROR_ICON is MAKEINTRESOURCEW(-2): WORD then ULONG_PTR, never sign-extended -2.
            Phase("task-dialog-call");
            int result = TaskDialog(IntPtr.Zero, IntPtr.Zero, "Error", "Hipi Work", text, 9, new IntPtr(0xFFFE), out button);
            if (result == unchecked((int)0x80070057)) return Failure("E_INVALIDARG");
            if (result == unchecked((int)0x8007000E)) return Failure("E_OUTOFMEMORY");
            if (result == unchecked((int)0x80004005)) return Failure("E_FAIL");
            return result >= 0 || Failure("TASK_DIALOG_FAILED");
        } catch (EntryPointNotFoundException) { return Failure("ENTRY_POINT_NOT_FOUND");
        } catch (DllNotFoundException) { return Failure("DLL_NOT_FOUND");
        } finally { DeactivateActCtx(0, cookie); ReleaseActCtx(context); }
    }
    public static void CloseOwnFixture() {
        EnumThreadWindows(GetCurrentThreadId(), delegate(IntPtr hwnd, IntPtr unused) {
            PostMessage(hwnd, 0x10, IntPtr.Zero, IntPtr.Zero); return true;
        }, IntPtr.Zero);
    }
}
'@
    [Console]::Out.WriteLine('HIPI_FIXTURE_PHASE:timers-start')
    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = 20000
    $timer.Add_Tick({ $timer.Stop(); [HipiFixtureExit]::CloseOwnFixture() })
    $timer.Start()
    $ready = New-Object System.Windows.Forms.Timer
    $ready.Interval = 100
    $ready.Add_Tick({ $ready.Stop(); [Console]::Out.WriteLine('HIPI_FIXTURE_READY'); [Console]::Out.Flush() })
    $ready.Start()
    try {
        $text = 'A JavaScript error occurred in the main process: ERR_MODULE_NOT_FOUND private-fixture-secret must not be emitted'
        if ($env:HIPI_DIALOG_DECOY -eq '1') { $text = 'ReferenceError unrelated-owned-test-decoy must not be collected' }
        if ($env:HIPI_DIALOG_KIND -eq 'task') {
            if (-not [HipiFixtureExit]::ShowTaskDialog([IO.Path]::Combine($PSScriptRoot, 'gui-windows-dialog-fixture.manifest'), $text)) { exit 1 }
        } else {
            [Console]::Out.WriteLine('HIPI_FIXTURE_PHASE:classic-dialog-call')
            [void][System.Windows.Forms.MessageBox]::Show($text, 'Hipi Work')
        }
    } finally { $ready.Dispose(); $timer.Dispose() }
} catch {
    # Never emit exception messages, script paths, environment values or fixture text.
    $code = 'FIXTURE_EXCEPTION'
    $cause = $_.Exception
    for ($depth = 0; $null -ne $cause -and $depth -lt 4; $depth++) {
        if ($cause -is [EntryPointNotFoundException]) { $code = 'ENTRY_POINT_NOT_FOUND'; break }
        if ($cause -is [DllNotFoundException]) { $code = 'DLL_NOT_FOUND'; break }
        $cause = $cause.InnerException
    }
    [Console]::Out.WriteLine('HIPI_FIXTURE_FAILURE:' + $code)
    [Console]::Out.Flush()
    exit 1
}
