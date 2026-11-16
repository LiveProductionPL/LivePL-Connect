'use strict';

// LivePL Connect: okno aplikacji. Pokazuje ID i hasło tego komputera i łączy z innym komputerem.
// Pomocnik host.exe trzyma łącze z serwerem pośredniczącym; obraz i sterowanie płyną
// bezpośrednio między komputerami (WebRTC). ID jest trwałe: zapisujemy je w ustawieniach
// i przy każdym starcie prosimy serwer o to samo.

const { app, BrowserWindow, ipcMain, clipboard, nativeTheme, net, shell, Tray, Menu, Notification } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DOMYSLNY_SERWER = 'wss://connect.livepl.eu:5938/ws';
const AKTUALIZACJE = 'https://aktualizacje.livepl.eu/connect/';

let okno = null;
let host = null;
let hostInfo = null;          // { id, pass } od pomocnika
let status = { stan: 'laczenie' };
let plikId = null;
let konczenie = false;
let szybkiRestart = false;
let ustawienia = {};
let aktualizacja = null;      // { wersja, plik, sha256, opis } gdy jest nowsza wersja
let pobieranie = false;
let pobranyPlik = null;       // instalator nowej wersji, pobrany i sprawdzony, czeka na wolną chwilę
let klikniete = false;        // użytkownik sam kliknął „Aktualizuj”: instalujemy od razu po pobraniu
let sesjeHosta = 0;           // ile osób jest teraz połączonych z tym komputerem
let sesjaKontrolera = false;  // czy ten komputer steruje teraz innym

// Aktualizacje same się instalują (żeby komputery klientów nie zostawały na starej wersji),
// ale nigdy w trakcie połączenia: wtedy czekają, aż sesja się skończy.
const zajety = () => sesjeHosta > 0 || sesjaKontrolera;

// Dostęp bez obsługi: stałe hasło (w ustawieniach tylko skrót PBKDF2, nigdy samo hasło),
// start razem z Windows i praca w tle z ikoną przy zegarze, gdy okno jest zamknięte.
const ITERACJE_HASLA = 300000;
const NAZWA_AUTOSTARTU = 'LivePL Connect';
const W_TLE = process.argv.includes('--autostart');
let tray = null;
let pokazanoInfoTla = false;
const dostepBezObslugi = () => !!(ustawienia.staleHaslo && ustawienia.staleHaslo.skrot);

function dziennik(tekst) {
  try {
    fs.appendFileSync(path.join(os.tmpdir(), 'livepl-connect-app.log'), '[' + new Date().toISOString() + '] ' + tekst + '\n');
  } catch { /* dziennik nie jest ważniejszy od aplikacji */ }
}

function wyslij(kanal, dane) {
  if (okno && !okno.isDestroyed()) okno.webContents.send(kanal, dane);
}

// ---------------------------------------------------------------- ustawienia

const plikUstawien = () => path.join(app.getPath('userData'), 'ustawienia.json');

function wczytajUstawienia() {
  try { ustawienia = JSON.parse(fs.readFileSync(plikUstawien(), 'utf8')) || {}; } catch { ustawienia = {}; }
}

function zapiszUstawienia() {
  try {
    fs.mkdirSync(path.dirname(plikUstawien()), { recursive: true });
    fs.writeFileSync(plikUstawien(), JSON.stringify(ustawienia, null, 2));
  } catch (e) {
    dziennik('zapis ustawień: ' + e.message);
  }
}

const serwer = () => process.env.CONNECT_SERVER || ustawienia.serwer || DOMYSLNY_SERWER;

// ---------------------------------------------------------------- stan dla okna

function stanPubliczny() {
  return {
    stan: status.stan,
    komunikat: status.komunikat || '',
    id: hostInfo ? hostInfo.id : null,
    haslo: hostInfo ? hostInfo.pass : null
  };
}

function ustawStatus(s) {
  status = { ...s };
  wyslij('status', stanPubliczny());
}

// ---------------------------------------------------------------- pomocnik host.exe

function sciezkaHosta() {
  const dev = path.join(__dirname, '..', '..', 'host', 'host.exe');
  if (!app.isPackaged && fs.existsSync(dev)) return dev;
  return path.join(process.resourcesPath, 'bin', 'host.exe');
}

