// LivePL Connect: wywołania Windows, których nie ma w .NET (okno bez ramki, DWM, skróty z AppUserModelID,
// zadanie Windows dla pomocnika, ścieżki procesów). Kompiluje się kompilatorem C# wbudowanym w Windows (C# 5).

using System;
using System.Runtime.InteropServices;
using System.Text;

namespace LivePL.Connect
{
    static class Win
    {
        public const int WM_NCCALCSIZE = 0x0083;
        public const int WM_NCHITTEST = 0x0084;
        public const int WM_NCLBUTTONDOWN = 0x00A1;
        public const int WM_GETMINMAXINFO = 0x0024;
        public const int WM_DPICHANGED = 0x02E0;
        public const int WM_SYSCOMMAND = 0x0112;
        public const int WM_ACTIVATE = 0x0006;
        public const int WM_SETTINGCHANGE = 0x001A;

        public const int HTCLIENT = 1, HTCAPTION = 2, HTLEFT = 10, HTRIGHT = 11, HTTOP = 12, HTTOPLEFT = 13,
            HTTOPRIGHT = 14, HTBOTTOM = 15, HTBOTTOMLEFT = 16, HTBOTTOMRIGHT = 17;

        public const int GWL_STYLE = -16;
        public const int WS_CAPTION = 0x00C00000, WS_THICKFRAME = 0x00040000, WS_SYSMENU = 0x00080000,
            WS_MINIMIZEBOX = 0x00020000, WS_MAXIMIZEBOX = 0x00010000;
        public const uint SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOZORDER = 0x4, SWP_NOACTIVATE = 0x10, SWP_FRAMECHANGED = 0x20;
        public const int SM_CXSIZEFRAME = 32, SM_CYSIZEFRAME = 33, SM_CXPADDEDBORDER = 92;

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int Left, Top, Right, Bottom; }

        [StructLayout(LayoutKind.Sequential)]
        public struct NCCALCSIZE_PARAMS { public RECT r0, r1, r2; public IntPtr lppos; }

        [StructLayout(LayoutKind.Sequential)]
        public struct POINT { public int X, Y; }

        [StructLayout(LayoutKind.Sequential)]
        public struct MINMAXINFO { public POINT Reserved, MaxSize, MaxPosition, MinTrackSize, MaxTrackSize; }

        [StructLayout(LayoutKind.Sequential)]
        public struct MARGINS { public int Left, Right, Top, Bottom; }

        public const int WM_WINDOWPOSCHANGING = 0x0046, WM_WINDOWPOSCHANGED = 0x0047;

        [StructLayout(LayoutKind.Sequential)]
        public struct WINDOWPOS { public IntPtr hwnd, hwndInsertAfter; public int x, y, cx, cy; public uint flags; }

        [StructLayout(LayoutKind.Sequential)]
        public struct WINDOWPLACEMENT { public int length, flags, showCmd; public POINT min, max; public RECT normal; }

        [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT wp);

