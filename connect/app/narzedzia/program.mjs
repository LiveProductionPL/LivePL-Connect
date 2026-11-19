// Składa gotowy folder programu LivePL Connect (bez Electrona):
//   LivePL Connect.exe   okno i logika programu (C#, .NET Framework 4.8 wbudowany w Windows 10 i 11)
//   Microsoft.Web.WebView2.*.dll, WebView2Loader.dll   biblioteki Microsoftu do silnika WebView2 (Edge)
//   host.exe             pomocnik w Go (ekran, mysz, klawiatura, połączenie)
//   ui\, assets\         te same strony i ikony co wcześniej
// Kompilator C# jest w każdym Windows (Microsoft.NET\Framework64\v4.0.30319\csc.exe), więc nie trzeba
// instalować Visual Studio. Biblioteki WebView2 pobieramy raz z NuGet (paczka Microsoftu o znanej sumie)
// i trzymamy w %LOCALAPPDATA%\LivePL-Connect-budowanie.
//   node narzedzia/program.mjs <folder>     (sam folder programu, np. do uruchomienia na próbę)
import { cpSync, copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { get } from 'node:https';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const katalog = join(dirname(fileURLToPath(import.meta.url)), '..');
export const WEBVIEW2 = { wersja: '1.0.4191.47', sha256: 'f492bbf547d0da329553b6727435b677579b1e9f91cc9e4a1ad029366d5f23d0' };
const BIBLIOTEKI = [
  ['lib/net462/Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.Core.dll'],
  ['lib/net462/Microsoft.Web.WebView2.WinForms.dll', 'Microsoft.Web.WebView2.WinForms.dll'],
  ['runtimes/win-x64/native/WebView2Loader.dll', 'WebView2Loader.dll']
];

const ps = (polecenie, env = {}) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', polecenie],
  { env: { ...process.env, ...env }, encoding: 'utf8' });

function pobierz(adres, plik, przekierowania = 5) {
  return new Promise((ok, zle) => {
    get(adres, { headers: { 'User-Agent': 'LivePL-Connect-budowanie' } }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && przekierowania > 0) {
        r.resume();
        return pobierz(new URL(r.headers.location, adres).href, plik, przekierowania - 1).then(ok, zle);
      }
      if (r.statusCode !== 200) { r.resume(); return zle(new Error(`HTTP ${r.statusCode} dla ${adres}`)); }
      const f = createWriteStream(plik);
      r.pipe(f);
      f.on('finish', () => f.close(ok));
      f.on('error', zle);
    }).on('error', zle);
  });
}

// biblioteki WebView2 z NuGet: paczka o znanej sumie i każdy plik z ważnym podpisem Microsoftu
export async function bibliotekiWebView2() {
  const pamiec = join(process.env.LOCALAPPDATA || '', 'LivePL-Connect-budowanie', 'webview2-' + WEBVIEW2.wersja);
  const gotowe = BIBLIOTEKI.every(([, n]) => existsSync(join(pamiec, n)));
  if (!gotowe) {
    mkdirSync(pamiec, { recursive: true });
    const paczka = join(pamiec, 'pakiet.nupkg');
    if (!existsSync(paczka)) {
      const adres = `https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${WEBVIEW2.wersja}/microsoft.web.webview2.${WEBVIEW2.wersja}.nupkg`;
      console.log('  pobieram biblioteki WebView2 ' + WEBVIEW2.wersja + ' z NuGet…');
      await pobierz(adres, paczka + '.czesc');
      const suma = createHash('sha256').update(readFileSync(paczka + '.czesc')).digest('hex');
      if (suma !== WEBVIEW2.sha256) { rmSync(paczka + '.czesc', { force: true }); throw new Error('Paczka WebView2 ma inną sumę niż oczekiwana: ' + suma); }
      execFileSync('cmd.exe', ['/d', '/c', 'move', '/y', paczka + '.czesc', paczka], { stdio: 'ignore' });
    }
    ps(`Add-Type -AssemblyName System.IO.Compression.FileSystem; $z = [IO.Compression.ZipFile]::OpenRead($env:LPC_P);
      try { foreach ($w in $env:LPC_W.Split('|')) { $p = $w.Split('>'); $e = $z.GetEntry($p[0]); if (-not $e) { throw "brak $($p[0])" }
        [IO.Compression.ZipFileExtensions]::ExtractToFile($e, (Join-Path $env:LPC_D $p[1]), $true) } } finally { $z.Dispose() }`,
    { LPC_P: paczka, LPC_D: pamiec, LPC_W: BIBLIOTEKI.map(([z, n]) => z + '>' + n).join('|') });
    ps(`Add-Type -AssemblyName System.IO.Compression.FileSystem; $z = [IO.Compression.ZipFile]::OpenRead($env:LPC_P);
      try { $e = $z.GetEntry('LICENSE.txt'); [IO.Compression.ZipFileExtensions]::ExtractToFile($e, (Join-Path $env:LPC_D 'LICENSE-WebView2.txt'), $true) } finally { $z.Dispose() }`,
    { LPC_P: paczka, LPC_D: pamiec });
  }
  // podpis Microsoftu sprawdzamy przy każdym budowaniu (plik w pamięci mógł się zmienić)
  const wynik = ps(`foreach ($n in $env:LPC_N.Split('|')) { $s = Get-AuthenticodeSignature (Join-Path $env:LPC_D $n);
    if ($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notlike 'CN=Microsoft Corporation,*') { "ZLY $n $($s.Status)" } }`,
  { LPC_D: pamiec, LPC_N: BIBLIOTEKI.map(([, n]) => n).join('|') }).trim();
  if (wynik) throw new Error('Biblioteki WebView2 bez ważnego podpisu Microsoftu: ' + wynik);
  return { folder: pamiec, pliki: BIBLIOTEKI.map(([, n]) => n), licencja: join(pamiec, 'LICENSE-WebView2.txt') };
}