function uruchomHosta() {
  const exe = sciezkaHosta();
  if (!fs.existsSync(exe)) {
    ustawStatus({ stan: 'blad', komunikat: 'Brakuje pliku host.exe. Zainstaluj LivePL Connect ponownie.' });
    return;
  }
  plikId = path.join(os.tmpdir(), 'livepl-connect-' + process.pid + '.json');
  try { fs.unlinkSync(plikId); } catch { /* nie było */ }
  hostInfo = null;
  ustawStatus({ stan: 'laczenie' });

  const argumenty = ['-server', serwer(), '-idfile', plikId];
  if (/^\d{9}$/.test(ustawienia.id || '')) argumenty.push('-id', ustawienia.id);
  dziennik('host: start ' + argumenty.join(' '));

  // skrót stałego hasła idzie do pomocnika zmienną środowiskową (nie w wierszu poleceń, który widać na liście procesów)
  const env = { ...process.env };
  delete env.LPC_STALE_HASLO;
  if (dostepBezObslugi()) {
    const h = ustawienia.staleHaslo;
    env.LPC_STALE_HASLO = ['pbkdf2-sha256', h.iteracje, h.sol, h.skrot].join('$');
  }
  const ten = spawn(exe, argumenty, { windowsHide: true, env });
  host = ten;
  ten.on('error', (e) => dziennik('host: błąd uruchomienia ' + e.message));
  let reszta = '';
  ten.stdout.on('data', (d) => {
    // pełne linie: kawałek wyjścia potrafi urwać się w połowie
    const linie = (reszta + d.toString()).split(/\r?\n/);
    reszta = linie.pop();
    for (const t of linie) {
      if (/STATUS online/.test(t) && hostInfo) ustawStatus({ stan: 'online' });
      if (/STATUS offline/.test(t)) ustawStatus({ stan: 'laczenie' });
      const s = /SESSIONS (\d+)/.exec(t);
      if (s) {
        sesjeHosta = Number(s[1]);
        dziennik('host: połączonych osób ' + sesjeHosta);
        if (!sesjeHosta) setTimeout(probujZainstalowac, 30000);
      }
    }
  });
  ten.stderr.on('data', (d) => dziennik('host: ' + d.toString().trim()));
  ten.on('exit', (kod) => {
    dziennik('host: koniec ' + kod);
    if (host === ten) { host = null; sesjeHosta = 0; }
    if (konczenie) return;
    const zaraz = szybkiRestart;
    szybkiRestart = false;
    setTimeout(() => { if (!konczenie && !host) uruchomHosta(); }, zaraz ? 800 : 3000);
  });

  // serwer długo milczy: mówimy to wprost (pomocnik i tak próbuje dalej)
  setTimeout(() => {
    if (host === ten && !hostInfo) {
      ustawStatus({ stan: 'blad', komunikat: 'Nie mogę połączyć się z serwerem. Sprawdzam dalej…' });
    }
  }, 15000);
}

function zatrzymajHosta() {
  try { if (host) host.kill(); } catch { /* już zamknięty */ }
}

// pomocnik startuje od nowa (nowe ustawienia), ID zostaje to samo
function restartHosta() {
  szybkiRestart = true;
  if (host) zatrzymajHosta(); else uruchomHosta();
}

// ---------------------------------------------------------------- dostęp bez obsługi

function ustawStaleHaslo(haslo) {
  const h = String(haslo || '');
  if (h.length < 8) return { ok: false, blad: 'Stałe hasło musi mieć co najmniej 8 znaków.' };
  if (h.length > 64) return { ok: false, blad: 'Stałe hasło może mieć najwyżej 64 znaki.' };
  if (/^\d+$/.test(h) && h.length < 10) return { ok: false, blad: 'Same cyfry łatwo zgadnąć: dodaj litery albo użyj co najmniej 10 cyfr.' };
  if (/^\s|\s$/.test(h)) return { ok: false, blad: 'Hasło nie może zaczynać się ani kończyć spacją.' };
  const sol = crypto.randomBytes(16);
  const skrot = crypto.pbkdf2Sync(h, sol, ITERACJE_HASLA, 32, 'sha256');
  ustawienia.staleHaslo = { iteracje: ITERACJE_HASLA, sol: sol.toString('hex'), skrot: skrot.toString('hex'), ustawiono: new Date().toISOString() };
  // bez startu z Windows stałe hasło nie przetrwa ponownego uruchomienia komputera
  if (ustawienia.autostart === undefined) ustawienia.autostart = true;
  zapiszUstawienia();
  zastosujAutostart();
  restartHosta();
  dziennik('stałe hasło: ustawione');
  return { ok: true, ...stanDostepu() };
}

function usunStaleHaslo() {
  delete ustawienia.staleHaslo;
  zapiszUstawienia();
  restartHosta();
  pokazOkno();
  if (tray) { tray.destroy(); tray = null; }
  dziennik('stałe hasło: usunięte');
  return { ok: true, ...stanDostepu() };
}

