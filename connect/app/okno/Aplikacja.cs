// LivePL Connect: okno aplikacji. Pokazuje ID i hasło tego komputera i łączy z innym komputerem.
// Pomocnik host.exe trzyma łącze z serwerem pośredniczącym; obraz i sterowanie płyną bezpośrednio
// między komputerami (WebRTC). ID jest trwałe: zapisujemy je w ustawieniach i przy każdym starcie
// prosimy serwer o to samo. Działa tak samo jak wersja z Electronem (te same ustawienia, ten sam plik).

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace LivePL.Connect
{
    static class Aplikacja
    {
        const string DOMYSLNY_SERWER = "wss://connect.livepl.eu:5938/ws";
        const string AKTUALIZACJE = "https://aktualizacje.livepl.eu/connect/";
        const int ITERACJE_HASLA = 300000;
        const string NAZWA_AUTOSTARTU = "LivePL Connect";
        const string KLUCZ_RUN = @"Software\Microsoft\Windows\CurrentVersion\Run";

        static Okno okno;
        static SynchronizationContext ui;
        static Process host;
        static Dictionary<string, object> hostInfo;   // { id, pass } od pomocnika
        static Dictionary<string, object> status = new Dictionary<string, object> { { "stan", "laczenie" } };
        static string plikId;
        static bool konczenie, szybkiRestart;
        static Dictionary<string, object> ustawienia = new Dictionary<string, object>();
        static Dictionary<string, object> aktualizacja;   // { wersja, plik, sha256, opis }
        static bool pobieranie, klikniete;
        static string pobranyPlik;
        static int sesjeHosta;
        static bool sesjaKontrolera;
        static NotifyIcon tray;
        static bool pokazanoInfoTla;
        static readonly bool W_TLE = Program.Ma("--autostart");
        static readonly JavaScriptSerializer json = new JavaScriptSerializer();
        static string daneFolder, daneLokalne;

        static bool Zajety { get { return sesjeHosta > 0 || sesjaKontrolera; } }
        static void Log(string t) { Dziennik.Zapisz(t); }

        // ---------------------------------------------------------------- ustawienia (ten sam plik co w wersji z Electronem)

        static string PlikUstawien { get { return Path.Combine(daneFolder, "ustawienia.json"); } }

        static bool bezZapisu; // pliku ustawień nie dało się przeczytać: nie nadpisujemy go (ID, stałe hasło)

        static void WczytajUstawienia()
        {
            ustawienia = new Dictionary<string, object>();
            if (!File.Exists(PlikUstawien)) return;
            string tekst = null;
            for (int i = 0; i < 5 && tekst == null; i++)
            {
                try { tekst = File.ReadAllText(PlikUstawien, Encoding.UTF8); }
                catch (FileNotFoundException) { return; }
                catch (DirectoryNotFoundException) { return; }
                catch (Exception e) { Log("odczyt ustawień: " + e.Message); Thread.Sleep(300); }
            }
            if (tekst == null)
            {
                // plik jest, ale zablokowany: lepiej działać bez zapisu niż skasować ID i stałe hasło
                bezZapisu = true;
                Log("ustawienia: nie mogę ich przeczytać, nie będę ich nadpisywać");
                return;
            }
            try { ustawienia = json.Deserialize<Dictionary<string, object>>(tekst) ?? new Dictionary<string, object>(); }
            catch (Exception e)
            {
                // uszkodzony plik zostaje obok (do ręcznego odzyskania ID), program startuje z czystymi ustawieniami
                var kopia = PlikUstawien + ".uszkodzony-" + DateTime.Now.ToString("yyyyMMdd-HHmmss");
                try { File.Copy(PlikUstawien, kopia, true); } catch { }
                Log("ustawienia: uszkodzony plik (" + e.Message + "), kopia: " + kopia);
                ustawienia = new Dictionary<string, object>();
            }
        }

        static bool ZapiszUstawienia()
        {
            if (bezZapisu) { Log("zapis ustawień pominięty (plik był nieczytelny)"); return false; }
            try
            {
                Directory.CreateDirectory(daneFolder);
                var tmp = PlikUstawien + ".nowy";
                File.WriteAllText(tmp, json.Serialize(ustawienia), new UTF8Encoding(false));
                if (File.Exists(PlikUstawien)) File.Replace(tmp, PlikUstawien, null); else File.Move(tmp, PlikUstawien);
                return true;
            }
            catch (Exception e) { Log("zapis ustawień: " + e.Message); return false; }
        }

        // Stałe ID: losowy klucz komputera (w ustawieniach) potwierdza serwerowi, że ID jest nasze.
        // Dzięki temu ID nie zmienia się po zerwaniu łącza, a gdy komputer jest wyłączony, nikt inny go nie zajmie.
        // Każdy serwer dostaje inny klucz (HMAC z nazwą serwera), więc obcy serwer nie pozna klucza do livepl.eu.
        static string KluczIdDla(string serwer)
        {
            var glowny = Tekst("kluczId");
            if (glowny == null || !Regex.IsMatch(glowny, "^[0-9a-f]{64}$"))
            {
                var b = new byte[32];
                using (var los = RandomNumberGenerator.Create()) los.GetBytes(b);
                ustawienia["kluczId"] = Hex(b);
                // klucz, którego nie da się zapisać, zmieniałby ID przy każdym starcie: wtedy działamy jak dawniej
                if (!ZapiszUstawienia()) { ustawienia.Remove("kluczId"); return null; }
                glowny = Tekst("kluczId");
                Log("ID: nowy klucz komputera");
            }
            string nazwa;
            try { nazwa = new Uri(serwer).Host.ToLowerInvariant(); } catch { nazwa = serwer.ToLowerInvariant(); }
            using (var h = new HMACSHA256(Encoding.ASCII.GetBytes(glowny)))
                return Hex(h.ComputeHash(Encoding.UTF8.GetBytes("livepl-connect-id|" + nazwa)));
        }

        // Nowe ID na życzenie: nowy klucz i brak starego ID. Stare ID zostaje na serwerze przy starym kluczu,
        // którego już nikt nie ma, więc nikt inny go nie dostanie (wygasa po roku).
        static Dictionary<string, object> NoweId()
        {
            var stareId = ustawienia.ContainsKey("id") ? ustawienia["id"] : null;
            var staryKlucz = ustawienia.ContainsKey("kluczId") ? ustawienia["kluczId"] : null;
            ustawienia.Remove("id");
            ustawienia.Remove("kluczId");
            if (!ZapiszUstawienia())
            {
                if (stareId != null) ustawienia["id"] = stareId;
                if (staryKlucz != null) ustawienia["kluczId"] = staryKlucz;
                return new Dictionary<string, object> { { "ok", false }, { "blad", "Nie mogę zapisać ustawień, więc ID zostaje bez zmian." } };
            }
            Log("ID: nowe na życzenie");
            hostInfo = null;
            UstawStatus("laczenie");
            RestartHosta();
            return new Dictionary<string, object> { { "ok", true } };
        }

        static string Tekst(string klucz) { object v; return ustawienia.TryGetValue(klucz, out v) && v != null ? Convert.ToString(v) : null; }

        static string Serwer
        {
            get
            {
                var e = Environment.GetEnvironmentVariable("CONNECT_SERVER");
                if (!string.IsNullOrEmpty(e)) return e;
                var s = Tekst("serwer");
                return string.IsNullOrEmpty(s) ? DOMYSLNY_SERWER : s;
            }
        }

        static Dictionary<string, object> StaleHaslo { get { object v; return ustawienia.TryGetValue("staleHaslo", out v) ? v as Dictionary<string, object> : null; } }
        static bool DostepBezObslugi { get { var h = StaleHaslo; object s; return h != null && h.TryGetValue("skrot", out s) && !string.IsNullOrEmpty(Convert.ToString(s)); } }
        static bool Autostart { get { object v; return ustawienia.TryGetValue("autostart", out v) && v is bool && (bool)v; } }

        // ---------------------------------------------------------------- stan dla okna

        static Dictionary<string, object> StanPubliczny()
        {
            return new Dictionary<string, object> {
                { "stan", status["stan"] },
                { "komunikat", status.ContainsKey("komunikat") ? status["komunikat"] : "" },
                { "id", hostInfo != null ? hostInfo["id"] : null },
                { "haslo", hostInfo != null ? hostInfo["pass"] : null }
            };
        }

        static void UstawStatus(string stan, string komunikat = null)
        {
            status = new Dictionary<string, object> { { "stan", stan } };
            if (komunikat != null) status["komunikat"] = komunikat;
            if (okno != null) okno.Wyslij("status", StanPubliczny());
        }

        static Dictionary<string, object> StanDostepu()
        {
            return new Dictionary<string, object> { { "staleHaslo", DostepBezObslugi }, { "autostart", Autostart }, { "dev", Program.Dev } };
        }

        // z wątków w tle na wątek okna; po zamknięciu programu cicho nic nie robi
        static void NaUI(Action a)
        {
            if (konczenie && okno == null) return;
            try { ui.Post(_ => { try { a(); } catch (Exception e) { Log("ui: " + e); } }, null); }
            catch { /* pętla okna już się skończyła */ }
        }

        // ---------------------------------------------------------------- pomocnik host.exe

        static string SciezkaHosta { get { return Path.Combine(Program.Folder, "host.exe"); } }

        static void UruchomHosta()
        {
            var exe = SciezkaHosta;
            if (!File.Exists(exe))
            {
                UstawStatus("blad", "Brakuje pliku host.exe. Zainstaluj LivePL Connect ponownie.");
                return;
            }
            plikId = Path.Combine(Path.GetTempPath(), "livepl-connect-" + Process.GetCurrentProcess().Id + ".json");
            try { File.Delete(plikId); } catch { }
            hostInfo = null;
            UstawStatus("laczenie");

            var argumenty = new List<string> { "-server", Serwer, "-idfile", plikId };
            var id = Tekst("id");
            if (id != null && Regex.IsMatch(id, @"^\d{9}$")) { argumenty.Add("-id"); argumenty.Add(id); }
            Log("host: start " + string.Join(" ", argumenty));

            var p = new ProcessStartInfo(exe, string.Join(" ", argumenty.ConvertAll(Uruchamianie.Cudzyslow)))
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                // poza folderem programu, żeby działający pomocnik nie blokował podmiany folderu przy aktualizacji
                WorkingDirectory = Path.GetTempPath()
            };
            // skrót stałego hasła idzie do pomocnika zmienną środowiskową (nie w wierszu poleceń, który widać na liście procesów)
            p.EnvironmentVariables.Remove("LPC_STALE_HASLO");
            if (DostepBezObslugi)
            {
                var h = StaleHaslo;
                p.EnvironmentVariables["LPC_STALE_HASLO"] = string.Join("$", new[] { "pbkdf2-sha256", Convert.ToString(h["iteracje"]), Convert.ToString(h["sol"]), Convert.ToString(h["skrot"]) });
            }
            // klucz, którym serwer rozpoznaje, że to ID należy do tego komputera (też w zmiennej, nie w wierszu poleceń)
            p.EnvironmentVariables.Remove("LPC_KLUCZ_ID");
            var kluczId = KluczIdDla(Serwer);
            if (kluczId != null) p.EnvironmentVariables["LPC_KLUCZ_ID"] = kluczId;
            // obsługa zdarzeń przed startem: pomocnik, który od razu się kończy, też zostanie uruchomiony ponownie
            var ten = new Process { StartInfo = p, EnableRaisingEvents = true };
            ten.OutputDataReceived += (o, e) =>
            {
                if (e.Data == null) return;
                var t = e.Data;
                NaUI(() =>
                {
                    if (t.Contains("STATUS online") && hostInfo != null) UstawStatus("online");
                    if (t.Contains("STATUS offline")) UstawStatus("laczenie");
                    var s = Regex.Match(t, @"SESSIONS (\d+)");
                    if (s.Success)
                    {
                        sesjeHosta = int.Parse(s.Groups[1].Value);
                        Log("host: połączonych osób " + sesjeHosta);
                        if (sesjeHosta == 0) Opoznij(30000, ProbujZainstalowac);
                    }
                });
            };
            ten.ErrorDataReceived += (o, e) => { if (!string.IsNullOrEmpty(e.Data)) Log("host: " + e.Data.Trim()); };
            ten.Exited += (o, e) => NaUI(() =>
            {
                int kod = -1;
                try { kod = ten.ExitCode; } catch { }
                Log("host: koniec " + kod);
                if (host == ten) { host = null; sesjeHosta = 0; }
                if (konczenie) return;
                var zaraz = szybkiRestart;
                szybkiRestart = false;
                Restart(zaraz ? 800 : 3000, ten);
            });
            host = ten;
            try { ten.Start(); }
            catch (Exception e)
            {
                host = null;
                Log("host: błąd uruchomienia " + e.Message);
                UstawStatus("blad", "Nie mogę uruchomić pomocnika host.exe.");
                Restart(3000, null);
                return;
            }
            Win.DolaczDoZadania(ten.Handle);
            ten.BeginOutputReadLine();
            ten.BeginErrorReadLine();

            // serwer długo milczy: mówimy to wprost (pomocnik i tak próbuje dalej)
            Opoznij(15000, () =>
            {
                if (host == ten && hostInfo == null) UstawStatus("blad", "Nie mogę połączyć się z serwerem. Sprawdzam dalej…");
            });
        }

        static void Restart(int ms, Process poprzedni)
        {
            Opoznij(ms, () => { if (!konczenie && host == null) UruchomHosta(); });
        }

        static void ZatrzymajHosta()
        {
            try { if (host != null && !host.HasExited) host.Kill(); } catch { }
        }

        // pomocnik startuje od nowa (nowe ustawienia), ID zostaje to samo
        static void RestartHosta()
        {
            szybkiRestart = true;
            if (host != null) ZatrzymajHosta(); else UruchomHosta();
        }

        // pomocnik zapisuje ID i hasło do małego pliku; czytamy go co 400 ms
        static void ObserwujPlikId()
        {
            var t = new System.Windows.Forms.Timer { Interval = 400 };
            t.Tick += (o, e) =>
            {
                if (plikId == null) return;
                Dictionary<string, object> j;
                try { j = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(plikId)); } catch { return; }
                if (j == null || !j.ContainsKey("id") || !j.ContainsKey("pass")) return;
                var id = Convert.ToString(j["id"]);
                var pass = Convert.ToString(j["pass"]);
                if (!Regex.IsMatch(id, @"^\d{9}$") || string.IsNullOrEmpty(pass)) return;
                if (hostInfo != null && (string)hostInfo["id"] == id && (string)hostInfo["pass"] == pass) return;
                hostInfo = new Dictionary<string, object> { { "id", id }, { "pass", pass } };
                Log("host: gotowy, ID " + id);
                if (Tekst("id") != id) { ustawienia["id"] = id; ZapiszUstawienia(); }
                UstawStatus("online");
                OdswiezTray();
            };
            t.Start();
        }

        // ---------------------------------------------------------------- dostęp bez obsługi

        static Dictionary<string, object> UstawStaleHaslo(string h)
        {
            Func<string, Dictionary<string, object>> zle = b => new Dictionary<string, object> { { "ok", false }, { "blad", b } };
            if (h.Length < 8) return zle("Stałe hasło musi mieć co najmniej 8 znaków.");
            if (h.Length > 64) return zle("Stałe hasło może mieć najwyżej 64 znaki.");
            if (Regex.IsMatch(h, @"^\d+$") && h.Length < 10) return zle("Same cyfry łatwo zgadnąć: dodaj litery albo użyj co najmniej 10 cyfr.");
            if (Regex.IsMatch(h, @"^\s|\s$")) return zle("Hasło nie może zaczynać się ani kończyć spacją.");
            var sol = new byte[16];
            using (var los = RandomNumberGenerator.Create()) los.GetBytes(sol);
            byte[] skrot;
            using (var k = new Rfc2898DeriveBytes(Encoding.UTF8.GetBytes(h), sol, ITERACJE_HASLA, HashAlgorithmName.SHA256)) skrot = k.GetBytes(32);
            ustawienia["staleHaslo"] = new Dictionary<string, object> {
                { "iteracje", ITERACJE_HASLA }, { "sol", Hex(sol) }, { "skrot", Hex(skrot) },
                { "ustawiono", DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ") }
            };
            // bez startu z Windows stałe hasło nie przetrwa ponownego uruchomienia komputera
            if (!ustawienia.ContainsKey("autostart")) ustawienia["autostart"] = true;
            ZapiszUstawienia();
            ZastosujAutostart();
            RestartHosta();
            Log("stałe hasło: ustawione");
            var w = StanDostepu(); w["ok"] = true;
            return w;
        }

        static string Hex(byte[] b)
        {
            var sb = new StringBuilder(b.Length * 2);
            foreach (var x in b) sb.Append(x.ToString("x2"));
            return sb.ToString();
        }

        static Dictionary<string, object> UsunStaleHaslo()
        {
            ustawienia.Remove("staleHaslo");
            ZapiszUstawienia();
            RestartHosta();
            PokazOkno();
            if (tray != null) { tray.Visible = false; tray.Dispose(); tray = null; }
            Log("stałe hasło: usunięte");
            var w = StanDostepu(); w["ok"] = true;
            return w;
        }

        // ten sam wpis co w wersji z Electronem: HKCU\...\Run, „LivePL Connect” = "<program>" --autostart
        static void ZastosujAutostart()
        {
            if (Program.Dev) return; // wersja deweloperska nie wpisuje się do autostartu
            try
            {
                using (var k = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(KLUCZ_RUN))
                {
                    if (Autostart) k.SetValue(NAZWA_AUTOSTARTU, "\"" + Application.ExecutablePath + "\" --autostart");
                    else if (k.GetValue(NAZWA_AUTOSTARTU) != null) k.DeleteValue(NAZWA_AUTOSTARTU, false);
                }
                // jak Electron: włączony start z Windows usuwa wyłączenie z Menedżera zadań (inaczej okno
                // pokazywałoby „włączony”, a Windows i tak by go nie uruchamiał)
                if (Autostart)
                {
                    using (var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run", true))
                        if (k != null && k.GetValue(NAZWA_AUTOSTARTU) != null) k.DeleteValue(NAZWA_AUTOSTARTU, false);
                }
            }
            catch (Exception e) { Log("autostart: " + e.Message); }
        }

        static Dictionary<string, object> UstawAutostart(bool wl)
        {
            ustawienia["autostart"] = wl;
            ZapiszUstawienia();
            ZastosujAutostart();
            return StanDostepu();
        }

        static void PokazOkno()
        {
            if (okno == null || okno.IsDisposed) return;
            if (!okno.Visible) okno.Show();
            if (okno.Zminimalizowane) okno.Przywroc();
            okno.Activate();
            Win.SetForegroundWindow(okno.Handle);
        }

        static void UtworzTray()
        {
            if (tray != null) return;
            tray = new NotifyIcon { Text = "LivePL Connect", Visible = true };
            try { tray.Icon = new Icon(Path.Combine(Program.Folder, "assets", "icon.ico"), SystemInformation.SmallIconSize); } catch { tray.Icon = okno != null ? okno.Icon : null; }
            var menu = new ContextMenu();
            menu.MenuItems.Add("Otwórz LivePL Connect", (o, e) => PokazOkno());
            menu.MenuItems.Add("-");
            menu.MenuItems.Add("Zakończ (komputer przestanie być dostępny)", (o, e) => Zakoncz());
            tray.ContextMenu = menu;
            tray.MouseClick += (o, e) => { if (e.Button == MouseButtons.Left) PokazOkno(); };
            tray.DoubleClick += (o, e) => PokazOkno();
        }

        static void OdswiezTray()
        {
            if (tray == null) return;
            var t = "LivePL Connect" + (hostInfo != null ? " · ID " + Regex.Replace((string)hostInfo["id"], @"(\d{3})(?=\d)", "$1 ") : "") + (DostepBezObslugi ? " · dostęp bez obsługi" : "");
            tray.Text = t.Length > 63 ? t.Substring(0, 63) : t;
        }

        // zamknięcie okna przy dostępie bez obsługi chowa je do ikony przy zegarze; komputer dalej czeka na połączenia
        static void SchowajDoTla()
        {
            UtworzTray();
            OdswiezTray();
            okno.Hide();
            if (!pokazanoInfoTla && !W_TLE)
            {
                pokazanoInfoTla = true;
                tray.ShowBalloonTip(8000, "LivePL Connect działa w tle", "Ten komputer jest dostępny po ID i stałym haśle. Ikona LivePL Connect jest przy zegarze.", ToolTipIcon.Info);
            }
        }

        static void Zakoncz()
        {
            konczenie = true;
            ZatrzymajHosta();
            try { if (plikId != null) File.Delete(plikId); } catch { }
            if (tray != null) { tray.Visible = false; tray.Dispose(); tray = null; }
            if (okno != null && !okno.IsDisposed) { okno.PozwolZamknac = true; okno.Close(); }
            Application.ExitThread();
        }

        // ---------------------------------------------------------------- aktualizacje (te same pliki na serwerze)

        static int Porownaj(string a, string b)
        {
            var x = (a ?? "").Split('.'); var y = (b ?? "").Split('.');
            for (int i = 0; i < 3; i++)
            {
                int p = 0, q = 0;
                if (i < x.Length) int.TryParse(x[i], out p);
                if (i < y.Length) int.TryParse(y[i], out q);
                if (p != q) return p - q;
            }
            return 0;
        }

        static Dictionary<string, object> Polacz(Dictionary<string, object> a, Dictionary<string, object> b)
        {
            var w = new Dictionary<string, object>(a);
            if (b != null) foreach (var k in b) w[k.Key] = k.Value;
            return w;
        }

        static void WyslijAkt(string stan, Dictionary<string, object> dodatki = null)
        {
            var d = new Dictionary<string, object> { { "stan", stan } };
            if (dodatki != null) foreach (var k in dodatki) d[k.Key] = k.Value;
            if (okno != null) okno.Wyslij("aktualizacja", d);
        }

        static HttpWebRequest Zapytanie(string adres)
        {
            var r = (HttpWebRequest)WebRequest.Create(adres);
            r.UserAgent = "LivePL-Connect/" + Program.Wersja;
            r.CachePolicy = new System.Net.Cache.RequestCachePolicy(System.Net.Cache.RequestCacheLevel.NoCacheNoStore);
            r.Timeout = 30000;
            r.ReadWriteTimeout = 60000;
            return r;
        }

        // Timeout i ReadWriteTimeout nie działają dla zapytań asynchronicznych: zawieszony serwer
        // trzymałby pobieranie w nieskończoność. Po czasie przerywamy zapytanie sami.
        static async Task<T> ZCzasem<T>(Task<T> zadanie, int ms, HttpWebRequest zapytanie)
        {
            if (await Task.WhenAny(zadanie, Task.Delay(ms)) != zadanie)
            {
                try { zapytanie.Abort(); } catch { }
                var _ = zadanie.ContinueWith(t => { var x = t.Exception; }, TaskContinuationOptions.OnlyOnFaulted);
                throw new TimeoutException("serwer aktualizacji nie odpowiada");
            }
            return await zadanie;
        }

        static async Task SprawdzAktualizacje(bool reczne)
        {
            if (Program.Dev)
            {
                if (reczne) WyslijAkt("dev", new Dictionary<string, object> { { "komunikat", "Aktualizacje działają w zainstalowanej wersji." } });
                return;
            }
            if (pobieranie) return;
            try
            {
                if (reczne) WyslijAkt("sprawdzam");
                string tekst;
                var zap = Zapytanie(AKTUALIZACJE + "wersja.json?t=" + DateTime.UtcNow.Ticks);
                using (var odp = (HttpWebResponse)await ZCzasem(zap.GetResponseAsync(), 30000, zap))
                using (var r = new StreamReader(odp.GetResponseStream(), Encoding.UTF8)) tekst = await ZCzasem(r.ReadToEndAsync(), 30000, zap);
                var w = json.Deserialize<Dictionary<string, object>>(tekst);
                object wer, plik;
                if (w != null && w.TryGetValue("wersja", out wer) && w.TryGetValue("plik", out plik) && Porownaj(Convert.ToString(wer), Program.Wersja) > 0)
                {
                    object sha, opis;
                    w.TryGetValue("sha256", out sha); w.TryGetValue("opis", out opis);
                    var nowa = new Dictionary<string, object> {
                        { "wersja", Convert.ToString(wer) }, { "plik", Convert.ToString(plik) },
                        { "sha256", Convert.ToString(sha ?? "") }, { "opis", Convert.ToString(opis ?? "") }
                    };
                    if (aktualizacja == null || (string)aktualizacja["wersja"] != (string)nowa["wersja"] || (string)aktualizacja["sha256"] != (string)nowa["sha256"]) pobranyPlik = null;
                    aktualizacja = nowa;
                    WyslijAkt("dostepna", aktualizacja);
                    if (!reczne && Nieudana.Niedawno((string)nowa["wersja"]))
                        Log("aktualizacja " + nowa["wersja"] + " niedawno się nie udała: następna próba sama za kilka godzin");
                    else if (!reczne) await PobierzIZainstaluj(true);
                }
                else if (reczne) WyslijAkt("aktualna");
            }
            catch (Exception e)
            {
                Log("aktualizacje: " + e.Message);
                if (reczne) WyslijAkt("blad", new Dictionary<string, object> { { "komunikat", "Nie udało się sprawdzić aktualizacji." } });
            }
        }

        // automat = sama z siebie (w tle); inaczej użytkownik kliknął „Aktualizuj” i instalujemy od razu
        static async Task PobierzIZainstaluj(bool automat)
        {
            if (aktualizacja == null) return;
            if (pobieranie) { if (!automat) klikniete = true; return; }
            klikniete = !automat;
            if (pobranyPlik != null && File.Exists(pobranyPlik))
            {
                if (automat) ProbujZainstalowac(); else Zainstaluj(pobranyPlik, aktualizacja);
                return;
            }
            pobieranie = true;
            var a = aktualizacja;
            var nazwa = Path.GetFileName((string)a["plik"]);
            var cel = Path.Combine(Path.GetTempPath(), nazwa);
            try
            {
                WyslijAkt("pobieram", Polacz(a, new Dictionary<string, object> { { "postep", 0 } }));
                var zap = Zapytanie(AKTUALIZACJE + Uri.EscapeDataString(nazwa));
                using (var odp = (HttpWebResponse)await ZCzasem(zap.GetResponseAsync(), 30000, zap))
                using (var zrodlo = odp.GetResponseStream())
                using (var plik = new FileStream(cel, FileMode.Create, FileAccess.Write, FileShare.None))
                using (var skrot = SHA256.Create())
                {
                    long razem = odp.ContentLength, mam = 0;
                    var bufor = new byte[81920];
                    var ostatnio = Environment.TickCount;
                    int n;
                    while ((n = await ZCzasem(zrodlo.ReadAsync(bufor, 0, bufor.Length), 60000, zap)) > 0)
                    {
                        skrot.TransformBlock(bufor, 0, n, null, 0);
                        await plik.WriteAsync(bufor, 0, n);
                        mam += n;
                        if (razem > 0 && Environment.TickCount - ostatnio > 120)
                        {
                            ostatnio = Environment.TickCount;
                            WyslijAkt("pobieram", Polacz(a, new Dictionary<string, object> { { "postep", (double)mam / razem } }));
                        }
                    }
                    skrot.TransformFinalBlock(bufor, 0, 0);
                    var sha = (string)a["sha256"];
                    if (string.IsNullOrEmpty(sha) || !string.Equals(Hex(skrot.Hash), sha, StringComparison.OrdinalIgnoreCase))
                        throw new Exception("suma kontrolna się nie zgadza");
                }
                var podpis = Podpis.Sprawdz(cel);
                if (podpis != null) throw new Exception("podpis instalatora: " + podpis);
                pobieranie = false;
                pobranyPlik = cel;
                Log("aktualizacja " + a["wersja"] + " pobrana" + (klikniete ? "" : " (w tle)"));
                if (!klikniete)
                {
                    WyslijAkt("dostepna", a);
                    ProbujZainstalowac();
                }
                else Zainstaluj(cel, a);
            }
            catch (Exception e)
            {
                Log("pobieranie aktualizacji: " + e.Message);
                try { File.Delete(cel); } catch { }
                pobieranie = false;
                WyslijAkt(klikniete ? "blad" : "dostepna", Polacz(a, new Dictionary<string, object> { { "komunikat", "Nie udało się pobrać aktualizacji." } }));
            }
        }

        static bool instaluje; // instalator już uruchomiony (program zaraz się zamknie)

        static void Zainstaluj(string plik, Dictionary<string, object> a)
        {
            if (instaluje) return;
            // plik w folderze tymczasowym mógł się zmienić od pobrania: podpis sprawdzamy jeszcze raz
            var podpis = Podpis.Sprawdz(plik);
            if (podpis != null)
            {
                Log("aktualizacja odrzucona, podpis instalatora: " + podpis);
                try { File.Delete(plik); } catch { }
                pobranyPlik = null;
                WyslijAkt("blad", Polacz(a, new Dictionary<string, object> { { "komunikat", "Pobrana aktualizacja nie ma ważnego podpisu Live Production." } }));
                return;
            }
            instaluje = true;
            Log("instaluję aktualizację " + a["wersja"]);
            WyslijAkt("instaluje", a);
            // program schowany w tle wraca po aktualizacji też do tła (komputer bez obsługi)
            var wTle = okno != null && !okno.IsDisposed && !okno.Visible;
            try
            {
                Win.AllowSetForegroundWindow(-1);
                Uruchamianie.Start(plik, "--aktualizuj" + (wTle ? " --w-tle" : ""), Path.GetTempPath());
            }
            catch (Exception e)
            {
                instaluje = false;
                Log("uruchomienie aktualizacji: " + e.Message);
                WyslijAkt("blad", Polacz(a, new Dictionary<string, object> { { "komunikat", "Nie udało się uruchomić aktualizacji." } }));
                return;
            }
            Opoznij(700, Zakoncz);
        }

        // pobrana aktualizacja instaluje się sama, gdy nikt nie jest połączony
        // i nikt właśnie nie korzysta z okna (wtedy czekamy na następną próbę)
        static void ProbujZainstalowac()
        {
            if (pobranyPlik == null || aktualizacja == null || konczenie || !File.Exists(pobranyPlik)) return;
            if (Zajety) { Log("aktualizacja czeka: trwa połączenie"); return; }
            if (okno != null && !okno.IsDisposed && okno.Visible && okno.ContainsFocus && Form.ActiveForm == okno && !okno.Zminimalizowane)
            {
                Log("aktualizacja czeka: okno jest w użyciu");
                return;
            }
            Zainstaluj(pobranyPlik, aktualizacja);
        }

        // ---------------------------------------------------------------- pomocnicze

        static void Opoznij(int ms, Action a)
        {
            var t = new System.Windows.Forms.Timer { Interval = Math.Max(1, ms) };
            t.Tick += (o, e) => { t.Stop(); t.Dispose(); try { a(); } catch (Exception ex) { Log("czas: " + ex); } };
            t.Start();
        }

        static void Co(int ms, Action a)
        {
            var t = new System.Windows.Forms.Timer { Interval = ms };
            t.Tick += (o, e) => { try { a(); } catch (Exception ex) { Log("czas: " + ex); } };
            t.Start();
        }

        static async void Bez(Task t) { try { await t; } catch (Exception e) { Log("zadanie: " + e); } }

        // ---------------------------------------------------------------- dane z wersji z Electronem

        // Lista ostatnich połączeń leżała w Local Storage Electrona (ten sam Chromium). Kopiujemy ją
        // jednorazowo do profilu WebView2; strona ma ten sam adres (file://), więc widzi te same dane.
        static void PrzeniesDaneElectrona(string profil)
        {
            try
            {
                var stare = Path.Combine(daneFolder, "Local Storage");
                var nowe = Path.Combine(profil, "EBWebView", "Default", "Local Storage");
                if (!Directory.Exists(Path.Combine(stare, "leveldb")) || Directory.Exists(nowe)) return;
                Kopiuj(stare, nowe);
                Log("przeniesiono listę ostatnich połączeń z wersji z Electronem");
            }
            catch (Exception e) { Log("przenoszenie danych Electrona: " + e.Message); }
        }

        static void Kopiuj(string z, string doF)
        {
            Directory.CreateDirectory(doF);
            foreach (var f in Directory.GetFiles(z))
            {
                if (Path.GetFileName(f).Equals("LOCK", StringComparison.OrdinalIgnoreCase)) continue;
                File.Copy(f, Path.Combine(doF, Path.GetFileName(f)), true);
            }
            foreach (var d in Directory.GetDirectories(z)) Kopiuj(d, Path.Combine(doF, Path.GetFileName(d)));
        }

        // pamięć podręczna Electrona (nieużywana od tej wersji) zajmuje miejsce w %APPDATA%
        static void SprzatnijPoElectronie()
        {
            foreach (var n in new[] { "Cache", "Code Cache", "GPUCache", "DawnCache", "DawnGraphiteCache", "DawnWebGPUCache", "Crashpad", "blob_storage", "Shared Dictionary" })
            {
                try { var d = Path.Combine(daneFolder, n); if (Directory.Exists(d)) Directory.Delete(d, true); } catch { }
            }
        }

        // ---------------------------------------------------------------- start

        public static int Uruchom()
        {
            // LPC_DANE: osobny folder ustawień (testy), żeby nie ruszać prawdziwego ID i hasła
            var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            var dane = Environment.GetEnvironmentVariable("LPC_DANE");
            daneFolder = !string.IsNullOrEmpty(dane) ? dane : Path.Combine(appData, "LivePL Connect");
            daneLokalne = !string.IsNullOrEmpty(dane) ? Path.Combine(dane, "lokalne")
                : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LivePL Connect");

            bool pierwszy;
            var muteks = new Mutex(true, @"Local\eu.livepl.connect.aplikacja" + (string.IsNullOrEmpty(dane) ? "" : "." + dane.GetHashCode().ToString("x")), out pierwszy);
            var pokaz = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\eu.livepl.connect.pokaz" + (string.IsNullOrEmpty(dane) ? "" : "." + dane.GetHashCode().ToString("x")));
            if (!pierwszy)
            {
                pokaz.Set(); // drugi start: pokaż okno działającego programu
                return 0;
            }

            WindowsFormsSynchronizationContext.AutoInstall = true;
            var kontekst = new ApplicationContext();
            WczytajUstawienia();
            ZastosujAutostart(); // po przeniesieniu lub reinstalacji wpis wskazuje aktualny program
            var profil = Path.Combine(daneLokalne, "WebView2");
            PrzeniesDaneElectrona(profil);

            okno = new Okno(Path.Combine(Program.Folder, "ui", "index.html"), "lpc", "LivePL Connect",
                new Size(960, 640), new Size(840, 580), true, profil, Program.Dev);
            okno.Obsluga = Obsluga;
            okno.Zamykanie += () =>
            {
                if (!konczenie && DostepBezObslugi) { SchowajDoTla(); return true; }
                return false;
            };
            okno.FormClosed += (o, e) => { if (!konczenie) Zakoncz(); };
            okno.Gotowe += () =>
            {
                // start z Windows: przy dostępie bez obsługi od razu w tle, inaczej zminimalizowany
                if (W_TLE && DostepBezObslugi) SchowajDoTla();
                else if (W_TLE) okno.PokazZminimalizowane();
                else { okno.Show(); okno.Activate(); }
                Opoznij(20000, SprzatnijPoElectronie);
            };
            var uchwyt = okno.Handle; // okno powstaje od razu, a pokazujemy je po wczytaniu strony
            okno.Wysrodkuj();
            ui = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();

            new Thread(() =>
            {
                while (pokaz.WaitOne()) NaUI(PokazOkno);
            }) { IsBackground = true }.Start();

            if (DostepBezObslugi) UtworzTray();
            Bez(UruchomOkno());
            ObserwujPlikId();
            UruchomHosta();
            // nowa wersja na serwerze dociera do wszystkich komputerów w ciągu godziny
            Opoznij(4000, () => Bez(SprawdzAktualizacje(false)));
            Co(3600 * 1000, () => Bez(SprawdzAktualizacje(false)));
            Co(5 * 60 * 1000, ProbujZainstalowac);

            Application.Run(kontekst);
            konczenie = true;
            ZatrzymajHosta();
            GC.KeepAlive(muteks);
            return 0;
        }

        static async Task UruchomOkno()
        {
            try { await okno.Uruchom(); }
            catch (Exception e)
            {
                Log("okno: " + e);
                // Komputer bez obsługi zostaje dostępny: pomocnik i ikona przy zegarze działają dalej bez okna.
                if (DostepBezObslugi)
                {
                    UtworzTray();
                    OdswiezTray();
                    tray.ShowBalloonTip(15000, "LivePL Connect działa bez okna",
                        "Okno nie mogło się otworzyć (składnik Microsoft WebView2). Ten komputer jest dalej dostępny po ID i stałym haśle.", ToolTipIcon.Warning);
                    return;
                }
                MessageBox.Show("Nie udało się otworzyć okna LivePL Connect.\n\n" + e.Message
                    + "\n\nZaktualizuj system Windows albo zainstaluj „Microsoft Edge WebView2 Runtime” i uruchom LivePL Connect ponownie.",
                    "LivePL Connect", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Zakoncz();
            }
        }

        static object Obsluga(string nazwa, object[] a)
        {
            switch (nazwa)
            {
                case "stan":
                    var s = StanPubliczny();
                    s["wersja"] = Program.Wersja;
                    s["serwer"] = Serwer;
                    s["domyslnySerwer"] = DOMYSLNY_SERWER;
                    s["aktualizacja"] = aktualizacja;
                    foreach (var k in StanDostepu()) s[k.Key] = k.Value;
                    return s;
                case "stale-haslo": return UstawStaleHaslo(a.Length > 0 ? Convert.ToString(a[0]) : "");
                case "stale-haslo-usun": return UsunStaleHaslo();
                case "autostart": return UstawAutostart(a.Length > 0 && a[0] is bool && (bool)a[0]);
                case "kopiuj":
                    Clipboard.SetText(a.Length > 0 && !string.IsNullOrEmpty(Convert.ToString(a[0])) ? Convert.ToString(a[0]) : " ");
                    return true;
                case "nowe-id": return NoweId();
                case "nowe-haslo":
                    if (host == null) { UruchomHosta(); return null; }
                    szybkiRestart = true;
                    hostInfo = null;
                    UstawStatus("laczenie");
                    ZatrzymajHosta();
                    return null;
                case "ustaw-serwer":
                    var adres = (a.Length > 0 ? Convert.ToString(a[0]) : "").Trim();
                    if (adres.Length > 0 && !Regex.IsMatch(adres, @"^wss?://[^\s/]+", RegexOptions.IgnoreCase))
                        return new Dictionary<string, object> { { "ok", false }, { "blad", "Adres musi zaczynać się od wss:// albo ws://" } };
                    if (adres.Length > 0 && adres != DOMYSLNY_SERWER) ustawienia["serwer"] = adres; else ustawienia.Remove("serwer");
                    ZapiszUstawienia();
                    RestartHosta();
                    return new Dictionary<string, object> { { "ok", true }, { "serwer", Serwer } };
                case "sprawdz-aktualizacje": return SprawdzAktualizacje(true);
                case "aktualizuj": return PobierzIZainstaluj(false);
                case "sesja":
                    sesjaKontrolera = a.Length > 0 && a[0] is bool && (bool)a[0];
                    if (!sesjaKontrolera) Opoznij(30000, ProbujZainstalowac);
                    return null;
            }
            throw new Exception("nieznane wywołanie: " + nazwa);
        }
    }
}
