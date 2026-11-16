'use strict';

// Instalator i odinstalowanie LivePL Connect: ten sam program w trybie „--instalator” albo „--odinstaluj”.
// Instalacja tylko dla bieżącego użytkownika, bez uprawnień administratora:
//   pliki      %LOCALAPPDATA%\Programs\LivePL Connect
//   skróty     menu Start i (opcjonalnie) pulpit
//   wpis       HKCU\...\Uninstall\LivePL Connect, czyli „Aplikacje i funkcje” w Ustawieniach Windows
// Ustawienia (w tym trwałe ID komputera) zostają w %APPDATA%\LivePL Connect.
// „--aktualizuj”: bez powitania, od razu postęp, a po wszystkim program wraca sam.
// Do testów: --cel=<folder> instaluje gdzie indziej, skróty kładzie w <folder>\_skroty, bez wpisu w rejestrze.

const { app, BrowserWindow, ipcMain, nativeTheme, shell } = require('electron');
const { execFile, spawn } = require('child_process');

// Electron udaje, że pliki .asar to foldery; stara wersja (NSIS) ma resources\app.asar i bez tego
// usuwanie jej folderu zatrzymuje się w połowie. Instalator czyta i kasuje zwykłe pliki.
process.noAsar = true;
const fs = require('fs');
const os = require('os');
const path = require('path');

const NAZWA = 'LivePL Connect';
const KLUCZ = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\LivePL Connect';
const WERSJA = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version; } catch { return ''; }
})();

function argument(nazwa) {
  const a = process.argv.find((x) => x.startsWith('--' + nazwa + '='));
  return a ? a.slice(nazwa.length + 3) : null;
}

const TEST_CEL = argument('cel');
// „--updated” (z „/S”) dostajemy od starej wersji 0.4.1: jej moduł aktualizacji (electron-updater)
// pobiera nasz instalator według latest.yml i uruchamia go przy zamykaniu programu
const ZE_STAREJ = process.argv.includes('--updated');
const AKTUALIZACJA = process.argv.includes('--aktualizuj') || ZE_STAREJ;
// nasza aktualizacja zamyka program, więc go przywracamy; stara wersja instaluje przy zamknięciu
// przez użytkownika, więc wtedy program wraca tylko na wyraźne „--force-run”
const URUCHOM_PO = process.argv.includes('--aktualizuj') || process.argv.includes('--force-run');
const CEL = TEST_CEL ? path.resolve(TEST_CEL) : path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', NAZWA);
const EXE = path.join(CEL, NAZWA + '.exe');
const ZRODLO = path.dirname(process.execPath);
const SKROTY = TEST_CEL
  ? { start: path.join(CEL, '_skroty', 'Start'), pulpit: path.join(CEL, '_skroty', 'Pulpit') }
  : { start: path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs'), pulpit: app.getPath('desktop') };

let okno = null;

function wykonaj(plik, argumenty, env = {}) {
  return new Promise((ok, zle) => execFile(plik, argumenty, { windowsHide: true, env: { ...process.env, ...env } },
    (blad, wyjscie) => (blad ? zle(blad) : ok(String(wyjscie || '')))));
}

const ps = (polecenie, env) => wykonaj('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', polecenie], env);

function wyslij(kanal, dane) {
  if (okno && !okno.isDestroyed()) okno.webContents.send(kanal, dane);
}

// ---------------------------------------------------------------- stan

function zainstalowanaWersja() {
  try { return JSON.parse(fs.readFileSync(path.join(CEL, 'resources', 'app', 'package.json'), 'utf8')).version || '?'; } catch { /* brak */ }
  // stara instalacja (instalator NSIS) nie ma resources\app, ale ma program
  return fs.existsSync(EXE) ? 'starsza' : null;
}

