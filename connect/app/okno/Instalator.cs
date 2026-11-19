// Instalator i odinstalowanie LivePL Connect: ten sam program w trybie „--instalator” albo „--odinstaluj”.
// Instalacja tylko dla bieżącego użytkownika, bez uprawnień administratora:
//   pliki      %LOCALAPPDATA%\Programs\LivePL Connect
//   skróty     menu Start i (opcjonalnie) pulpit
//   wpis       HKCU\...\Uninstall\LivePL Connect, czyli „Aplikacje i funkcje” w Ustawieniach Windows
// Ustawienia (w tym trwałe ID komputera) zostają w %APPDATA%\LivePL Connect.
// „--aktualizuj”: bez powitania, od razu postęp, a po wszystkim program wraca sam.
// Zastępuje każdą wcześniejszą wersję: z Electronem (0.4.2–0.5.x) i z instalatorem NSIS (do 0.4.1).
// Do testów: --cel=<folder> instaluje gdzie indziej, skróty kładzie w <folder>\_skroty, bez wpisu w rejestrze.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

namespace LivePL.Connect
{
    static class Instalator
    {
        const string NAZWA = "LivePL Connect";
        const string KLUCZ = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\LivePL Connect";
        const string AUMID = "eu.livepl.connect";

        static string tryb;
        static string TEST_CEL;
        static bool ZE_STAREJ, AKTUALIZACJA, URUCHOM_PO;
        static string CEL, EXE, ZRODLO;
        static string SkrotyStart, SkrotyPulpit;
        static Okno okno;
        static bool odinstalowano;

