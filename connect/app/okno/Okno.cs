// LivePL Connect: okno bez ramki Windows z WebView2 (silnik Edge wbudowany w Windows), które pokazuje
// te same strony co wcześniej Electron (ui\index.html, ui\instalator.html) i rozmawia z nimi przez most.js.

using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace LivePL.Connect
{
    // wywołanie ze strony: nazwa i argumenty; wynik (albo Task z wynikiem) wraca do strony
    delegate object Obsluga(string nazwa, object[] argumenty);

    class Okno : Form
    {
        readonly string strona;
        readonly string rodzaj;
        readonly bool zmienny;
        readonly Size rozmiar, minimum;
        readonly string daneWebView;
        readonly bool dev;
        public Obsluga Obsluga;
        public event Action Gotowe;          // strona wczytana (pierwszy raz)
        public event Action ZmianaStanu;     // maksymalizacja, przywrócenie, pełny ekran

        readonly WebView2 widok = new WebView2();
        readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 };
        bool gotowe;
        bool pelny;
        FormWindowState stanPrzedPelnym;
        Rectangle granicePrzedPelnym;
        public bool PozwolZamknac;           // false: zamknięcie zgłasza Zamykanie, które może je zatrzymać
        public event Func<bool> Zamykanie;   // true = zostaw okno (np. schowaj do ikony przy zegarze)

        public static bool Ciemny()
        {
            try
            {
                using (var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"))
                {
                    var v = k == null ? null : k.GetValue("AppsUseLightTheme");
                    return v is int && (int)v == 0;
                }
            }
            catch { return false; }
        }

        public Okno(string strona, string rodzaj, string tytul, Size rozmiar, Size minimum, bool zmienny, string daneWebView, bool dev)
        {
            this.strona = strona;
            this.rodzaj = rodzaj;
            this.zmienny = zmienny;
            this.rozmiar = rozmiar;
            this.minimum = minimum;
            this.daneWebView = daneWebView;
            this.dev = dev;

            Text = tytul;
            AutoScaleMode = AutoScaleMode.None;
            FormBorderStyle = zmienny ? FormBorderStyle.Sizable : FormBorderStyle.FixedSingle;
            MaximizeBox = zmienny;
            MinimizeBox = true;
            StartPosition = FormStartPosition.Manual;
            var tlo = Ciemny() ? Color.FromArgb(0x16, 0x19, 0x1e) : Color.White;
            BackColor = tlo;
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            widok.Dock = DockStyle.Fill;
            widok.DefaultBackgroundColor = tlo;
            Controls.Add(widok);
        }

        // ---------------------------------------------------------------- start

        public async Task Uruchom()
        {
            var opcje = new CoreWebView2EnvironmentOptions();
            try { opcje.AreBrowserExtensionsEnabled = false; } catch { }
            var srodowisko = await CoreWebView2Environment.CreateAsync(null, daneWebView, opcje);
            var uchwyt = widok.Handle; // okno bywa jeszcze ukryte (start w tle), a WebView2 potrzebuje uchwytu
            await widok.EnsureCoreWebView2Async(srodowisko);
            var w = widok.CoreWebView2;
            var u = w.Settings;
            // Każde ustawienie osobno: starszy WebView2 (komputer bez aktualizacji) nie zna nowszych ustawień
            // i rzuca wyjątek. Wtedy program działa dalej, tylko bez tego jednego ustawienia.
            Ustaw("AreDevToolsEnabled", () => u.AreDevToolsEnabled = dev);
            Ustaw("AreDefaultContextMenusEnabled", () => u.AreDefaultContextMenusEnabled = dev);
            Ustaw("AreDefaultScriptDialogsEnabled", () => u.AreDefaultScriptDialogsEnabled = true);
            Ustaw("IsStatusBarEnabled", () => u.IsStatusBarEnabled = false);
            Ustaw("IsZoomControlEnabled", () => u.IsZoomControlEnabled = false);
            Ustaw("IsPinchZoomEnabled", () => u.IsPinchZoomEnabled = false);
            Ustaw("IsSwipeNavigationEnabled", () => u.IsSwipeNavigationEnabled = false);
            // F5, Ctrl+R, Ctrl+P, Ctrl+F itd. mają trafiać do strony (np. do sterowanego komputera), nie do przeglądarki
            Ustaw("AreBrowserAcceleratorKeysEnabled", () => u.AreBrowserAcceleratorKeysEnabled = false);
            Ustaw("IsPasswordAutosaveEnabled", () => u.IsPasswordAutosaveEnabled = false);
            Ustaw("IsGeneralAutofillEnabled", () => u.IsGeneralAutofillEnabled = false);
            Ustaw("IsBuiltInErrorPageEnabled", () => u.IsBuiltInErrorPageEnabled = false);
            // CSS app-region: drag przesuwa okno jak pasek tytułu; bez tego (starszy WebView2) przesuwa most.js
            bool obszaryOkna = Ustaw("IsNonClientRegionSupportEnabled", () => u.IsNonClientRegionSupportEnabled = true);

            string skrypt;
            using (var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("most.js"))
            using (var r = new StreamReader(s)) skrypt = r.ReadToEnd();
            skrypt = skrypt.Replace("'__RODZAJ__'", "'" + rodzaj + "'").Replace("__ROZMIAR__", zmienny ? "true" : "false")
                .Replace("__PRZESUWANIE__", obszaryOkna ? "false" : "true");
            await w.AddScriptToExecuteOnDocumentCreatedAsync(skrypt);

            var adres = new Uri(strona).AbsoluteUri;
            w.NavigationStarting += (o, e) =>
            {
                // tylko nasza strona; linki nie zmieniają zawartości okna (tak jak w wersji z Electronem)
                if (!string.Equals(e.Uri, adres, StringComparison.OrdinalIgnoreCase)) e.Cancel = true;
            };
            w.NewWindowRequested += (o, e) =>
            {
                e.Handled = true;
                if (e.Uri.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
                {
                    try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(e.Uri) { UseShellExecute = true }); } catch { }
                }
            };
            w.PermissionRequested += (o, e) => { e.State = CoreWebView2PermissionState.Deny; };
            w.DownloadStarting += (o, e) => { e.Cancel = true; };
            w.WebMessageReceived += Wiadomosc;
            w.NavigationCompleted += (o, e) =>
            {
                if (gotowe) return;
                gotowe = true;
                try { Dziennik.Zapisz("okno: " + rodzaj + " gotowe po " + (int)(DateTime.Now - System.Diagnostics.Process.GetCurrentProcess().StartTime).TotalMilliseconds + " ms od startu"); } catch { }
                var g = Gotowe;
                if (g != null) g();
            };
            w.ProcessFailed += (o, e) =>
            {
                Dziennik.Zapisz("okno: proces WebView2 " + e.ProcessFailedKind + " (" + e.Reason + ")");
                if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessExited
                    || e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessUnresponsive)
                {
                    try { w.Reload(); } catch { }
                }
            };
            w.Navigate(adres);
        }

        static bool Ustaw(string nazwa, Action a)
        {
            try { a(); return true; }
            catch (Exception e)
            {
                Dziennik.Zapisz("okno: WebView2 bez ustawienia " + nazwa + " (" + e.GetType().Name + ")");
                return false;
            }
        }

        // ---------------------------------------------------------------- most ze stroną

        async void Wiadomosc(object nadawca, CoreWebView2WebMessageReceivedEventArgs e)
        {
            Dictionary<string, object> m;
            try
            {
                if (!string.Equals(e.Source, new Uri(strona).AbsoluteUri, StringComparison.OrdinalIgnoreCase)) return;
                m = json.Deserialize<Dictionary<string, object>>(e.WebMessageAsJson);
            }
            catch { return; }
            if (m == null || !m.ContainsKey("m")) return;
            var nazwa = Convert.ToString(m["m"]);
            object[] argumenty = new object[0];
            object a;
            if (m.TryGetValue("a", out a) && a is System.Collections.ArrayList) argumenty = ((System.Collections.ArrayList)a).ToArray();
            object id = null;
            m.TryGetValue("id", out id);

            object wynik = null;
            string blad = null;
            try
            {
                if (nazwa == "okno") Steruj(argumenty.Length > 0 ? Convert.ToString(argumenty[0]) : "");
                else if (nazwa == "okno-krawedz") ZmienRozmiar(argumenty.Length > 0 ? Convert.ToString(argumenty[0]) : "n");
                else if (nazwa == "okno-przesun") Przesun();
                else if (nazwa == "instalator:minimalizuj") Minimalizuj();
                else if (Obsluga != null)
                {
                    wynik = Obsluga(nazwa, argumenty);
                    var zadanie = wynik as Task;
                    if (zadanie != null)
                    {
                        await zadanie;
                        var p = zadanie.GetType().GetProperty("Result");
                        wynik = p != null ? p.GetValue(zadanie, null) : null;
                        if (wynik != null && wynik.GetType().FullName == "System.Threading.Tasks.VoidTaskResult") wynik = null;
                    }
                }
            }
            catch (Exception ex)
            {
                blad = ex.Message;
                Dziennik.Zapisz("okno: " + nazwa + ": " + ex);
            }
            if (id == null || IsDisposed || widok.CoreWebView2 == null) return;
            var odp = new Dictionary<string, object> { { "id", id }, { "w", wynik } };
            if (blad != null) odp["blad"] = blad;
            try { widok.CoreWebView2.PostWebMessageAsJson(json.Serialize(odp)); } catch { }
        }

        // zdarzenie dla strony (jak webContents.send w Electronie)
        public void Wyslij(string kanal, object dane)
        {
            if (IsDisposed) return;
            if (InvokeRequired) { try { BeginInvoke((Action)(() => Wyslij(kanal, dane))); } catch { } return; }
            if (widok.CoreWebView2 == null) return;
            try { widok.CoreWebView2.PostWebMessageAsJson(json.Serialize(new Dictionary<string, object> { { "e", kanal }, { "d", dane } })); } catch { }
        }

        // ---------------------------------------------------------------- przyciski okna

        // Stan okna zmieniamy wprost przez Windows (ShowWindow), nie przez WindowState z WinForms: WinForms
        // przelicza wtedy rozmiar z paskiem tytułu, którego tu nie ma, i okno rosło po każdym przywróceniu.
        public bool Maksymalne { get { return IsHandleCreated && Win.IsZoomed(Handle); } }
        public bool Zminimalizowane { get { return IsHandleCreated && Win.IsIconic(Handle); } }
        public bool PelnyEkran { get { return pelny; } }
        public void Minimalizuj() { Win.ShowWindow(Handle, Win.SW_MINIMIZE); }
        public void Przywroc() { Win.ShowWindow(Handle, Win.SW_RESTORE); }
        public void PokazZminimalizowane() { Win.ShowWindow(Handle, Win.SW_SHOWMINNOACTIVE); }

        void Steruj(string co)
        {
            if (co == "min") Minimalizuj();
            else if (co == "max" && zmienny && !pelny) Win.ShowWindow(Handle, Maksymalne ? Win.SW_RESTORE : Win.SW_MAXIMIZE);
            else if (co == "pelny" && zmienny) UstawPelny(!pelny);
            else if (co == "zamknij") Close();
        }

        // przesuwanie za pasek tytułu, gdy WebView2 nie obsługuje app-region (starsze wersje)
        void Przesun()
        {
            if (pelny) return;
            Win.ReleaseCapture();
            Win.SendMessage(Handle, Win.WM_NCLBUTTONDOWN, (IntPtr)Win.HTCAPTION, IntPtr.Zero);
        }

        void ZmienRozmiar(string kierunek)
        {
            if (!zmienny || pelny || Maksymalne) return;
            int ht = kierunek == "nw" ? Win.HTTOPLEFT : kierunek == "ne" ? Win.HTTOPRIGHT : Win.HTTOP;
            Win.ReleaseCapture();
            Win.SendMessage(Handle, Win.WM_NCLBUTTONDOWN, (IntPtr)ht, IntPtr.Zero);
        }

        void UstawPelny(bool wl)
        {
            if (wl == pelny) return;
            var styl = (long)Win.GetWindowLongPtr(Handle, Win.GWL_STYLE);
            if (wl)
            {
                stanPrzedPelnym = Maksymalne ? FormWindowState.Maximized : FormWindowState.Normal;
                if (Maksymalne) Przywroc();
                Win.RECT b;
                Win.GetWindowRect(Handle, out b);
                granicePrzedPelnym = new Rectangle(b.Left, b.Top, b.Right - b.Left, b.Bottom - b.Top);
                pelny = true;
                Win.SetWindowLongPtr(Handle, Win.GWL_STYLE, (IntPtr)(styl & ~(long)(Win.WS_CAPTION | Win.WS_THICKFRAME)));
                var ekran = Screen.FromHandle(Handle).Bounds;
                Win.SetWindowPos(Handle, IntPtr.Zero, ekran.X, ekran.Y, ekran.Width, ekran.Height, Win.SWP_NOZORDER | Win.SWP_FRAMECHANGED);
            }
            else
            {
                pelny = false;
                Win.SetWindowLongPtr(Handle, Win.GWL_STYLE, (IntPtr)(styl | Win.WS_CAPTION | Win.WS_THICKFRAME));
                var g = granicePrzedPelnym;
                Win.SetWindowPos(Handle, IntPtr.Zero, g.X, g.Y, g.Width, g.Height, Win.SWP_NOZORDER | Win.SWP_FRAMECHANGED);
                if (stanPrzedPelnym == FormWindowState.Maximized) Win.ShowWindow(Handle, Win.SW_MAXIMIZE);
            }
            ZglosStan();
        }

        bool ostatnioMax;
        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            if (Maksymalne != ostatnioMax)
            {
                ostatnioMax = Maksymalne;
                ZglosStan();
            }
            UstawPamiec();
        }

        protected override void OnVisibleChanged(EventArgs e)
        {
            base.OnVisibleChanged(e);
            UstawPamiec();
        }

        // Okno schowane przy zegarze albo zminimalizowane oddaje pamięć silnika (komputer bez obsługi
        // większość czasu tylko czeka na połączenie; obraz i sterowanie robi wtedy host.exe, nie strona).
        void UstawPamiec()
        {
            if (widok.CoreWebView2 == null) return;
            var poziom = !Visible || Zminimalizowane ? CoreWebView2MemoryUsageTargetLevel.Low : CoreWebView2MemoryUsageTargetLevel.Normal;
            try { if (widok.CoreWebView2.MemoryUsageTargetLevel != poziom) widok.CoreWebView2.MemoryUsageTargetLevel = poziom; } catch { }
        }

        void ZglosStan()
        {
            Wyslij("okno-stan", new Dictionary<string, object> { { "max", Maksymalne }, { "pelny", pelny } });
            var z = ZmianaStanu;
            if (z != null) z();
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (!PozwolZamknac && e.CloseReason == CloseReason.UserClosing)
            {
                var z = Zamykanie;
                if (z != null && z()) { e.Cancel = true; return; }
            }
            base.OnFormClosing(e);
        }

        // ---------------------------------------------------------------- rozmiar i ramka

        float Skala { get { try { return Math.Max(1f, Win.GetDpiForWindow(Handle) / 96f); } catch { return 1f; } } }

        // rozmiar według skali ekranu, środek ekranu, na którym jest kursor (przed pierwszym pokazaniem)
        public void Wysrodkuj()
        {
            var ekran = Screen.FromPoint(Cursor.Position).WorkingArea;
            Location = new Point(ekran.Left + ekran.Width / 2, ekran.Top + ekran.Height / 2);
            var s = Skala;
            // okno zmienne ma niewidoczną ramkę po bokach i u dołu: dodajemy ją, żeby strona miała pełne 960×640
            int bok = zmienny ? Win.Ramka(Handle, false) : 0, dol = zmienny ? Win.Ramka(Handle, true) : 0;
            int szer = Math.Min((int)(rozmiar.Width * s) + 2 * bok, ekran.Width), wys = Math.Min((int)(rozmiar.Height * s) + dol, ekran.Height);
            Bounds = new Rectangle(ekran.Left + (ekran.Width - szer) / 2, ekran.Top + (ekran.Height - wys) / 2, szer, wys);
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            try
            {
                int ciemny = Ciemny() ? 1 : 0;
                Win.DwmSetWindowAttribute(Handle, 20 /* DWMWA_USE_IMMERSIVE_DARK_MODE */, ref ciemny, 4);
                int rogi = 2; // DWMWCP_ROUND: zaokrąglone rogi w Windows 11 (starsze Windows to pomijają)
                Win.DwmSetWindowAttribute(Handle, 33, ref rogi, 4);
                // cień okna bez ramki: DWM rysuje go, gdy ramka sięga choć piksel w głąb okna
                var marg = new Win.MARGINS { Top = zmienny ? 0 : 1 };
                Win.DwmExtendFrameIntoClientArea(Handle, ref marg);
            }
            catch { }
            Win.SetWindowPos(Handle, IntPtr.Zero, 0, 0, 0, 0, Win.SWP_NOMOVE | Win.SWP_NOSIZE | Win.SWP_NOZORDER | Win.SWP_NOACTIVATE | Win.SWP_FRAMECHANGED);
        }

        bool bylNienormalny;   // okno było zmaksymalizowane albo zminimalizowane
        Size wymuszony;        // rozmiar, który Windows zapamiętał dla zwykłego okna (na czas przywracania)

        protected override void WndProc(ref Message m)
        {
            // Przywracanie z maksymalizacji lub minimalizacji: WinForms ustawia wtedy rozmiar, licząc pasek
            // tytułu, którego tu nie ma, i okno rosło za każdym razem. Wymuszamy rozmiar zapamiętany przez Windows.
            if (zmienny && m.Msg == Win.WM_WINDOWPOSCHANGED)
            {
                bool nienormalny = Win.IsZoomed(Handle) || Win.IsIconic(Handle);
                if (bylNienormalny && !nienormalny && !pelny)
                {
                    var wp = new Win.WINDOWPLACEMENT { length = Marshal.SizeOf(typeof(Win.WINDOWPLACEMENT)) };
                    if (Win.GetWindowPlacement(Handle, ref wp)) wymuszony = new Size(wp.normal.Right - wp.normal.Left, wp.normal.Bottom - wp.normal.Top);
                }
                bylNienormalny = nienormalny;
                try { base.WndProc(ref m); } finally { wymuszony = Size.Empty; }
                return;
            }
            if (zmienny && m.Msg == Win.WM_WINDOWPOSCHANGING && !wymuszony.IsEmpty)
            {
                var wp = (Win.WINDOWPOS)Marshal.PtrToStructure(m.LParam, typeof(Win.WINDOWPOS));
                if ((wp.flags & Win.SWP_NOSIZE) == 0 && (wp.cx != wymuszony.Width || wp.cy != wymuszony.Height))
                {
                    wp.cx = wymuszony.Width;
                    wp.cy = wymuszony.Height;
                    Marshal.StructureToPtr(wp, m.LParam, false);
                }
            }
            if (m.Msg == Win.WM_NCCALCSIZE && m.WParam != IntPtr.Zero)
            {
                if (pelny || !zmienny)
                {
                    // całe okno to strona (instalator i pełny ekran)
                    m.Result = IntPtr.Zero;
                    return;
                }
                // okno zmienne: zostaje zwykła (w Windows 10 i 11 niewidoczna) ramka po bokach i u dołu do
                // zmiany rozmiaru, a znika pasek tytułu, bo rysuje go strona
                var p = (Win.NCCALCSIZE_PARAMS)Marshal.PtrToStructure(m.LParam, typeof(Win.NCCALCSIZE_PARAMS));
                int gora = p.r0.Top;
                base.WndProc(ref m);
                p = (Win.NCCALCSIZE_PARAMS)Marshal.PtrToStructure(m.LParam, typeof(Win.NCCALCSIZE_PARAMS));
                p.r0.Top = gora + (Win.IsZoomed(Handle) ? Win.Ramka(Handle, true) : 0);
                Marshal.StructureToPtr(p, m.LParam, false);
                m.Result = IntPtr.Zero;
                return;
            }
            if (m.Msg == Win.WM_GETMINMAXINFO && zmienny)
            {
                base.WndProc(ref m);
                var mm = (Win.MINMAXINFO)Marshal.PtrToStructure(m.LParam, typeof(Win.MINMAXINFO));
                var s = Skala;
                mm.MinTrackSize.X = (int)(minimum.Width * s) + 2 * Win.Ramka(Handle, false);
                mm.MinTrackSize.Y = (int)(minimum.Height * s) + Win.Ramka(Handle, true);
                Marshal.StructureToPtr(mm, m.LParam, false);
                return;
            }
            if (m.Msg == Win.WM_DPICHANGED)
            {
                var r = (Win.RECT)Marshal.PtrToStructure(m.LParam, typeof(Win.RECT));
                Win.SetWindowPos(Handle, IntPtr.Zero, r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top, Win.SWP_NOZORDER | Win.SWP_NOACTIVATE);
                m.Result = IntPtr.Zero;
                return;
            }
            base.WndProc(ref m);
        }

        protected override CreateParams CreateParams
        {
            get
            {
                var cp = base.CreateParams;
                if (!zmienny) cp.Style &= ~Win.WS_MAXIMIZEBOX;
                return cp;
            }
        }
    }
}