        [DllImport("shell32.dll", CharSet = CharSet.Unicode)] public static extern int SetCurrentProcessExplicitAppUserModelID(string id);
        [DllImport("user32.dll")] public static extern bool ReleaseCapture();
        [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
        public const int SW_MAXIMIZE = 3, SW_MINIMIZE = 6, SW_SHOWMINNOACTIVE = 7, SW_RESTORE = 9;
        [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern int GetSystemMetricsForDpi(int index, uint dpi);
        [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int index);
        [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int index, IntPtr value);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
        [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
        [DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int processId);
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr hWnd, int attr, ref int value, int size);
        [DllImport("dwmapi.dll")] public static extern int DwmExtendFrameIntoClientArea(IntPtr hWnd, ref MARGINS margins);

        // grubość ramki do zmiany rozmiaru (taka sama, jaką Windows dodaje oknu z ramką)
        public static int Ramka(IntPtr okno, bool pion)
        {
            uint dpi = 96;
            try { dpi = GetDpiForWindow(okno); } catch { }
            try
            {
                return GetSystemMetricsForDpi(pion ? SM_CYSIZEFRAME : SM_CXSIZEFRAME, dpi) + GetSystemMetricsForDpi(SM_CXPADDEDBORDER, dpi);
            }
            catch
            {
                return GetSystemMetrics(pion ? SM_CYSIZEFRAME : SM_CXSIZEFRAME) + GetSystemMetrics(SM_CXPADDEDBORDER);
            }
        }

        // ---------------------------------------------------------------- ścieżka procesu

        [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(int access, bool inherit, int pid);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder name, ref int size);

        public static string SciezkaProcesu(int pid)
        {
            IntPtr h = OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, false, pid);
            if (h == IntPtr.Zero) return null;
            try
            {
                var sb = new StringBuilder(1024);
                int n = sb.Capacity;
                return QueryFullProcessImageName(h, 0, sb, ref n) ? sb.ToString(0, n) : null;
            }
            finally { CloseHandle(h); }
        }

        // ---------------------------------------------------------------- zadanie Windows: pomocnik kończy się razem z programem

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
        [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int cls, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int size);
        [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [StructLayout(LayoutKind.Sequential)]
        struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
            public int LimitFlags;
            public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
            public int ActiveProcessLimit;
            public UIntPtr Affinity;
            public int PriorityClass, SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct IO_COUNTERS { public ulong a, b, c, d, e, f; }

        [StructLayout(LayoutKind.Sequential)]
        struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION Basic;
            public IO_COUNTERS Io;
            public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
        }

        static IntPtr zadanie = IntPtr.Zero;

        // Proces dołączony do zadania kończy się, gdy kończy się LivePL Connect (także po awarii albo
        // zamknięciu przez Menedżera zadań), więc pomocnik nigdy nie zostaje sam w tle.
        public static void DolaczDoZadania(IntPtr proces)
        {
            try
            {
                if (zadanie == IntPtr.Zero)
                {
                    zadanie = CreateJobObject(IntPtr.Zero, null);
                    var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                    info.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                    SetInformationJobObject(zadanie, 9 /* JobObjectExtendedLimitInformation */, ref info, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
                }
                AssignProcessToJobObject(zadanie, proces);
            }
            catch { /* bez zadania pomocnik i tak kończymy sami przy zamknięciu */ }
        }
    }

    // ---------------------------------------------------------------- podpis pobranej aktualizacji

    // Aktualizacja musi mieć ważny podpis Authenticode certyfikatem Live Production z Certum. Suma SHA-256
    // przychodzi z tego samego serwera co plik, więc sama nie chroni przed podmianą obu na serwerze.
    // Przy zmianie certyfikatu (inna nazwa podpisującego) najpierw wydaj wersję, która zna nową nazwę.
    static class Podpis
    {
        public static readonly string[] Podpisujacy = { "Open Source Developer Karol Kowalski" };

        [DllImport("wintrust.dll", CharSet = CharSet.Unicode)]
        static extern int WinVerifyTrust(IntPtr hwnd, [MarshalAs(UnmanagedType.LPStruct)] Guid action, ref WINTRUST_DATA data);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct WINTRUST_FILE_INFO { public int cbStruct; public string pcwszFilePath; public IntPtr hFile; public IntPtr pgKnownSubject; }

        [StructLayout(LayoutKind.Sequential)]
        struct WINTRUST_DATA
        {
            public int cbStruct; public IntPtr pPolicyCallbackData, pSIPClientData; public int dwUIChoice, fdwRevocationChecks, dwUnionChoice;
            public IntPtr pFile; public int dwStateAction; public IntPtr hWVTStateData, pwszURLReference; public int dwProvFlags, dwUIContext; public IntPtr pSignatureSettings;
        }

        static string Cn(string dn)
        {
            var m = System.Text.RegularExpressions.Regex.Match(dn ?? "", "CN=(\"[^\"]+\"|[^,]+)");
            return m.Success ? m.Groups[1].Value.Trim('"').Trim() : "";
        }

        // null, gdy podpis jest nasz i ważny; inaczej opis, czego brakuje
        public static string Sprawdz(string plik)
        {
            var fi = new WINTRUST_FILE_INFO { cbStruct = Marshal.SizeOf(typeof(WINTRUST_FILE_INFO)), pcwszFilePath = plik };
            var pfi = Marshal.AllocHGlobal(fi.cbStruct);
            try
            {
                Marshal.StructureToPtr(fi, pfi, false);
                var d = new WINTRUST_DATA { cbStruct = Marshal.SizeOf(typeof(WINTRUST_DATA)), dwUIChoice = 2 /* bez okienek */, dwUnionChoice = 1 /* plik */, pFile = pfi };
                int w = WinVerifyTrust(IntPtr.Zero, new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE") /* WINTRUST_ACTION_GENERIC_VERIFY_V2 */, ref d);
                if (w != 0) return "podpis nieważny albo brak podpisu (0x" + w.ToString("x8") + ")";
                var cert = System.Security.Cryptography.X509Certificates.X509Certificate.CreateFromSignedFile(plik);
                var kto = Cn(cert.Subject);
                if (Array.IndexOf(Podpisujacy, kto) < 0) return "podpisał „" + kto + "”, a nie Live Production";
                if (Cn(cert.Issuer).IndexOf("Certum", StringComparison.OrdinalIgnoreCase) < 0) return "certyfikat nie od Certum: " + Cn(cert.Issuer);
                return null;
            }
            catch (Exception e) { return "nie mogę sprawdzić podpisu: " + e.Message; }
            finally { Marshal.FreeHGlobal(pfi); }
        }
    }

    // ---------------------------------------------------------------- skróty .lnk z AppUserModelID

    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellLinkW
    {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder file, int cch, IntPtr fd, int flags);
        void GetIDList(out IntPtr ppidl);
        void SetIDList(IntPtr pidl);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder name, int cch);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder dir, int cch);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string dir);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder args, int cch);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string args);
        void GetHotkey(out short hotkey);
        void SetHotkey(short hotkey);
        void GetShowCmd(out int cmd);
        void SetShowCmd(int cmd);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int cch, out int icon);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string path, int icon);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, int reserved);
        void Resolve(IntPtr hwnd, int flags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string file);
    }

    [ComImport, Guid("0000010b-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPersistFile
    {
        void GetClassID(out Guid id);
        [PreserveSig] int IsDirty();
        void Load([MarshalAs(UnmanagedType.LPWStr)] string file, int mode);
        void Save([MarshalAs(UnmanagedType.LPWStr)] string file, bool remember);
        void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string file);
        void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string file);
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore
    {
        void GetCount(out uint count);
        void GetAt(uint index, out PROPERTYKEY key);
        void GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
        void SetValue(ref PROPERTYKEY key, ref PROPVARIANT value);
        void Commit();
    }

    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    struct PROPERTYKEY { public Guid fmtid; public uint pid; }

    // pełny rozmiar PROPVARIANT (24 bajty w 64 bitach): PropVariantClear zeruje całą strukturę
    [StructLayout(LayoutKind.Explicit)]
    struct PROPVARIANT
    {
        [FieldOffset(0)] public ushort vt;
        [FieldOffset(8)] public IntPtr p;
        [FieldOffset(16)] public IntPtr p2;
    }

    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    class ShellLink { }

    static class Skrot
    {
        [DllImport("ole32.dll")] static extern int PropVariantClear(ref PROPVARIANT pv);

        public static void Utworz(string lnk, string cel, string folder, string opis, string aumid)
        {
            var link = (IShellLinkW)new ShellLink();
            link.SetPath(cel);
            link.SetWorkingDirectory(folder);
            link.SetDescription(opis);
            link.SetIconLocation(cel, 0);
            if (!string.IsNullOrEmpty(aumid))
            {
                // PKEY_AppUserModel_ID: powiadomienia i pasek zadań łączą okno ze skrótem
                var klucz = new PROPERTYKEY { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };
                var w = new PROPVARIANT { vt = 31 /* VT_LPWSTR */, p = Marshal.StringToCoTaskMemUni(aumid) };
                var magazyn = (IPropertyStore)link;
                try { magazyn.SetValue(ref klucz, ref w); magazyn.Commit(); }
                finally { PropVariantClear(ref w); }
            }
            ((IPersistFile)link).Save(lnk, true);
            Marshal.ReleaseComObject(link);
        }

        public static string Cel(string lnk)
        {
            var link = (IShellLinkW)new ShellLink();
            try
            {
                ((IPersistFile)link).Load(lnk, 0);
                var sb = new StringBuilder(1024);
                link.GetPath(sb, sb.Capacity, IntPtr.Zero, 0x4 /* SLGP_RAWPATH */);
                return Environment.ExpandEnvironmentVariables(sb.ToString());
            }
            finally { Marshal.ReleaseComObject(link); }
        }
    }
}