// LivePL Connect i jego pomocnik uruchomione z folderu instalacji
async function dzialajace(folder = CEL) {
  try {
    const w = await ps("Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'LivePL Connect.exe' -or $_.Name -eq 'host.exe') -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($env:LPC_CEL + '\\', 'OrdinalIgnoreCase') -and $_.ProcessId -ne " + process.pid + ' } | ForEach-Object { $_.ProcessId }', { LPC_CEL: folder });
    return w.split(/\s+/).map(Number).filter(Boolean);
  } catch {
    return [];
  }
}

async function zamknijDzialajace(folder = CEL) {
  for (const pid of await dzialajace(folder)) {
    try { process.kill(pid); } catch { /* już zamknięty */ }
  }
  for (let i = 0; i < 20 && (await dzialajace(folder)).length; i++) await new Promise((r) => setTimeout(r, 250));
}

// ---------------------------------------------------------------- kopiowanie z postępem

function lista(folder, baza = folder, wynik = []) {
  for (const w of fs.readdirSync(folder, { withFileTypes: true })) {
    const pelna = path.join(folder, w.name);
    if (w.isDirectory()) lista(pelna, baza, wynik);
    else wynik.push({ sciezka: path.relative(baza, pelna), rozmiar: fs.statSync(pelna).size });
  }
  return wynik;
}

async function kopiuj(postep) {
  const pliki = lista(ZRODLO);
  const razem = pliki.reduce((s, p) => s + p.rozmiar, 0) || 1;
  let skopiowano = 0;
  for (const [i, p] of pliki.entries()) {
    const cel = path.join(CEL, p.sciezka);
    fs.mkdirSync(path.dirname(cel), { recursive: true });
    await fs.promises.copyFile(path.join(ZRODLO, p.sciezka), cel);
    skopiowano += p.rozmiar;
    if (i % 3 === 0 || i === pliki.length - 1) postep(skopiowano / razem, `Kopiuję pliki: ${i + 1} z ${pliki.length}`);
  }
  return razem;
}

// ---------------------------------------------------------------- skróty i wpis w Windows

function skrot(folder) {
  fs.mkdirSync(folder, { recursive: true });
  return shell.writeShortcutLink(path.join(folder, NAZWA + '.lnk'), 'create', {
    target: EXE,
    cwd: CEL,
    description: 'LivePL Connect: zdalny pulpit Live Production',
    icon: EXE,
    iconIndex: 0,
    appUserModelId: 'eu.livepl.connect'
  });
}

async function zarejestruj(rozmiar) {
  if (TEST_CEL) return;
  const wpisy = [
    ['DisplayName', 'REG_SZ', NAZWA],
    ['DisplayVersion', 'REG_SZ', WERSJA],
    ['Publisher', 'REG_SZ', 'Live Production'],
    ['DisplayIcon', 'REG_SZ', `"${EXE}",0`],
    ['InstallLocation', 'REG_SZ', CEL],
    ['UninstallString', 'REG_SZ', `"${EXE}" --odinstaluj`],
    ['URLInfoAbout', 'REG_SZ', 'https://liveproduction.pl/'],
    ['HelpLink', 'REG_SZ', 'https://livepl.eu/'],
    ['Comments', 'REG_SZ', 'Zdalny pulpit Live Production'],
    ['NoModify', 'REG_DWORD', '1'],
    ['NoRepair', 'REG_DWORD', '1'],
    ['EstimatedSize', 'REG_DWORD', String(Math.round(rozmiar / 1024))]
  ];
  for (const [nazwa, typ, wartosc] of wpisy) await wykonaj('reg.exe', ['add', KLUCZ, '/v', nazwa, '/t', typ, '/d', wartosc, '/f']);
}