function zastosujAutostart() {
  if (!app.isPackaged) return; // wersja deweloperska nie wpisuje się do autostartu
  try {
    // ścieżka w cudzysłowie: Electron wpisuje ją do rejestru dosłownie, a w „LivePL Connect” są spacje
    app.setLoginItemSettings({ openAtLogin: !!ustawienia.autostart, path: `"${process.execPath}"`, args: ['--autostart'], name: NAZWA_AUTOSTARTU });
  } catch (e) {
    dziennik('autostart: ' + e.message);
  }
}

function ustawAutostart(wl) {
  ustawienia.autostart = !!wl;
  zapiszUstawienia();
  zastosujAutostart();
  return stanDostepu();
}

const stanDostepu = () => ({ staleHaslo: dostepBezObslugi(), autostart: !!ustawienia.autostart, dev: !app.isPackaged });

function pokazOkno() {
  if (!okno || okno.isDestroyed()) return;
  if (okno.isMinimized()) okno.restore();
  okno.show();
  okno.focus();
}

function utworzTray() {
  if (tray) return;
  tray = new Tray(path.join(__dirname, '..', 'assets', 'icon.ico'));
  tray.setToolTip('LivePL Connect');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Otwórz LivePL Connect', click: pokazOkno },
    { type: 'separator' },
    { label: 'Zakończ (komputer przestanie być dostępny)', click: () => { konczenie = true; app.quit(); } }
  ]));
  tray.on('click', pokazOkno);
  tray.on('double-click', pokazOkno);
}

function odswiezTray() {
  if (tray) tray.setToolTip('LivePL Connect' + (hostInfo ? ' · ID ' + hostInfo.id.replace(/(\d{3})(?=\d)/g, '$1 ') : '') + (dostepBezObslugi() ? ' · dostęp bez obsługi' : ''));
}

// zamknięcie okna przy dostępie bez obsługi chowa je do ikony przy zegarze; komputer dalej czeka na połączenia
function schowajDoTla() {
  utworzTray();
  odswiezTray();
  okno.hide();
  if (!pokazanoInfoTla && !W_TLE && Notification.isSupported()) {
    pokazanoInfoTla = true;
    new Notification({
      title: 'LivePL Connect działa w tle',
      body: 'Ten komputer jest dostępny po ID i stałym haśle. Ikona LivePL Connect jest przy zegarze.',
      icon: path.join(__dirname, '..', 'assets', 'icon.png')
    }).show();
  }
}

// pomocnik zapisuje ID i hasło do małego pliku; czytamy go, bo stdout bywa podzielony na kawałki
function obserwujPlikId() {
  setInterval(() => {
    if (!plikId) return;
    let j;
    try { j = JSON.parse(fs.readFileSync(plikId, 'utf8')); } catch { return; }
    if (!j || !/^\d{9}$/.test(String(j.id)) || !j.pass) return;
    const id = String(j.id);
    const pass = String(j.pass);
    if (hostInfo && hostInfo.id === id && hostInfo.pass === pass) return;
    hostInfo = { id, pass };
    dziennik('host: gotowy, ID ' + id);
    if (ustawienia.id !== id) { ustawienia.id = id; zapiszUstawienia(); }
    ustawStatus({ stan: 'online' });
    odswiezTray();
  }, 400);
}

// ---------------------------------------------------------------- aktualizacje

function porownaj(a, b) {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}

