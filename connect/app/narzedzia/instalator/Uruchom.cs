// LivePL-Connect-Instalator.exe: mały program, który rozpakowuje LivePL Connect do folderu tymczasowego
// (pokazując okienko „Przygotowuję instalator…” w barwach LivePL), uruchamia go w trybie instalatora,
// czeka, aż instalator się zamknie, i sprząta folder tymczasowy.
// LivePL Connect od 0.6.0 działa na silniku WebView2 z Windows. Gdy go brakuje (rzadko: stary Windows 10
// bez aktualizacji Edge, wersje LTSC), ten program pobiera od Microsoftu i instaluje WebView2 Runtime.
// Kompiluje go narzedzia/zrob-instalator.mjs kompilatorem C# z Windows (bez dodatkowych narzędzi).

using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography.X509Certificates;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("Instalator LivePL Connect")]
[assembly: AssemblyDescription("Instalator LivePL Connect: zdalny pulpit Live Production")]
[assembly: AssemblyCompany("Live Production")]
[assembly: AssemblyProduct("LivePL Connect")]
[assembly: AssemblyCopyright("Copyright © 2026 Live Production Karol Kowalski (licencja MIT)")]
[assembly: System.Runtime.Versioning.TargetFramework(".NETFramework,Version=v4.8", FrameworkDisplayName = ".NET Framework 4.8")]

// Składnik Microsoft Edge WebView2 Runtime: sprawdzenie (tak jak radzi Microsoft: wartość „pv” w rejestrze)
// i instalacja przez oficjalny mały instalator Microsoftu, zawsze ze sprawdzeniem podpisu Microsoftu.
static class WebView2Runtime
{
    const string KLUCZ = @"Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    const string ADRES = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";

    static bool Wersja(RegistryKey baza, string sciezka)
    {
        try
        {
            using (var k = baza.OpenSubKey(sciezka))
            {
                var v = k == null ? null : k.GetValue("pv") as string;
                return !string.IsNullOrEmpty(v) && v != "0.0.0.0";
            }
        }
        catch { return false; }
    }

