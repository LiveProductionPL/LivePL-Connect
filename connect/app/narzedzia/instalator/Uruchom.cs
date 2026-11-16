// LivePL-Connect-Instalator.exe: mały program, który rozpakowuje LivePL Connect do folderu tymczasowego
// (pokazując okienko „Przygotowuję instalator…” w barwach LivePL), uruchamia go w trybie instalatora,
// czeka, aż instalator się zamknie, i sprząta folder tymczasowy.
// Kompiluje go narzedzia/zrob-instalator.mjs kompilatorem C# z Windows (bez dodatkowych narzędzi).

using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("Instalator LivePL Connect")]
[assembly: AssemblyDescription("Instalator LivePL Connect: zdalny pulpit Live Production")]
[assembly: AssemblyCompany("Live Production")]
[assembly: AssemblyProduct("LivePL Connect")]
[assembly: AssemblyCopyright("Copyright © 2026 Live Production Karol Kowalski (licencja MIT)")]

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

    void Rozpakuj()
    {
        try
        {
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