async function sprawdzAktualizacje(reczne) {
  if (!app.isPackaged) {
    if (reczne) wyslij('aktualizacja', { stan: 'dev', komunikat: 'Aktualizacje działają w zainstalowanej wersji.' });
    return;
  }
  if (pobieranie) return;
  try {
    if (reczne) wyslij('aktualizacja', { stan: 'sprawdzam' });
    const r = await net.fetch(AKTUALIZACJE + 'wersja.json?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const w = await r.json();
    if (w && w.wersja && w.plik && porownaj(w.wersja, app.getVersion()) > 0) {
      const nowa = { wersja: String(w.wersja), plik: String(w.plik), sha256: String(w.sha256 || ''), opis: String(w.opis || '') };
      if (!aktualizacja || aktualizacja.wersja !== nowa.wersja || aktualizacja.sha256 !== nowa.sha256) pobranyPlik = null;
      aktualizacja = nowa;
      wyslij('aktualizacja', { stan: 'dostepna', ...aktualizacja });
      if (!reczne) pobierzIZainstaluj(true);
    } else if (reczne) {
      wyslij('aktualizacja', { stan: 'aktualna' });
    }
  } catch (e) {
    dziennik('aktualizacje: ' + e.message);
    if (reczne) wyslij('aktualizacja', { stan: 'blad', komunikat: 'Nie udało się sprawdzić aktualizacji.' });
  }
}

// automat = sama z siebie (w tle); inaczej użytkownik kliknął „Aktualizuj” i instalujemy od razu
async function pobierzIZainstaluj(automat) {
  if (!aktualizacja) return;
  if (pobieranie) { if (!automat) klikniete = true; return; } // kliknięcie w trakcie pobierania w tle
  klikniete = !automat;
  if (pobranyPlik && fs.existsSync(pobranyPlik)) {
    if (automat) probujZainstalowac(); else zainstaluj(pobranyPlik, aktualizacja);
    return;
  }
  pobieranie = true;
  const a = aktualizacja;
  const cel = path.join(os.tmpdir(), path.basename(a.plik));
  try {
    wyslij('aktualizacja', { stan: 'pobieram', postep: 0, ...a });
    const r = await net.fetch(AKTUALIZACJE + encodeURIComponent(a.plik), { cache: 'no-store' });
    if (!r.ok || !r.body) throw new Error('HTTP ' + r.status);
    const razem = Number(r.headers.get('content-length')) || 0;
    const skrot = crypto.createHash('sha256');
    const plik = fs.createWriteStream(cel);
    const czytnik = r.body.getReader();
    let mam = 0;
    let ostatnio = 0;
    for (;;) {
      const { done, value } = await czytnik.read();
      if (done) break;
      const kawalek = Buffer.from(value);
      skrot.update(kawalek);
      mam += kawalek.length;
      if (!plik.write(kawalek)) await new Promise((ok) => plik.once('drain', ok));
      const teraz = Date.now();
      if (razem && teraz - ostatnio > 120) {
        ostatnio = teraz;
        wyslij('aktualizacja', { stan: 'pobieram', postep: mam / razem, ...a });
      }
    }
    await new Promise((ok, zle) => { plik.on('error', zle); plik.end(ok); });
    if (!a.sha256 || skrot.digest('hex').toLowerCase() !== a.sha256.toLowerCase()) {
      throw new Error('suma kontrolna się nie zgadza');
    }
    pobieranie = false;
    pobranyPlik = cel;
    dziennik('aktualizacja ' + a.wersja + ' pobrana' + (klikniete ? '' : ' (w tle)'));
    if (!klikniete) {
      wyslij('aktualizacja', { stan: 'dostepna', ...a });
      probujZainstalowac();
    } else {
      zainstaluj(cel, a);
    }
  } catch (e) {
    dziennik('pobieranie aktualizacji: ' + e.message);
    try { fs.unlinkSync(cel); } catch { /* nic */ }
    pobieranie = false;
    wyslij('aktualizacja', { stan: klikniete ? 'blad' : 'dostepna', komunikat: 'Nie udało się pobrać aktualizacji.', ...a });
  }
}

function zainstaluj(plik, a) {
  dziennik('instaluję aktualizację ' + a.wersja);
  wyslij('aktualizacja', { stan: 'instaluje', ...a });
  // program schowany w tle wraca po aktualizacji też do tła (komputer bez obsługi)
  const wTle = okno && !okno.isDestroyed() && !okno.isVisible();
  spawn(plik, ['--aktualizuj', ...(wTle ? ['--w-tle'] : [])], { detached: true, stdio: 'ignore' }).unref();
  setTimeout(() => { konczenie = true; app.quit(); }, 700);
}

// pobrana aktualizacja instaluje się sama, gdy nikt nie jest połączony
// i nikt właśnie nie korzysta z okna (wtedy czekamy na następną próbę)
function probujZainstalowac() {
  if (!pobranyPlik || !aktualizacja || konczenie || !fs.existsSync(pobranyPlik)) return;
  if (zajety()) { dziennik('aktualizacja czeka: trwa połączenie'); return; }
  if (okno && !okno.isDestroyed() && okno.isFocused() && okno.isVisible() && !okno.isMinimized()) {
    dziennik('aktualizacja czeka: okno jest w użyciu');
    return;
  }
  zainstaluj(pobranyPlik, aktualizacja);
}

// ---------------------------------------------------------------- okno

function utworzOkno() {
  okno = new BrowserWindow({
    width: 960,
    height: 640,
    minWidth: 840,
    minHeight: 580,
    frame: false,
    show: false,
    title: 'LivePL Connect',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#16191e' : '#ffffff',
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true }
  });
  okno.setMenu(null);
  okno.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));
  okno.once('ready-to-show', () => {
    // start z Windows: przy dostępie bez obsługi od razu w tle, inaczej zminimalizowany
    if (W_TLE && dostepBezObslugi()) schowajDoTla();
    else if (W_TLE) { okno.showInactive(); okno.minimize(); }
    else okno.show();
  });
  okno.on('close', (e) => {
    if (!konczenie && dostepBezObslugi()) {
      e.preventDefault();
      schowajDoTla();
    }
  });
  okno.webContents.on('will-navigate', (e) => e.preventDefault());
  okno.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  okno.webContents.on('console-message', (e, poziom, tresc, linia, zrodlo) => {
    if (poziom >= 2) dziennik('okno[' + poziom + ']: ' + tresc + ' @' + zrodlo + ':' + linia);
  });
  okno.webContents.on('preload-error', (e, p, blad) => dziennik('preload: ' + ((blad && blad.stack) || blad)));
  const stanOkna = () => wyslij('okno-stan', { max: okno.isMaximized(), pelny: okno.isFullScreen() });
  for (const z of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) okno.on(z, stanOkna);
}