// Wersje do 0.4.1 stawiał instalator NSIS: wpis „LivePL Connect 0.4.1” w „Aplikacje i funkcje”
// i pliki w %LOCALAPPDATA%\Programs\livepl-connect. Usuwamy wpis i stary folder (tylko taki,
// który wygląda jak stary LivePL Connect, i nigdy nie nasz nowy folder).
async function sprzatnijStaryInstalator() {
  if (TEST_CEL) return;
  let wpisy = [];
  try {
    const w = await ps("@(Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' | ForEach-Object { $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue; if ($_.PSChildName -ne 'LivePL Connect' -and [string]$p.DisplayName -like 'LivePL Connect*') { [pscustomobject]@{ klucz = $_.PSChildName; odinstaluj = [string]$p.UninstallString } } }) | ConvertTo-Json -Compress");
    const j = w.trim() ? JSON.parse(w) : [];
    wpisy = Array.isArray(j) ? j : [j];
  } catch { return; }
  const programy = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs').toLowerCase() + path.sep;
  for (const wpis of wpisy) {
    if (!wpis || !wpis.klucz) continue;
    const m = /^"([^"]+)"/.exec(wpis.odinstaluj || '');
    const stary = m ? path.dirname(m[1]) : null;
    if (stary && stary.toLowerCase().startsWith(programy) && stary.toLowerCase() !== CEL.toLowerCase()
      && fs.existsSync(path.join(stary, NAZWA + '.exe'))) {
      await zamknijDzialajace(stary);
      try { fs.rmSync(stary, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* zostanie do następnej aktualizacji */ }
    }
    await wykonaj('reg.exe', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\' + wpis.klucz, '/f']).catch(() => {});
  }
  // pobrane przez starą wersję instalatory (w tym ten, który właśnie działa) sprzątamy po chwili
  if (ZE_STAREJ) {
    const pamiec = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'livepl-connect-updater');
    if (fs.existsSync(pamiec)) {
      spawn('cmd.exe', ['/d', '/c', `ping -n 60 127.0.0.1 >nul & rmdir /s /q "${pamiec}"`], { detached: true, stdio: 'ignore', windowsHide: true, cwd: os.tmpdir() }).unref();
    }
  }
}

// skrót na pulpicie z poprzedniej instalacji (np. starej wersji) ma wskazywać nowy program
function poprawSkrotNaPulpicie() {
  const lnk = path.join(SKROTY.pulpit, NAZWA + '.lnk');
  try {
    if (!fs.existsSync(lnk)) return;
    const cel = shell.readShortcutLink(lnk).target || '';
    if (cel.toLowerCase() !== EXE.toLowerCase() && /LivePL Connect\.exe$/i.test(cel)) skrot(SKROTY.pulpit);
  } catch { /* skrót nieczytelny: zostawiamy */ }
}

// ---------------------------------------------------------------- instalacja

