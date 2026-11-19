// LivePL Connect: punkt wejścia. Ten sam program jest aplikacją albo (z „--instalator” / „--odinstaluj”)
// swoim własnym instalatorem — tak jak wcześniej wersja z Electronem.

using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.Versioning;
using System.Windows.Forms;

[assembly: AssemblyTitle("LivePL Connect")]
[assembly: AssemblyDescription("LivePL Connect: zdalny pulpit Live Production")]
[assembly: AssemblyCompany("Live Production")]
[assembly: AssemblyProduct("LivePL Connect")]
[assembly: AssemblyCopyright("Copyright © 2026 Live Production Karol Kowalski (licencja MIT)")]
// bez tego .NET zachowuje się jak dla starych programów (np. bez TLS 1.2 przy pobieraniu aktualizacji)
[assembly: TargetFramework(".NETFramework,Version=v4.8", FrameworkDisplayName = ".NET Framework 4.8")]

namespace LivePL.Connect
{
    static class Program
    {
        public static readonly string Folder = Path.GetDirectoryName(Application.ExecutablePath);
        public static readonly string Wersja = WersjaProgramu();
        public static string[] Argumenty;

        static string WersjaProgramu()
        {
            var a = Assembly.GetExecutingAssembly().GetCustomAttributes(typeof(AssemblyInformationalVersionAttribute), false);
            return a.Length > 0 ? ((AssemblyInformationalVersionAttribute)a[0]).InformationalVersion : "0.0.0";
        }

        public static bool Ma(string argument)
        {
            foreach (var a in Argumenty) if (string.Equals(a, argument, StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }

        public static string Wartosc(string nazwa)
        {
            foreach (var a in Argumenty) if (a.StartsWith("--" + nazwa + "=", StringComparison.OrdinalIgnoreCase)) return a.Substring(nazwa.Length + 3);
            return null;
        }

        // wersja deweloperska (LPC_DEV=1): bez autostartu w rejestrze i bez aktualizacji, z narzędziami programisty
        public static bool Dev { get { return Environment.GetEnvironmentVariable("LPC_DEV") == "1"; } }

        [STAThread]
        static int Main(string[] args)
        {
            Argumenty = args;
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12 | (SecurityProtocolType)12288 /* Tls13 */;
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.ThreadException += (o, e) => Dziennik.Zapisz("błąd: " + e.Exception);
            AppDomain.CurrentDomain.UnhandledException += (o, e) => Dziennik.Zapisz("błąd krytyczny: " + e.ExceptionObject);
            ServicePointManager.DefaultConnectionLimit = 8;
            // Folder roboczy poza folderem programu: inaczej program i procesy WebView2 (dziedziczą go)
            // blokowałyby podmianę folderu przy aktualizacji
            try { Environment.CurrentDirectory = Path.GetTempPath(); } catch { }
            // ten sam identyfikator co skróty (pasek zadań łączy okno z przypiętym skrótem), jak w Electronie
            try { Win.SetCurrentProcessExplicitAppUserModelID(Ma("--instalator") || Ma("--odinstaluj") ? "eu.livepl.connect.instalator" : "eu.livepl.connect"); } catch { }

            if (!SilnikWebView2.Jest())
            {
                // aktualizacja bez WebView2: wraca stara wersja, bez okienek (komputer może być bez obsługi)
                if (Ma("--instalator") && (Ma("--aktualizuj") || Ma("--updated"))) return Instalator.BezWebView2("brak WebView2");
                MessageBox.Show("LivePL Connect potrzebuje składnika Microsoft Edge WebView2, którego brakuje na tym komputerze.\n\n"
                    + "Uruchom instalator LivePL Connect jeszcze raz: sam go doinstaluje.", "LivePL Connect", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return 2;
            }
            if (Ma("--instalator")) return Instalator.Uruchom("instaluj");
            if (Ma("--odinstaluj")) return Instalator.Uruchom("odinstaluj");
            return Aplikacja.Uruchom();
        }
    }

    static class Dziennik
    {
        static readonly object zamek = new object();
        public static string Plik = Path.Combine(Path.GetTempPath(), "livepl-connect-app.log");

        public static void Zapisz(string tekst)
        {
            try
            {
                lock (zamek) File.AppendAllText(Plik, "[" + DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ") + "] " + tekst + Environment.NewLine);
            }
            catch { /* dziennik nie jest ważniejszy od programu */ }
        }
    }

    // Ślad nieudanej aktualizacji: program nie próbuje tej samej wersji automatycznie przez kilka godzin
    // (inaczej po każdym nieudanym podejściu pobierałby ją i uruchamiał od nowa, w kółko).
    static class Nieudana
    {
        public const int GODZIN = 6;

        static string Plik
        {
            get
            {
                var dane = Environment.GetEnvironmentVariable("LPC_DANE");
                var folder = !string.IsNullOrEmpty(dane) ? Path.Combine(dane, "lokalne")
                    : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LivePL Connect");
                return Path.Combine(folder, "aktualizacja-nieudana.txt");
            }
        }

        public static void Zapisz(string wersja, string powod)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(Plik));
                File.WriteAllText(Plik, wersja + "\n" + DateTime.UtcNow.ToString("o") + "\n" + (powod ?? "").Replace("\n", " ") + "\n");
            }
            catch { }
        }

        public static void Usun() { try { File.Delete(Plik); } catch { } }

        // true, gdy ta wersja nie zainstalowała się niedawno (wtedy czekamy, chyba że użytkownik kliknie sam)
        public static bool Niedawno(string wersja)
        {
            try
            {
                var w = File.ReadAllLines(Plik);
                DateTime kiedy;
                return w.Length >= 2 && w[0].Trim() == wersja
                    && DateTime.TryParse(w[1].Trim(), null, System.Globalization.DateTimeStyles.RoundtripKind, out kiedy)
                    && DateTime.UtcNow - kiedy.ToUniversalTime() < TimeSpan.FromHours(GODZIN);
            }
            catch { return false; }
        }
    }

    static class SilnikWebView2
    {
        // czy jest WebView2 Runtime (w Windows 11 zawsze, w Windows 10 razem z aktualizacjami Edge)
        public static bool Jest()
        {
            try { return !string.IsNullOrEmpty(Microsoft.Web.WebView2.Core.CoreWebView2Environment.GetAvailableBrowserVersionString()); }
            catch (Exception e)
            {
                Dziennik.Zapisz("WebView2: " + e.GetType().Name + ": " + e.Message);
                return false;
            }
        }
    }

    static class Uruchamianie
    {
        // własny program albo folder w Eksploratorze; bez okna konsoli
        public static Process Start(string plik, string argumenty, string folder)
        {
            var p = new ProcessStartInfo(plik, argumenty ?? "") { UseShellExecute = false, WorkingDirectory = folder ?? Path.GetDirectoryName(plik) };
            return Process.Start(p);
        }

        // argument w cudzysłowie; ukośnik na końcu podwajamy, żeby nie „zjadł” cudzysłowu zamykającego
        public static string Cudzyslow(string a)
        {
            var t = (a ?? "").Replace("\"", "");
            int n = 0;
            while (n < t.Length && t[t.Length - 1 - n] == '\\') n++;
            return "\"" + t + new string('\\', n) + "\"";
        }
    }
}