// ---------------------------------------------------------------- start

function uruchom() {
  app.setName('LivePL Connect');
  // LPC_DANE: osobny folder ustawień (testy), żeby nie ruszać prawdziwego ID i hasła
  app.setPath('userData', process.env.LPC_DANE || path.join(app.getPath('appData'), 'LivePL Connect'));
  app.setAppUserModelId('eu.livepl.connect');

  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', () => pokazOkno());
  app.on('before-quit', () => { konczenie = true; });
  app.on('window-all-closed', () => {
    konczenie = true;
    zatrzymajHosta();
    try { if (plikId) fs.unlinkSync(plikId); } catch { /* nic */ }
    app.quit();
  });

  ipcMain.handle('stan', () => ({
    ...stanPubliczny(),
    wersja: app.getVersion(),
    serwer: serwer(),
    domyslnySerwer: DOMYSLNY_SERWER,
    aktualizacja,
    ...stanDostepu()
  }));
  ipcMain.handle('stale-haslo', (e, haslo) => ustawStaleHaslo(haslo));
  ipcMain.handle('stale-haslo-usun', () => usunStaleHaslo());
  ipcMain.handle('autostart', (e, wl) => ustawAutostart(wl));
  ipcMain.handle('kopiuj', (e, tekst) => { clipboard.writeText(String(tekst)); return true; });
  ipcMain.handle('nowe-haslo', () => {
    if (!host) { uruchomHosta(); return; }
    szybkiRestart = true;
    hostInfo = null;
    ustawStatus({ stan: 'laczenie' });
    zatrzymajHosta();
  });
  ipcMain.handle('ustaw-serwer', (e, adres) => {
    const a = String(adres || '').trim();
    if (a && !/^wss?:\/\/[^\s/]+/i.test(a)) return { ok: false, blad: 'Adres musi zaczynać się od wss:// albo ws://' };
    if (a && a !== DOMYSLNY_SERWER) ustawienia.serwer = a;
    else delete ustawienia.serwer;
    zapiszUstawienia();
    restartHosta();
    return { ok: true, serwer: serwer() };
  });
  ipcMain.handle('sprawdz-aktualizacje', () => sprawdzAktualizacje(true));
  ipcMain.handle('aktualizuj', () => pobierzIZainstaluj(false));
  ipcMain.on('sesja', (e, trwa) => {
    sesjaKontrolera = !!trwa;
    if (!trwa) setTimeout(probujZainstalowac, 30000);
  });
  ipcMain.on('okno', (e, co) => {
    if (!okno) return;
    if (co === 'min') okno.minimize();
    else if (co === 'max') { if (okno.isMaximized()) okno.unmaximize(); else okno.maximize(); }
    else if (co === 'pelny') okno.setFullScreen(!okno.isFullScreen());
    else if (co === 'zamknij') okno.close();
  });

  app.whenReady().then(() => {
    wczytajUstawienia();
    zastosujAutostart(); // po przeniesieniu lub reinstalacji wpis wskazuje aktualny program
    if (dostepBezObslugi()) utworzTray();
    utworzOkno();
    obserwujPlikId();
    uruchomHosta();
    // nowa wersja na serwerze dociera do wszystkich komputerów w ciągu godziny
    setTimeout(() => sprawdzAktualizacje(false), 4000);
    setInterval(() => sprawdzAktualizacje(false), 3600 * 1000);
    setInterval(probujZainstalowac, 5 * 60 * 1000);
  });
}

module.exports = { uruchom };
