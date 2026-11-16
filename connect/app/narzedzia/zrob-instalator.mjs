// Buduje LivePL-Connect-Instalator-<wersja>.exe: jeden plik z całym LivePL Connect (silnik Electron,
// program i pomocnik host.exe) i graficznym instalatorem w stylu LivePL, plus wersja.json dla
// automatycznych aktualizacji. Bez dodatkowych narzędzi: paczkę ZIP robi .NET, ikonę i opis pliku
// wpisuje rcedit, a mały program startowy kompiluje kompilator C# wbudowany w Windows.
// Uruchom (najpierw zaloguj SimplySign Desktop):  npm run instalator -- --zmiana "co nowego" [--zmiana "…"]
//   Wynik:  ..\Wydania\LivePL-Connect\<wersja>\ obok folderu z kodem  (instalator, na-serwer\, CZYTAJ.txt)
//   Zawsze z podpisem Certum: instalator i każdy .exe/.dll w środku (pliki z podpisem Microsoftu zostają).
//   Próbnie gdzie indziej, bez podpisu:  npm run instalator -- --do %TEMP%\connect-proba
// Wersję bierze z package.json. Gotowej wersji nie nadpisuje: zainstalowane Connecty znają już sumę
// pliku o tej nazwie, więc każda zmiana to nowa wersja.
import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zapiszCzytaj } from './czytaj.mjs';
// podpis Certum: LIVEPL_PODPIS=certum (zalogowany SimplySign Desktop); bez tej zmiennej buduje bez podpisu
import { wybierzCertyfikat, sprawdzSesje, podpisz, maPodpis } from './podpis.mjs';

const katalog = join(dirname(fileURLToPath(import.meta.url)), '..');
const pakiet = JSON.parse(readFileSync(join(katalog, 'package.json'), 'utf8'));
const wersja = pakiet.version;
const silnik = join(katalog, 'node_modules', 'electron', 'dist');
const hostExe = join(katalog, '..', 'host', 'host.exe');
const licencja = join(katalog, '..', '..', 'LICENSE');
const argumenty = process.argv.slice(2);
const opcje = (nazwa) => argumenty.flatMap((a, i) => (a === nazwa && argumenty[i + 1] !== undefined ? [argumenty[i + 1]] : []));
const zmiany = opcje('--zmiana');
// katalog = LivePL\LivePL-RMM\connect\app, więc Wydania leżą trzy poziomy wyżej
const wyjscie = resolve(opcje('--do')[0] || join(katalog, '..', '..', '..', 'Wydania', 'LivePL-Connect', wersja));
const naSerwer = join(wyjscie, 'na-serwer');
const robocze = join(tmpdir(), 'LivePL-Connect-robocze'); // w %TEMP%, poza folderem z kodem: setki plików i ~250 MB
const program = join(robocze, 'LivePL Connect');
const krok = (t) => console.log('  ' + t);