    public static bool Jest()
    {
        return Wersja(Registry.LocalMachine, @"SOFTWARE\WOW6432Node\" + KLUCZ) || Wersja(Registry.LocalMachine, @"SOFTWARE\" + KLUCZ)
            || Wersja(Registry.CurrentUser, @"Software\" + KLUCZ);
    }

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

    // ważny podpis Authenticode, a podpisującym jest Microsoft Corporation
    static bool PodpisMicrosoftu(string plik)
    {
        var fi = new WINTRUST_FILE_INFO { cbStruct = Marshal.SizeOf(typeof(WINTRUST_FILE_INFO)), pcwszFilePath = plik };
        var pfi = Marshal.AllocHGlobal(fi.cbStruct);
        try
        {
            Marshal.StructureToPtr(fi, pfi, false);
            var d = new WINTRUST_DATA { cbStruct = Marshal.SizeOf(typeof(WINTRUST_DATA)), dwUIChoice = 2 /* WTD_UI_NONE */, dwUnionChoice = 1 /* plik */, pFile = pfi };
            var akcja = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE"); // WINTRUST_ACTION_GENERIC_VERIFY_V2
            if (WinVerifyTrust(IntPtr.Zero, akcja, ref d) != 0) return false;
            var cert = X509Certificate.CreateFromSignedFile(plik);
            return cert.Subject.Contains("O=Microsoft Corporation");
        }
        catch { return false; }
        finally { Marshal.FreeHGlobal(pfi); }
    }

    // null, gdy się udało; inaczej opis błędu
    public static string Zainstaluj(Action<string> napis)
    {
        var plik = Path.Combine(Path.GetTempPath(), "MicrosoftEdgeWebview2Setup-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".exe");
        try
        {
            napis("Pobieram składnik Microsoft WebView2…");
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12 | (SecurityProtocolType)12288;
            using (var k = new WebClient()) k.DownloadFile(ADRES, plik);
            if (!PodpisMicrosoftu(plik)) return "Pobrany instalator WebView2 nie ma ważnego podpisu Microsoftu.";
            napis("Instaluję składnik Microsoft WebView2…");
            using (var p = Process.Start(new ProcessStartInfo(plik, "/silent /install") { UseShellExecute = false, CreateNoWindow = true }))
            {
                if (!p.WaitForExit(10 * 60 * 1000)) return "Instalacja WebView2 trwa zbyt długo.";
            }
            for (int i = 0; i < 20 && !Jest(); i++) Thread.Sleep(500);
            return Jest() ? null : "Po instalacji nadal brakuje składnika WebView2.";
        }
        catch (Exception e) { return e.Message; }
        finally { try { File.Delete(plik); } catch { } }
    }
}

static class Program
{
    [STAThread]
    static int Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        var okno = new Okno(args);
        Application.Run(okno);
        return okno.Kod;
    }
}

class Okno : Form
{
    readonly string[] argumenty;
    readonly string folder = Path.Combine(Path.GetTempPath(), "LivePL-Connect-instalator-" + Guid.NewGuid().ToString("N").Substring(0, 8));
    readonly Image logo;
    float postep;
    string napis = "Przygotowuję instalator…";
    public int Kod;

    static readonly Color Tlo = Color.FromArgb(13, 15, 18);
    static readonly Color Slaby = Color.FromArgb(139, 149, 161);

    // skala ekranu (100% = 1, 150% = 1,5): okno jest świadome DPI, więc wszystko liczymy sami
    float skala = 1f;
    float S(float v) { return v * skala; }

    [System.Runtime.InteropServices.DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr okno, int atrybut, ref int wartosc, int rozmiar);
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern bool AllowSetForegroundWindow(int proces);
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern uint GetDpiForWindow(IntPtr okno);

    public Okno(string[] args)
    {
        argumenty = args;
        Text = "Instalator LivePL Connect";
        FormBorderStyle = FormBorderStyle.None;
        // położenie liczymy sami w Load: dopiero wtedy znamy skalę ekranu i docelowy rozmiar
        // (z CenterScreen Windows środkował małe okienko, które potem rosło w prawo i w dół)
        StartPosition = FormStartPosition.Manual;
        AutoScaleMode = AutoScaleMode.None;
        Load += (o, e) => Wysrodkuj();
        BackColor = Tlo;
        DoubleBuffered = true;
        ShowInTaskbar = true;
        // na wierzchu, dopóki rozpakowujemy: inaczej Windows potrafi schować okienko pod innymi oknami
        TopMost = true;
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
        var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("logo.png");
        if (s != null) logo = Image.FromStream(s);
        // zaokrąglone rogi w Windows 11 (w starszych Windows nic się nie dzieje)
        HandleCreated += (o, e) => { try { int r = 2; DwmSetWindowAttribute(Handle, 33, ref r, 4); } catch { } };
        Shown += (o, e) => { Activate(); new Thread(Rozpakuj) { IsBackground = true }.Start(); };
    }

    // rozmiar według skali ekranu, a potem środek ekranu, na którym jest kursor
    void Wysrodkuj()
    {
        var ekran = Screen.FromPoint(Cursor.Position).WorkingArea;
        // najpierw na tamten ekran, żeby odczytać jego skalę (monitory mogą mieć różne)
        Location = new Point(ekran.Left + ekran.Width / 2, ekran.Top + ekran.Height / 2);
        try { skala = Math.Max(1f, GetDpiForWindow(Handle) / 96f); }
        catch { using (var g = CreateGraphics()) skala = Math.Max(1f, g.DpiX / 96f); } // starsze Windows
        ClientSize = new Size((int)S(560), (int)S(260));
        Location = new Point(ekran.Left + (ekran.Width - Width) / 2, ekran.Top + (ekran.Height - Height) / 2);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
        g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
        float W = ClientSize.Width, H = ClientSize.Height;

        // czerwona wstęga u dołu, jak w logo i w oknie instalatora
        var wstega = new[] { new PointF(0, S(222)), new PointF(W, S(184)), new PointF(W, S(232)), new PointF(0, S(270)) };
        using (var pedzel = new LinearGradientBrush(new PointF(0, 0), new PointF(W, 0), Color.FromArgb(143, 29, 23), Color.FromArgb(227, 70, 58)))
            g.FillPolygon(pedzel, wstega);
        var pasekJasny = new[] { new PointF(0, S(222)), new PointF(W, S(184)), new PointF(W, S(192)), new PointF(0, S(230)) };
        using (var jasny = new SolidBrush(Color.FromArgb(40, 255, 255, 255))) g.FillPolygon(jasny, pasekJasny);

        if (logo != null) g.DrawImage(logo, S(30), S(26), S(84), S(84));
        using (var duzy = new Font("Segoe UI", S(38), FontStyle.Bold | FontStyle.Italic, GraphicsUnit.Pixel))
        using (var connect = new Font("Segoe UI Semibold", S(30), FontStyle.Regular, GraphicsUnit.Pixel))
        using (var sredni = new Font("Segoe UI", S(15), FontStyle.Regular, GraphicsUnit.Pixel))
        using (var tekst = new Font("Segoe UI Semibold", S(15), FontStyle.Regular, GraphicsUnit.Pixel))
        using (var bialy = new SolidBrush(Color.FromArgb(230, 233, 238)))
        using (var czerwony = new SolidBrush(Color.FromArgb(227, 70, 58)))
        using (var slaby = new SolidBrush(Slaby))
        {
            g.DrawString("Live", duzy, bialy, S(126), S(30));
            var szer = g.MeasureString("Live", duzy).Width;
            g.DrawString("PL", duzy, czerwony, S(126) + szer - S(13), S(30));
            var szerPL = g.MeasureString("PL", duzy).Width;
            g.DrawString("Connect", connect, bialy, S(126) + szer + szerPL - S(20), S(37));
            g.DrawString("Zdalny pulpit Live Production", sredni, slaby, S(130), S(80));

            g.DrawString(napis, tekst, bialy, S(32), S(130));
            var procent = (int)Math.Round(postep * 100) + "%";
            var sz = g.MeasureString(procent, tekst).Width;
            g.DrawString(procent, tekst, slaby, W - S(32) - sz, S(130));
        }

        float x = S(34), y = S(160), w = W - S(68), h = S(8);
        using (var tlo = new SolidBrush(Color.FromArgb(34, 39, 47))) Zaokraglony(g, tlo, x, y, w, h);
        using (var pasek = new LinearGradientBrush(new PointF(x, 0), new PointF(x + w, 0), Color.FromArgb(143, 29, 23), Color.FromArgb(227, 70, 58)))
            Zaokraglony(g, pasek, x, y, Math.Max(h, w * postep), h);
        using (var ramka = new Pen(Color.FromArgb(42, 48, 56))) g.DrawRectangle(ramka, 0, 0, W - 1, H - 1);
    }

    static void Zaokraglony(Graphics g, Brush pedzel, float x, float y, float w, float h)
    {
        using (var sciezka = new GraphicsPath())
        {
            sciezka.AddArc(x, y, h, h, 90, 180);
            sciezka.AddArc(x + w - h, y, h, h, 270, 180);
            sciezka.CloseFigure();
            g.FillPath(pedzel, sciezka);
        }
    }

    void Ustaw(float p, string t)
    {
        try { BeginInvoke((Action)(() => { postep = p; if (t != null) napis = t; Invalidate(); })); } catch { }
    }

    // ten sam ślad nieudanej aktualizacji co w programie (okno/Program.cs, klasa Nieudana)
    static void ZapiszNieudana(string powod)
    {
        try
        {
            var a = Assembly.GetExecutingAssembly().GetCustomAttributes(typeof(AssemblyInformationalVersionAttribute), false);
            var wersja = a.Length > 0 ? ((AssemblyInformationalVersionAttribute)a[0]).InformationalVersion : "?";
            var dane = Environment.GetEnvironmentVariable("LPC_DANE");
            var folder = !string.IsNullOrEmpty(dane) ? Path.Combine(dane, "lokalne")
                : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LivePL Connect");
            Directory.CreateDirectory(folder);
            File.WriteAllText(Path.Combine(folder, "aktualizacja-nieudana.txt"), wersja + "\n" + DateTime.UtcNow.ToString("o") + "\n" + (powod ?? "").Replace("\n", " ") + "\n");
        }
        catch { }
    }

    // brak WebView2 przy aktualizacji: stara wersja już się zamknęła, więc ją przywracamy (komputer bez obsługi
    // nie może zostać bez LivePL Connect); przy zwykłej instalacji mówimy, co zrobić
    bool ZapewnijWebView2()
    {
        // LPC_TEST_WEBVIEW2=brak: tylko do testów, udaje brak WebView2 i nieudaną instalację (bez pobierania)
        var test = Environment.GetEnvironmentVariable("LPC_TEST_WEBVIEW2") == "brak";
        if (!test && WebView2Runtime.Jest()) return true;
        var blad = test ? "test: brak WebView2" : WebView2Runtime.Zainstaluj(t => Ustaw(0f, t));
        if (blad == null) return true;
        var aktualizacja = argumenty.Any(a => a == "--aktualizuj" || a == "--updated");
        if (aktualizacja)
        {
            Kod = 3;
            var cel = argumenty.Where(a => a.StartsWith("--cel=")).Select(a => a.Substring(6)).FirstOrDefault()
                ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "LivePL Connect");
            var exe = Path.Combine(cel, "LivePL Connect.exe");
            ZapiszNieudana("brak WebView2: " + blad);
            var arg = argumenty.Contains("--w-tle") ? "--autostart" : "";
            // wersja z Electronem spróbowałaby aktualizacji za kilka sekund, i tak w kółko: do jej następnego
            // uruchomienia (np. po restarcie Windows) wyłączamy jej dostęp do serwera aktualizacji
            if (File.Exists(Path.Combine(cel, "resources", "app", "package.json")))
                arg = (arg + " \"--host-resolver-rules=MAP aktualizacje.livepl.eu ~NOTFOUND\"").Trim();
            try { if (File.Exists(exe)) Process.Start(new ProcessStartInfo(exe, arg) { UseShellExecute = false, WorkingDirectory = cel }); } catch { }
            return false;
        }
        Kod = 2;
        try
        {
            Invoke((Action)(() => MessageBox.Show(this, "LivePL Connect potrzebuje składnika Microsoft Edge WebView2, a nie udało się go zainstalować.\n\n" + blad
                + "\n\nSprawdź połączenie z internetem i uruchom instalator jeszcze raz. Możesz też zainstalować „Microsoft Edge WebView2 Runtime” ze strony Microsoftu.",
                "Instalator LivePL Connect", MessageBoxButtons.OK, MessageBoxIcon.Warning)));
        }
        catch { }
        return false;
    }

    void Rozpakuj()
    {
        try
        {
            if (!ZapewnijWebView2()) return;
            Ustaw(0f, "Przygotowuję instalator…");
            using (var zasob = Assembly.GetExecutingAssembly().GetManifestResourceStream("paczka.zip"))
            using (var zip = new ZipArchive(zasob, ZipArchiveMode.Read))
            {
                var wpisy = zip.Entries.Where(w => w.Name.Length > 0).ToList();
                Directory.CreateDirectory(folder);
                var pelny = Path.GetFullPath(folder) + Path.DirectorySeparatorChar;
                for (int i = 0; i < wpisy.Count; i++)
                {
                    var cel = Path.GetFullPath(Path.Combine(folder, wpisy[i].FullName));
                    if (!cel.StartsWith(pelny, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Niedozwolona ścieżka w paczce");
                    Directory.CreateDirectory(Path.GetDirectoryName(cel));
                    wpisy[i].ExtractToFile(cel, true);
                    Ustaw((i + 1f) / wpisy.Count, null);
                }
            }
            Ustaw(1f, "Uruchamiam instalator…");
            var dalej = string.Join(" ", argumenty.Select(a => "\"" + a.Replace("\"", "") + "\""));
            // okno instalatora może wyjść na pierwszy plan (Windows pozwala na to tylko za naszą zgodą)
            try { AllowSetForegroundWindow(-1); } catch { }
            var proces = Process.Start(new ProcessStartInfo(Path.Combine(folder, "LivePL Connect.exe"), "--instalator " + dalej)
            {
                UseShellExecute = false,
                WorkingDirectory = folder
            });
            Thread.Sleep(1500);
            BeginInvoke((Action)(() => Hide()));
            proces.WaitForExit();
            Kod = proces.ExitCode;
        }
        catch (Exception ex)
        {
            Kod = 1;
            try { Invoke((Action)(() => MessageBox.Show(this, "Nie udało się uruchomić instalatora LivePL Connect.\n\n" + ex.Message, "Instalator LivePL Connect", MessageBoxButtons.OK, MessageBoxIcon.Error))); } catch { }
        }
        finally
        {
            Sprzataj();
            try { BeginInvoke((Action)(() => Close())); } catch { }
        }
    }

    void Sprzataj()
    {
        for (int i = 0; i < 20; i++)
        {
            try { if (Directory.Exists(folder)) Directory.Delete(folder, true); return; }
            catch { Thread.Sleep(500); }
        }
    }
}
