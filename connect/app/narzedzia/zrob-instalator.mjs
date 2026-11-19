// Buduje LivePL-Connect-Instalator-<wersja>.exe: jeden plik z całym LivePL Connect (okno na silniku WebView2
// z Windows, pomocnik host.exe) i graficznym instalatorem w stylu LivePL, plus wersja.json dla automatycznych
// aktualizacji. Od 0.6.0 bez Electrona: instalator ma ok. 5 MB zamiast 116 MB.
// Bez dodatkowych narzędzi: program i instalator kompiluje kompilator C# wbudowany w Windows, paczkę ZIP robi
// .NET, opis pliku host.exe wpisuje rcedit, a host.exe buduje Go.
// Uruchom (najpierw zaloguj SimplySign Desktop):  npm run instalator -- --zmiana "co nowego" [--zmiana "…"]
//   Wynik:  ..\Wydania\LivePL-Connect\<wersja>\ obok folderu z kodem  (instalator, na-serwer\, CZYTAJ.txt)
//   Zawsze z podpisem Certum: instalator i każdy .exe/.dll w środku (pliki z podpisem Microsoftu zostają).
//   Próbnie gdzie indziej, bez podpisu:  npm run instalator -- --do %TEMP%\connect-proba
// Wersję bierze z package.json. Gotowej wersji nie nadpisuje: zainstalowane Connecty znają już sumę
// pliku o tej nazwie, więc każda zmiana to nowa wersja.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zapiszCzytaj } from './czytaj.mjs';
import { zbudujProgram, csc } from './program.mjs';
// podpis Certum: LIVEPL_PODPIS=certum (zalogowany SimplySign Desktop); bez tej zmiennej buduje bez podpisu
import { wybierzCertyfikat, sprawdzSesje, podpisz, maPodpis } from './podpis.mjs';

const katalog = join(dirname(fileURLToPath(import.meta.url)), '..');
const pakiet = JSON.parse(readFileSync(join(katalog, 'package.json'), 'utf8'));
const wersja = pakiet.version;
const zrodlaHosta = join(katalog, '..', 'host');
const licencja = join(katalog, '..', '..', 'LICENSE');
const argumenty = process.argv.slice(2);
const opcje = (nazwa) => argumenty.flatMap((a, i) => (a === nazwa && argumenty[i + 1] !== undefined ? [argumenty[i + 1]] : []));
const zmiany = opcje('--zmiana');
// katalog = LivePL\LivePL-RMM\connect\app, więc Wydania leżą trzy poziomy wyżej
const wyjscie = resolve(opcje('--do')[0] || join(katalog, '..', '..', '..', 'Wydania', 'LivePL-Connect', wersja));
const naSerwer = join(wyjscie, 'na-serwer');
const robocze = join(tmpdir(), 'LivePL-Connect-robocze'); // w %TEMP%, poza folderem z kodem
const program = join(robocze, 'LivePL Connect');
const krok = (t) => console.log('  ' + t);

// rcedit trzymamy przy narzędziach (kopia z pamięci electron-buildera)
const rcedit = [
  join(katalog, 'narzedzia', 'instalator', 'rcedit-x64.exe'),
  join(katalog, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe'),
  join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache', 'winCodeSign', 'winCodeSign-2.6.0', 'rcedit-x64.exe')
].find((p) => existsSync(p));
if (!rcedit) throw new Error('Nie znalazłem rcedit-x64.exe (npm i -D rcedit)');
if (!existsSync(csc)) throw new Error('Brak kompilatora C# z Windows: ' + csc);
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
mkdirSync(robocze, { recursive: true });

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

// 1. pomocnik host.exe zawsze z kodu (bez symboli do debugowania: 10 MB zamiast 15 MB)
krok('buduję pomocnika host.exe…');
const hostExe = join(robocze, 'host.exe');
execFileSync('go', ['build', '-trimpath', '-ldflags', '-s -w -H windowsgui', '-o', hostExe, '.'], { cwd: zrodlaHosta, stdio: 'inherit' });
execFileSync(rcedit, [hostExe, ...daneWersji('LivePL Connect (pomocnik)', 'host.exe')], { stdio: 'inherit' });

// 2. program: LivePL Connect.exe (C#), biblioteki WebView2 od Microsoftu, host.exe, strony i ikony
krok('kompiluję LivePL Connect.exe i składam program…');
await zbudujProgram(program, { wersja, hostExe, robocze: join(robocze, 'cs') });

// 2a. podpis przed spakowaniem: LivePL Connect.exe, host.exe i każdy inny niepodpisany .exe/.dll.
//     Biblioteki WebView2 mają podpis Microsoftu i zostają bez zmian.
if (certyfikat) {
  const doPodpisu = [];
  const szukaj = (d) => {
    for (const n of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, n.name);
      if (n.isDirectory()) szukaj(p);
      else if (/\.(exe|dll)$/i.test(n.name) && !maPodpis(p)) doPodpisu.push(p);
    }
  };
  szukaj(program);
  krok(`podpisuję ${doPodpisu.length} plików programu…`);
  podpisz(doPodpisu, certyfikat);
}

// 3. paczka ZIP
krok('pakuję…');
const zip = join(robocze, 'paczka.zip');
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  'Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:LPC_Z, $env:LPC_DO, [IO.Compression.CompressionLevel]::Optimal, $false)'],
{ env: { ...process.env, LPC_Z: program, LPC_DO: zip }, stdio: 'inherit' });

// 4. program startowy z paczką w środku
krok('kompiluję instalator…');
mkdirSync(naSerwer, { recursive: true });
const wynik = join(wyjscie, plik);
const zrodla = join(katalog, 'narzedzia', 'instalator');
// wersja w danych pliku instalatora (Właściwości → Szczegóły); reszta danych jest w Uruchom.cs
const wersjaCs = join(robocze, 'Wersja.cs');
writeFileSync(wersjaCs, `[assembly: System.Reflection.AssemblyFileVersion("${wersja}.0")]\n`
  + `[assembly: System.Reflection.AssemblyVersion("${wersja}.0")]\n`
  + `[assembly: System.Reflection.AssemblyInformationalVersion("${wersja}")]\n`);
execFileSync(csc, [
  '/nologo', '/preferreduilang:en-US', '/target:winexe', '/optimize+', '/codepage:65001',
  `/out:${wynik}`,
  `/win32icon:${join(katalog, 'assets', 'icon.ico')}`,
  `/win32manifest:${join(zrodla, 'app.manifest')}`,
  `/resource:${zip},paczka.zip`,
  `/resource:${join(katalog, 'assets', 'logo.png')},logo.png`,
  '/r:System.IO.Compression.dll', '/r:System.IO.Compression.FileSystem.dll',
  '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.Core.dll', '/r:System.dll',
  join(zrodla, 'Uruchom.cs'), wersjaCs
], { stdio: 'inherit' });
// 4a. podpis samego instalatora (przed liczeniem sum w kroku 5)
podpisz([wynik], certyfikat);

// 5. opis wydania dla automatycznych aktualizacji (sumy liczone z gotowego instalatora, więc
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
console.log(`Gotowe: ${wynik} (${(statSync(wynik).size / 1048576).toFixed(1)} MB, podpis: ${podpis.stan})`);
console.log(`  sha256 ${sha256}`);