// rcedit trzymamy przy narzędziach (kopia z pamięci electron-buildera, którą usunęliśmy, żeby zwolnić miejsce)
const rcedit = [
  join(katalog, 'narzedzia', 'instalator', 'rcedit-x64.exe'),
  join(katalog, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe'),
  join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache', 'winCodeSign', 'winCodeSign-2.6.0', 'rcedit-x64.exe')
].find((p) => existsSync(p));
if (!rcedit) throw new Error('Nie znalazłem rcedit-x64.exe (npm i -D rcedit)');
if (!existsSync(join(silnik, 'electron.exe'))) throw new Error('Brak silnika Electron w ' + silnik);
if (!existsSync(hostExe)) throw new Error('Brak host.exe (zbuduj connect/host: go build -o host.exe .)');
if (!existsSync(licencja)) throw new Error('Brak pliku licencji ' + licencja);
// okno „O programie” pokazuje treść licencji: musi być ta sama co w LICENSE
const bezOdstepow = (t) => t.replace(/\s+/g, ' ').trim();
if (!bezOdstepow(readFileSync(join(katalog, 'ui', 'index.html'), 'utf8')).includes(bezOdstepow(readFileSync(licencja, 'utf8')))) {
  throw new Error('Treść licencji w ui/index.html (okno „O programie”) różni się od ' + licencja);
}

const plik = `LivePL-Connect-Instalator-${wersja}.exe`;
if (existsSync(join(wyjscie, plik))) {
  throw new Error(`${plik} już jest w ${wyjscie}. Podnieś wersję w package.json (np. ${wersja.replace(/\d+$/, (n) => +n + 1)}).`);
}

console.log(`Instalator LivePL Connect ${wersja} -> ${wyjscie}`);
// Każda wersja do Wydania jest podpisana Certum (instalator i każdy .exe/.dll w środku). Bez podpisu
// tylko próbnie, poza Wydania (--do). Certyfikat sprawdzamy na początku, żeby błąd logowania
// SimplySign wyszedł od razu.
const probna = opcje('--do').length > 0;
const certyfikat = wybierzCertyfikat(process.env.LIVEPL_PODPIS || (probna ? undefined : 'certum'));
// certyfikat bywa widoczny także po wygaśnięciu sesji SimplySign: próbny podpis od razu mówi, czy trzeba się zalogować
sprawdzSesje(certyfikat);
krok(certyfikat ? `podpis: ${certyfikat.opis}` : 'bez podpisu (próbna budowa; LIVEPL_PODPIS=certum włącza podpis)');
rmSync(robocze, { recursive: true, force: true });
mkdirSync(program, { recursive: true });

// 1. silnik (bez electron.exe, który dostaje naszą nazwę, i bez domyślnej aplikacji Electron)
krok('kopiuję silnik…');
for (const nazwa of readdirSync(silnik)) {
  if (nazwa === 'electron.exe') continue;
  cpSync(join(silnik, nazwa), join(program, nazwa), { recursive: true });
}
rmSync(join(program, 'resources', 'default_app.asar'), { force: true });

// 2. LivePL Connect.exe z ikoną i opisem firmy. Firma: Live Production; prawa autorskie zgadzają się
//    z certyfikatem Certum Open Source (Karol Kowalski); program jest na licencji MIT (LivePL-RMM\LICENSE)
krok('przygotowuję LivePL Connect.exe…');
const FIRMA = 'Live Production';
const PRAWA = `Copyright © ${new Date().getFullYear()} Live Production Karol Kowalski (licencja MIT)`;
const daneWersji = (opis, plikExe) => [
  '--set-file-version', wersja,
  '--set-product-version', wersja,
  '--set-version-string', 'CompanyName', FIRMA,
  '--set-version-string', 'FileDescription', opis,
  '--set-version-string', 'ProductName', 'LivePL Connect',
  '--set-version-string', 'InternalName', opis,
  '--set-version-string', 'OriginalFilename', plikExe,
  '--set-version-string', 'LegalCopyright', PRAWA
];
const exe = join(program, 'LivePL Connect.exe');
copyFileSync(join(silnik, 'electron.exe'), exe);
execFileSync(rcedit, [exe, '--set-icon', join(katalog, 'assets', 'icon.ico'), ...daneWersji('LivePL Connect', 'LivePL Connect.exe')], { stdio: 'inherit' });

// 3. program (resources/app) i pomocnik (resources/bin)
krok('kopiuję program…');
const app = join(program, 'resources', 'app');
mkdirSync(app, { recursive: true });
writeFileSync(join(app, 'package.json'), JSON.stringify({
  name: pakiet.name,
  productName: 'LivePL Connect',
  version: wersja,
  description: pakiet.description,
  author: pakiet.author,
  license: pakiet.license,
  main: 'src/start.js'
}, null, 2));
for (const nazwa of ['src', 'ui', 'assets']) cpSync(join(katalog, nazwa), join(app, nazwa), { recursive: true });
// nasza licencja przy programie (resources\app\LICENSE); LICENSE w głównym folderze to licencja Electrona i zostaje
copyFileSync(licencja, join(app, 'LICENSE'));
mkdirSync(join(program, 'resources', 'bin'), { recursive: true });
const host = join(program, 'resources', 'bin', 'host.exe');
copyFileSync(hostExe, host);
execFileSync(rcedit, [host, ...daneWersji('LivePL Connect (pomocnik)', 'host.exe')], { stdio: 'inherit' });

// 3a. podpis przed spakowaniem: LivePL Connect.exe, host.exe i każdy inny niepodpisany .exe/.dll/.node
//     z silnika (Windows 11 z Inteligentnym sterowaniem aplikacjami potrafi zablokować niepodpisaną bibliotekę).
//     Pliki z cudzym podpisem (np. d3dcompiler_47.dll od Microsoftu) zostają bez zmian.
if (certyfikat) {
  const doPodpisu = [];
  const szukaj = (d) => {
    for (const n of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, n.name);
      if (n.isDirectory()) szukaj(p);
      else if (/\.(exe|dll|node)$/i.test(n.name) && !maPodpis(p)) doPodpisu.push(p);
    }
  };
  szukaj(program);
  krok(`podpisuję ${doPodpisu.length} plików programu…`);
  podpisz(doPodpisu, certyfikat);
}