export const csc = join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

// kompiluje LivePL Connect.exe i składa cały folder programu w `cel`
export async function zbudujProgram(cel, { wersja, hostExe, robocze }) {
  const wv = await bibliotekiWebView2();
  rmSync(cel, { recursive: true, force: true });
  mkdirSync(cel, { recursive: true });
  for (const n of wv.pliki) copyFileSync(join(wv.folder, n), join(cel, n));

  mkdirSync(robocze, { recursive: true });
  const wersjaCs = join(robocze, 'Wersja.cs');
  writeFileSync(wersjaCs, `[assembly: System.Reflection.AssemblyFileVersion("${wersja}.0")]\n`
    + `[assembly: System.Reflection.AssemblyVersion("${wersja}.0")]\n`
    + `[assembly: System.Reflection.AssemblyInformationalVersion("${wersja}")]\n`);
  const okno = join(katalog, 'okno');
  execFileSync(csc, [
    '/nologo', '/preferreduilang:en-US', '/target:winexe', '/optimize+', '/codepage:65001', '/warn:4', '/platform:x64', // x64 jak host.exe; na Windows ARM działa w emulacji x64 (jak wcześniej Electron)
    `/out:${join(cel, 'LivePL Connect.exe')}`,
    `/win32icon:${join(katalog, 'assets', 'icon.ico')}`,
    `/win32manifest:${join(okno, 'app.manifest')}`,
    `/resource:${join(okno, 'most.js')},most.js`,
    `/r:${join(cel, 'Microsoft.Web.WebView2.Core.dll')}`, `/r:${join(cel, 'Microsoft.Web.WebView2.WinForms.dll')}`,
    '/r:System.dll', '/r:System.Core.dll', '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll', '/r:System.Web.Extensions.dll',
    join(okno, 'Program.cs'), join(okno, 'Okno.cs'), join(okno, 'Aplikacja.cs'), join(okno, 'Instalator.cs'), join(okno, 'Systemowe.cs'), wersjaCs
  ], { stdio: 'inherit' });

  copyFileSync(hostExe, join(cel, 'host.exe'));
  for (const n of ['ui', 'assets']) cpSync(join(katalog, n), join(cel, n), { recursive: true });
  // licencje: nasza (MIT) i bibliotek Microsoftu (BSD), które leżą obok programu
  copyFileSync(join(katalog, '..', '..', 'LICENSE'), join(cel, 'LICENSE'));
  copyFileSync(wv.licencja, join(cel, 'LICENSE-WebView2.txt'));
  return cel;
}

// uruchomione bezpośrednio: sam folder programu (wersja z package.json, host z connect\host)
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cel = resolve(process.argv[2] || join(process.env.TEMP || '.', 'LivePL-Connect-program'));
  const wersja = JSON.parse(readFileSync(join(katalog, 'package.json'), 'utf8')).version;
  await zbudujProgram(cel, { wersja, hostExe: join(katalog, '..', 'host', 'host.exe'), robocze: join(cel, '..', 'LivePL-Connect-program-robocze') });
  console.log('Gotowe: ' + cel);
}