async function instaluj(opcje) {
  const postep = (ulamek, opis) => wyslij('postep', { ulamek: Math.max(0, Math.min(1, ulamek)), opis });
  try {
    postep(0, 'Zamykam LivePL Connect, jeśli działa…');
    await zamknijDzialajace();
    postep(0.01, 'Przygotowuję folder…');
    if (fs.existsSync(CEL)) {
      try {
        fs.rmSync(CEL, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
      } catch {
        throw new Error('Nie mogę zastąpić poprzedniej wersji. Zamknij LivePL Connect i spróbuj jeszcze raz.');
      }
    }
    const rozmiar = await kopiuj((u, opis) => postep(0.02 + u * 0.9, opis));
    postep(0.93, 'Tworzę skróty…');
    skrot(SKROTY.start);
    if (opcje && opcje.pulpit) skrot(SKROTY.pulpit);
    else poprawSkrotNaPulpicie();
    postep(0.96, 'Rejestruję LivePL Connect w Windows…');
    await sprzatnijStaryInstalator();
    await zarejestruj(rozmiar);
    postep(1, 'Gotowe');
    return { ok: true, cel: CEL };
  } catch (e) {
    return { ok: false, blad: e.message || String(e) };
  }
}

async function odinstaluj(opcje) {
  const postep = (ulamek, opis) => wyslij('postep', { ulamek, opis });
  try {
    postep(0.1, 'Zamykam LivePL Connect…');
    await zamknijDzialajace();
    postep(0.4, 'Usuwam skróty…');
    for (const f of [SKROTY.start, SKROTY.pulpit]) {
      try {
        const lnk = path.join(f, NAZWA + '.lnk');
        if (fs.existsSync(lnk) && path.resolve(shell.readShortcutLink(lnk).target).toLowerCase() === EXE.toLowerCase()) fs.rmSync(lnk);
      } catch { /* skrót już usunięty albo inny */ }
    }
    postep(0.6, 'Usuwam wpis z Windows…');
    if (!TEST_CEL) await wykonaj('reg.exe', ['delete', KLUCZ, '/f']).catch(() => {});
    // start razem z Windows (dostęp bez obsługi)
    if (!TEST_CEL) await wykonaj('reg.exe', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', NAZWA, '/f']).catch(() => {});
    if (opcje && opcje.dane) {
      postep(0.8, 'Usuwam ustawienia LivePL Connect…');
      fs.rmSync(path.join(app.getPath('appData'), NAZWA), { recursive: true, force: true });
    }
    postep(1, 'Gotowe');
    return { ok: true };
  } catch (e) {
    return { ok: false, blad: e.message || String(e) };
  }
}

// pliki programu usuwamy po zamknięciu okna (działający program nie skasuje sam siebie)
function usunPoZamknieciu() {
  const skrypt = `ping -n 3 127.0.0.1 >nul & rmdir /s /q "${CEL}"`;
  spawn('cmd.exe', ['/d', '/c', skrypt], { detached: true, stdio: 'ignore', windowsHide: true, cwd: os.tmpdir() }).unref();
}

// ---------------------------------------------------------------- okno

function uruchom(tryb) {
  app.setName('LivePL Connect');
  app.setPath('userData', path.join(os.tmpdir(), 'LivePL-Connect-instalator-dane'));
  app.setAppUserModelId('eu.livepl.connect.instalator');
  let odinstalowano = false;

  ipcMain.handle('instalator:stan', async () => ({
    tryb,
    aktualizacja: AKTUALIZACJA,
    uruchomPo: URUCHOM_PO,
    wersja: WERSJA,
    zainstalowana: zainstalowanaWersja(),
    cel: CEL,
    test: !!TEST_CEL,
    dziala: (await dzialajace()).length > 0
  }));
  ipcMain.handle('instalator:instaluj', (e, opcje) => instaluj(opcje));
  ipcMain.handle('instalator:odinstaluj', async (e, opcje) => {
    const w = await odinstaluj(opcje);
    odinstalowano = w.ok;
    return w;
  });
  ipcMain.on('instalator:uruchom', () => {
    // program, który przed aktualizacją był schowany w tle, wraca do tła (komputer bez obsługi)
    const argumenty = AKTUALIZACJA && process.argv.includes('--w-tle') ? ['--autostart'] : [];
    if (fs.existsSync(EXE)) spawn(EXE, argumenty, { detached: true, stdio: 'ignore', cwd: CEL }).unref();
    app.quit();
  });
  ipcMain.on('instalator:zamknij', () => app.quit());
  ipcMain.on('instalator:minimalizuj', () => { if (okno) okno.minimize(); });

  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => { if (odinstalowano) usunPoZamknieciu(); });

  app.whenReady().then(() => {
    okno = new BrowserWindow({
      width: 820,
      height: 520,
      resizable: false,
      maximizable: false,
      frame: false,
      show: false,
      title: tryb === 'odinstaluj' ? 'Odinstaluj LivePL Connect' : 'Instalator LivePL Connect',
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#16191e' : '#ffffff',
      icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
      webPreferences: { preload: path.join(__dirname, 'preload-instalator.js'), contextIsolation: true, sandbox: true }
    });
    okno.setMenu(null);
    okno.loadFile(path.join(__dirname, '..', 'ui', 'instalator.html'));
    okno.once('ready-to-show', () => okno.show());
    okno.webContents.on('will-navigate', (e) => e.preventDefault());
    okno.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });
}

module.exports = { uruchom };