// 4. paczka ZIP
krok('pakuję (to chwilę trwa)…');
const zip = join(robocze, 'paczka.zip');
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  'Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:LPC_Z, $env:LPC_DO, [IO.Compression.CompressionLevel]::Optimal, $false)'],
{ env: { ...process.env, LPC_Z: program, LPC_DO: zip }, stdio: 'inherit' });

// 5. program startowy z paczką w środku
krok('kompiluję instalator…');
mkdirSync(naSerwer, { recursive: true });
const csc = join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const wynik = join(wyjscie, plik);
const zrodla = join(katalog, 'narzedzia', 'instalator');
// wersja w danych pliku instalatora (Właściwości → Szczegóły); reszta danych jest w Uruchom.cs
const wersjaCs = join(robocze, 'Wersja.cs');
writeFileSync(wersjaCs, `[assembly: System.Reflection.AssemblyFileVersion("${wersja}.0")]\n`
  + `[assembly: System.Reflection.AssemblyVersion("${wersja}.0")]\n`
  + `[assembly: System.Reflection.AssemblyInformationalVersion("${wersja}")]\n`);
execFileSync(csc, [
  '/nologo', '/target:winexe', '/optimize+', '/codepage:65001',
  `/out:${wynik}`,
  `/win32icon:${join(katalog, 'assets', 'icon.ico')}`,
  `/win32manifest:${join(zrodla, 'app.manifest')}`,
  `/resource:${zip},paczka.zip`,
  `/resource:${join(katalog, 'assets', 'logo.png')},logo.png`,
  '/r:System.IO.Compression.dll', '/r:System.IO.Compression.FileSystem.dll',
  '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.Core.dll',
  join(zrodla, 'Uruchom.cs'), wersjaCs
], { stdio: 'inherit' });
// 5a. podpis samego instalatora (przed liczeniem sum w kroku 6)
podpisz([wynik], certyfikat);

// 6. opis wydania dla automatycznych aktualizacji (sumy liczone z gotowego instalatora, więc
//    każda zmiana pliku, także podpis, musi się odbyć przed tym krokiem)
const zawartosc = readFileSync(wynik);
const sha256 = createHash('sha256').update(zawartosc).digest('hex');
const data = new Date().toISOString();
const opisWydania = { wersja, plik, sha256, rozmiar: zawartosc.length, data };
writeFileSync(join(naSerwer, 'wersja.json'), JSON.stringify(opisWydania, null, 2));
// latest.yml czyta stara wersja 0.4.1 (electron-updater): dzięki temu sama przejdzie na nowy
// instalator (uruchamia go z „--updated /S”, a ten instaluje bez pytania)
const sha512 = createHash('sha512').update(zawartosc).digest('base64');
writeFileSync(join(naSerwer, 'latest.yml'), [
  `version: ${wersja}`,
  'files:',
  `  - url: ${plik}`,
  `    sha512: ${sha512}`,
  `    size: ${zawartosc.length}`,
  `path: ${plik}`,
  `sha512: ${sha512}`,
  `releaseDate: '${data}'`,
  ''
].join('\n'));

rmSync(robocze, { recursive: true, force: true });
const podpis = zapiszCzytaj(wyjscie, opisWydania, zmiany);
console.log(`Gotowe: ${wynik} (${Math.round(statSync(wynik).size / 1048576)} MB, podpis: ${podpis.stan})`);
console.log(`  sha256 ${sha256}`);