        static void Przygotuj(string t)
        {
            tryb = t;
            TEST_CEL = Program.Wartosc("cel");
            // „--updated” (z „/S”) dostajemy od starej wersji 0.4.1: jej moduł aktualizacji (electron-updater)
            // pobiera nasz instalator według latest.yml i uruchamia go przy zamykaniu programu
            ZE_STAREJ = Program.Ma("--updated");
            AKTUALIZACJA = Program.Ma("--aktualizuj") || ZE_STAREJ;
            // nasza aktualizacja zamyka program, więc go przywracamy; stara wersja instaluje przy zamknięciu
            // przez użytkownika, więc wtedy program wraca tylko na wyraźne „--force-run”
            URUCHOM_PO = Program.Ma("--aktualizuj") || Program.Ma("--force-run");
            var lokalne = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            CEL = TEST_CEL != null ? Path.GetFullPath(TEST_CEL) : Path.Combine(lokalne, "Programs", NAZWA);
            EXE = Path.Combine(CEL, NAZWA + ".exe");
            ZRODLO = Program.Folder;
            if (TEST_CEL != null)
            {
                SkrotyStart = Path.Combine(CEL, "_skroty", "Start");
                SkrotyPulpit = Path.Combine(CEL, "_skroty", "Pulpit");
            }
            else
            {
                SkrotyStart = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), @"Microsoft\Windows\Start Menu\Programs");
                SkrotyPulpit = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            }
        }

        static void Postep(double ulamek, string opis)
        {
            if (okno != null) okno.Wyslij("postep", new Dictionary<string, object> { { "ulamek", Math.Max(0, Math.Min(1, ulamek)) }, { "opis", opis } });
        }

        static void Polecenie(string plik, string argumenty)
        {
            var p = new ProcessStartInfo(plik, argumenty) { UseShellExecute = false, CreateNoWindow = true };
            using (var pr = Process.Start(p)) pr.WaitForExit(30000);
        }

        // ---------------------------------------------------------------- stan

        public static string ZainstalowanaWersja()
        {
            try
            {
                if (File.Exists(EXE))
                {
                    // wersja z Electronem: resources\app\package.json
                    var pakiet = Path.Combine(CEL, "resources", "app", "package.json");
                    if (File.Exists(pakiet))
                    {
                        var j = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(pakiet));
                        object v;
                        return j != null && j.TryGetValue("version", out v) ? Convert.ToString(v) : "?";
                    }
                    var w = FileVersionInfo.GetVersionInfo(EXE).ProductVersion;
                    // stara instalacja (instalator NSIS) ma program, ale nie da się z niego odczytać naszej wersji
                    if (!string.IsNullOrEmpty(w) && File.Exists(Path.Combine(CEL, "Microsoft.Web.WebView2.Core.dll"))) return w;
                    return "starsza";
                }
            }
            catch { }
            return null;
        }

        // LivePL Connect (każda wersja) i jego pomocnik uruchomione z folderu instalacji
        static List<Process> Dzialajace(string folder)
        {
            var wynik = new List<Process>();
            var przedrostek = folder.TrimEnd('\\') + "\\";
            int ja = Process.GetCurrentProcess().Id;
            foreach (var nazwa in new[] { NAZWA, "host" })
            {
                foreach (var p in Process.GetProcessesByName(nazwa))
                {
                    if (p.Id == ja) continue;
                    var s = Win.SciezkaProcesu(p.Id);
                    if (s != null && s.StartsWith(przedrostek, StringComparison.OrdinalIgnoreCase)) wynik.Add(p);
                }
            }
            return wynik;
        }

        static void ZamknijDzialajace(string folder)
        {
            foreach (var p in Dzialajace(folder)) { try { p.Kill(); } catch { } }
            for (int i = 0; i < 20 && Dzialajace(folder).Count > 0; i++) Thread.Sleep(250);
        }

        // ---------------------------------------------------------------- kopiowanie z postępem

        static List<string> Lista(string folder)
        {
            var w = new List<string>();
            foreach (var f in Directory.GetFiles(folder, "*", SearchOption.AllDirectories)) w.Add(f.Substring(folder.TrimEnd('\\').Length + 1));
            return w;
        }

        static long Kopiuj(string doFolderu, Action<double, string> postep)
        {
            var pliki = Lista(ZRODLO);
            long razem = 0;
            foreach (var p in pliki) razem += new FileInfo(Path.Combine(ZRODLO, p)).Length;
            if (razem == 0) razem = 1;
            long skopiowano = 0;
            for (int i = 0; i < pliki.Count; i++)
            {
                var cel = Path.Combine(doFolderu, pliki[i]);
                Directory.CreateDirectory(Path.GetDirectoryName(cel));
                File.Copy(Path.Combine(ZRODLO, pliki[i]), cel, true);
                skopiowano += new FileInfo(cel).Length;
                if (i % 3 == 0 || i == pliki.Count - 1) postep((double)skopiowano / razem, "Kopiuję pliki: " + (i + 1) + " z " + pliki.Count);
            }
            return razem;
        }

        static void UsunFolder(string folder)
        {
            for (int i = 0; ; i++)
            {
                try { if (Directory.Exists(folder)) Directory.Delete(folder, true); return; }
                catch
                {
                    if (i >= 5) throw;
                    Thread.Sleep(300);
                }
            }
        }

        // ---------------------------------------------------------------- skróty i wpis w Windows

        static void Skrot(string folder)
        {
            Directory.CreateDirectory(folder);
            LivePL.Connect.Skrot.Utworz(Path.Combine(folder, NAZWA + ".lnk"), EXE, CEL, "LivePL Connect: zdalny pulpit Live Production", AUMID);
        }

        static void Zarejestruj(long rozmiar)
        {
            if (TEST_CEL != null) return;
            using (var k = Registry.CurrentUser.CreateSubKey(KLUCZ))
            {
                k.SetValue("DisplayName", NAZWA);
                k.SetValue("DisplayVersion", Program.Wersja);
                k.SetValue("Publisher", "Live Production");
                k.SetValue("DisplayIcon", "\"" + EXE + "\",0");
                k.SetValue("InstallLocation", CEL);
                k.SetValue("UninstallString", "\"" + EXE + "\" --odinstaluj");
                k.SetValue("URLInfoAbout", "https://liveproduction.pl/");
                k.SetValue("HelpLink", "https://livepl.eu/");
                k.SetValue("Comments", "Zdalny pulpit Live Production");
                k.SetValue("NoModify", 1, RegistryValueKind.DWord);
                k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                k.SetValue("EstimatedSize", (int)Math.Round(rozmiar / 1024.0), RegistryValueKind.DWord);
            }
        }

        // Wersje do 0.4.1 stawiał instalator NSIS: wpis „LivePL Connect 0.4.1” w „Aplikacje i funkcje”
        // i pliki w %LOCALAPPDATA%\Programs\livepl-connect. Usuwamy wpis i stary folder (tylko taki,
        // który wygląda jak stary LivePL Connect, i nigdy nie nasz nowy folder).
        static void SprzatnijStaryInstalator()
        {
            if (TEST_CEL != null) return;
            var programy = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs").ToLowerInvariant() + "\\";
            using (var u = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall", true))
            {
                if (u == null) return;
                foreach (var nazwa in u.GetSubKeyNames())
                {
                    if (nazwa == NAZWA) continue;
                    string wyswietlana, odinstaluj;
                    using (var k = u.OpenSubKey(nazwa))
                    {
                        if (k == null) continue;
                        wyswietlana = Convert.ToString(k.GetValue("DisplayName") ?? "");
                        odinstaluj = Convert.ToString(k.GetValue("UninstallString") ?? "");
                    }
                    if (!wyswietlana.StartsWith(NAZWA, StringComparison.OrdinalIgnoreCase)) continue;
                    var m = Regex.Match(odinstaluj, "^\"([^\"]+)\"");
                    var stary = m.Success ? Path.GetDirectoryName(m.Groups[1].Value) : null;
                    if (stary != null && stary.ToLowerInvariant().StartsWith(programy) && !string.Equals(stary, CEL, StringComparison.OrdinalIgnoreCase)
                        && File.Exists(Path.Combine(stary, NAZWA + ".exe")))
                    {
                        ZamknijDzialajace(stary);
                        try { UsunFolder(stary); } catch { /* zostanie do następnej aktualizacji */ }
                    }
                    try { u.DeleteSubKeyTree(nazwa, false); } catch { }
                }
            }
            // pobrane przez starą wersję instalatory (w tym ten, który właśnie działa) sprzątamy po chwili
            if (ZE_STAREJ)
            {
                var pamiec = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "livepl-connect-updater");
                if (Directory.Exists(pamiec)) PoChwili(60, "rmdir /s /q " + Uruchamianie.Cudzyslow(pamiec));
            }
        }

        static void PoChwili(int sekund, string polecenie)
        {
            var p = new ProcessStartInfo("cmd.exe", "/d /c \"ping -n " + sekund + " 127.0.0.1 >nul & " + polecenie + "\"")
            {
                UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = Path.GetTempPath()
            };
            Process.Start(p);
        }

        // skrót na pulpicie z poprzedniej instalacji (np. starej wersji) ma wskazywać nowy program
        static void PoprawSkrotNaPulpicie()
        {
            var lnk = Path.Combine(SkrotyPulpit, NAZWA + ".lnk");
            try
            {
                if (!File.Exists(lnk)) return;
                var cel = LivePL.Connect.Skrot.Cel(lnk) ?? "";
                if (!string.Equals(cel, EXE, StringComparison.OrdinalIgnoreCase) && cel.EndsWith("LivePL Connect.exe", StringComparison.OrdinalIgnoreCase)) Skrot(SkrotyPulpit);
            }
            catch { /* skrót nieczytelny: zostawiamy */ }
        }

        // ---------------------------------------------------------------- instalacja

        static Dictionary<string, object> Wynik(bool ok, string blad)
        {
            var w = new Dictionary<string, object> { { "ok", ok } };
            if (ok) w["cel"] = CEL; else w["blad"] = blad;
            return w;
        }

        // folder, który wolno zastąpić albo usunąć: nie ma go, jest pusty albo jest w nim LivePL Connect
        // (chroni przed pomyłką w --cel= albo w ścieżce)
        static bool NaszFolder(string folder)
        {
            if (!Directory.Exists(folder)) return true;
            if (File.Exists(Path.Combine(folder, NAZWA + ".exe"))) return true;
            using (var e = Directory.EnumerateFileSystemEntries(folder).GetEnumerator()) return !e.MoveNext();
        }

        static bool Przenies(string z, string doF)
        {
            for (int i = 0; i < 12; i++)
            {
                try { Directory.Move(z, doF); return true; }
                catch (Exception e)
                {
                    if (i == 11) Dziennik.Zapisz("instalator: nie mogę przenieść " + z + " -> " + doF + ": " + e.Message);
                    Thread.Sleep(400);
                }
            }
            return false;
        }

        // kroki, bez których program i tak działa (skróty, wpis w Windows, sprzątanie): błąd tylko w dzienniku
        static void Bezpiecznie(string co, Action a)
        {
            try { a(); }
            catch (Exception e) { Dziennik.Zapisz("instalator: " + co + ": " + e.Message); }
        }

        // Nowa wersja najpierw w folderze obok, potem szybka podmiana folderów. Do samego końca na dysku jest
        // cała poprzednia wersja, więc nieudana instalacja (np. pliki w użyciu) jej nie psuje.
        static Dictionary<string, object> Instaluj(bool pulpit)
        {
            try
            {
                if (!NaszFolder(CEL)) throw new Exception("Folder " + CEL + " nie wygląda na folder LivePL Connect, więc go nie zastąpię.");
                var nowy = CEL + ".nowy";
                var stary = CEL + ".stary";
                Directory.CreateDirectory(Path.GetDirectoryName(CEL));
                if (Directory.Exists(nowy)) UsunFolder(nowy); // pozostałość po przerwanej instalacji
                var rozmiar = Kopiuj(nowy, (u, opis) => Postep(u * 0.85, opis));
                Postep(0.86, "Zamykam LivePL Connect, jeśli działa…");
                ZamknijDzialajace(CEL);
                Postep(0.88, "Podmieniam pliki programu…");
                if (Directory.Exists(stary)) Bezpiecznie("stary folder", () => UsunFolder(stary));
                if (Directory.Exists(CEL) && !Przenies(CEL, stary))
                {
                    Bezpiecznie("folder nowej wersji", () => UsunFolder(nowy));
                    throw new Exception("Nie mogę zastąpić poprzedniej wersji: jej pliki są w użyciu. Zamknij LivePL Connect i spróbuj jeszcze raz.");
                }
                if (!Przenies(nowy, CEL))
                {
                    if (Directory.Exists(stary) && !Directory.Exists(CEL)) Przenies(stary, CEL); // poprzednia wersja wraca
                    throw new Exception("Nie mogę przenieść nowej wersji na miejsce poprzedniej.");
                }
                if (Directory.Exists(stary))
                {
                    try { UsunFolder(stary); }
                    catch { PoChwili(30, "rmdir /s /q " + Uruchamianie.Cudzyslow(stary)); }
                }
                Postep(0.93, "Tworzę skróty…");
                Bezpiecznie("skrót w menu Start", () => Skrot(SkrotyStart));
                if (pulpit) Bezpiecznie("skrót na pulpicie", () => Skrot(SkrotyPulpit));
                else Bezpiecznie("skrót na pulpicie", PoprawSkrotNaPulpicie);
                Postep(0.96, "Rejestruję LivePL Connect w Windows…");
                Bezpiecznie("starsze wersje", SprzatnijStaryInstalator);
                Bezpiecznie("wpis w Windows", () => Zarejestruj(rozmiar));
                Nieudana.Usun();
                Postep(1, "Gotowe");
                Dziennik.Zapisz("instalator: zainstalowano " + Program.Wersja + " w " + CEL);
                return Wynik(true, null);
            }
            catch (Exception e)
            {
                Dziennik.Zapisz("instalator: " + e);
                return Wynik(false, e.Message);
            }
        }

        static Dictionary<string, object> Odinstaluj(bool dane)
        {
            try
            {
                Postep(0.1, "Zamykam LivePL Connect…");
                ZamknijDzialajace(CEL);
                Postep(0.4, "Usuwam skróty…");
                foreach (var f in new[] { SkrotyStart, SkrotyPulpit })
                {
                    try
                    {
                        var lnk = Path.Combine(f, NAZWA + ".lnk");
                        if (File.Exists(lnk) && string.Equals(Path.GetFullPath(LivePL.Connect.Skrot.Cel(lnk)), EXE, StringComparison.OrdinalIgnoreCase)) File.Delete(lnk);
                    }
                    catch { /* skrót już usunięty albo inny */ }
                }
                Postep(0.6, "Usuwam wpis z Windows…");
                if (TEST_CEL == null)
                {
                    try { Registry.CurrentUser.DeleteSubKeyTree(KLUCZ, false); } catch { }
                    // start razem z Windows (dostęp bez obsługi)
                    try { using (var k = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true)) if (k != null) k.DeleteValue(NAZWA, false); } catch { }
                }
                if (dane)
                {
                    Postep(0.8, "Usuwam ustawienia LivePL Connect…");
                    foreach (var d in new[] {
                        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), NAZWA),
                        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), NAZWA) })
                    {
                        try { UsunFolder(d); } catch { }
                    }
                }
                Postep(1, "Gotowe");
                return Wynik(true, null);
            }
            catch (Exception e)
            {
                return Wynik(false, e.Message);
            }
        }

        // pliki programu usuwamy po zamknięciu okna (działający program nie skasuje sam siebie)
        static void UsunPoZamknieciu()
        {
            if (!NaszFolder(CEL)) { Dziennik.Zapisz("odinstalowanie: " + CEL + " nie wygląda na LivePL Connect, nie usuwam"); return; }
            PoChwili(3, "rmdir /s /q " + Uruchamianie.Cudzyslow(CEL));
        }

        // Aktualizacja się nie udała: wraca zainstalowana wersja (komputer bez obsługi nie może zostać bez
        // LivePL Connect). Wersja z Electronem sama spróbowałaby aktualizacji kilka sekund po starcie, i tak
        // w kółko, więc do jej następnego uruchomienia (np. po restarcie Windows) wyłączamy jej dostęp do
        // serwera aktualizacji. Nowsze wersje same czekają kilka godzin (Nieudana).
        public static bool PrzywrocPoprzednia(string powod)
        {
            Dziennik.Zapisz("instalator: " + powod + "; wracam do zainstalowanej wersji");
            Nieudana.Zapisz(Program.Wersja, powod);
            if (!File.Exists(EXE)) return false;
            var arg = Program.Ma("--w-tle") ? "--autostart" : "";
            if (File.Exists(Path.Combine(CEL, "resources", "app", "package.json")))
                arg = (arg + " \"--host-resolver-rules=MAP aktualizacje.livepl.eu ~NOTFOUND\"").Trim();
            try { Uruchamianie.Start(EXE, arg, CEL); return true; }
            catch (Exception e) { Dziennik.Zapisz("instalator: nie mogę uruchomić " + EXE + ": " + e.Message); return false; }
        }

        // ---------------------------------------------------------------- start

        // Brak WebView2 przy aktualizacji (stara wersja już się zamknęła): wracamy do starej wersji, żeby
        // komputer bez obsługi nie został bez LivePL Connect. Instalator z app.livepl.eu doinstaluje WebView2.
        public static int BezWebView2(string powod)
        {
            Przygotuj("instaluj");
            if (AKTUALIZACJA && PrzywrocPoprzednia(powod + ", aktualizacja przerwana")) return 3;
            return 2;
        }

        public static int Uruchom(string t)
        {
            Przygotuj(t);
            var dane = Path.Combine(Path.GetTempPath(), "LivePL-Connect-instalator-dane");
            WindowsFormsSynchronizationContext.AutoInstall = true;
            okno = new Okno(Path.Combine(Program.Folder, "ui", "instalator.html"), "instalator",
                t == "odinstaluj" ? "Odinstaluj LivePL Connect" : "Instalator LivePL Connect",
                new Size(820, 520), new Size(820, 520), false, dane, Program.Dev);
            okno.Obsluga = Obsluga;
            okno.Gotowe += () => { okno.Show(); okno.Activate(); Win.SetForegroundWindow(okno.Handle); };
            var uchwyt = okno.Handle;
            okno.Wysrodkuj();
            var kontekst = new ApplicationContext();
            okno.FormClosed += (o, e) => kontekst.ExitThread();
            Start(kontekst);
            Application.Run(kontekst);
            if (odinstalowano) UsunPoZamknieciu();
            return 0;
        }

        static async void Start(ApplicationContext kontekst)
        {
            try { await okno.Uruchom(); }
            catch (Exception e)
            {
                Dziennik.Zapisz("instalator: okno: " + e);
                // aktualizacja (komputer może być bez obsługi): bez okienek, wraca poprzednia wersja
                if (AKTUALIZACJA && tryb == "instaluj") PrzywrocPoprzednia("okno instalatora się nie otworzyło (" + e.GetType().Name + ")");
                else MessageBox.Show("Nie udało się otworzyć instalatora LivePL Connect.\n\n" + e.Message
                    + "\n\nZaktualizuj system Windows albo zainstaluj „Microsoft Edge WebView2 Runtime” i spróbuj jeszcze raz.",
                    "LivePL Connect", MessageBoxButtons.OK, MessageBoxIcon.Error);
                kontekst.ExitThread();
            }
        }

        // po czasie zamyka okno instalatora (aktualizacja bez obsługi nie czeka na kliknięcie)
        static System.Threading.Timer zegarZamkniecia; // trzymamy odwołanie, inaczej GC mógłby usunąć zegar
        static void ZamknijPo(int ms)
        {
            zegarZamkniecia = new System.Threading.Timer(_ =>
            {
                try { okno.BeginInvoke((Action)(() => { okno.PozwolZamknac = true; okno.Close(); })); } catch { }
            }, null, ms, Timeout.Infinite);
        }

        static object Obsluga(string nazwa, object[] a)
        {
            var opcje = a.Length > 0 ? a[0] as Dictionary<string, object> : null;
            Func<string, bool> opcja = k => { object v; return opcje != null && opcje.TryGetValue(k, out v) && v is bool && (bool)v; };
            switch (nazwa)
            {
                case "instalator:stan":
                    return new Dictionary<string, object> {
                        { "tryb", tryb }, { "aktualizacja", AKTUALIZACJA }, { "uruchomPo", URUCHOM_PO },
                        { "wersja", Program.Wersja }, { "zainstalowana", ZainstalowanaWersja() }, { "cel", CEL },
                        { "test", TEST_CEL != null }, { "dziala", Dzialajace(CEL).Count > 0 }
                    };
                case "instalator:instaluj":
                    var pulpit = opcja("pulpit");
                    return Task.Run(() =>
                    {
                        var w = Instaluj(pulpit);
                        // nieudana aktualizacja: poprzednia wersja (cała, bo podmiana folderów się nie odbyła)
                        // wraca od razu; bez obsługi okno z błędem samo się zamyka
                        if (!(bool)w["ok"] && AKTUALIZACJA)
                        {
                            PrzywrocPoprzednia("instalacja nieudana: " + w["blad"]);
                            if (Program.Ma("--w-tle")) ZamknijPo(20000);
                        }
                        return (object)w;
                    });
                case "instalator:odinstaluj":
                    var dane = opcja("dane");
                    return Task.Run(() =>
                    {
                        var w = Odinstaluj(dane);
                        odinstalowano = (bool)w["ok"];
                        return (object)w;
                    });
                case "instalator:uruchom":
                    // program, który przed aktualizacją był schowany w tle, wraca do tła (komputer bez obsługi)
                    var arg = AKTUALIZACJA && Program.Ma("--w-tle") ? "--autostart" : "";
                    if (File.Exists(EXE))
                    {
                        try { Win.AllowSetForegroundWindow(-1); Uruchamianie.Start(EXE, arg, CEL); } catch (Exception e) { Dziennik.Zapisz("instalator: uruchomienie: " + e.Message); }
                    }
                    okno.PozwolZamknac = true;
                    okno.Close();
                    return null;
                case "instalator:zamknij":
                    okno.PozwolZamknac = true;
                    okno.Close();
                    return null;
            }
            throw new Exception("nieznane wywołanie: " + nazwa);
        }
    }
}
