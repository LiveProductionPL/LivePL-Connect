// CZYTAJ.txt w folderze wydania (..\Wydania\LivePL-Connect\<wersja> obok folderu z kodem): co to za pliki,
// suma SHA-256, czy instalator jest podpisany, co idzie na serwer i co nowego.
// Używa go zrob-instalator.mjs; można też ręcznie (np. dla starszej wersji):
//   node narzedzia/czytaj.mjs <folder-wydania> "zmiana 1" "zmiana 2"   (dane bierze z na-serwer\wersja.json)
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIESIACE = ['stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca', 'lipca', 'sierpnia',
  'września', 'października', 'listopada', 'grudnia'];
const dzien = (iso) => { const d = new Date(iso); return `${d.getDate()} ${MIESIACE[d.getMonth()]} ${d.getFullYear()}`; };
const cn = (dn) => (/CN=("[^"]+"|[^,]+)/.exec(dn || '') || [])[1]?.replace(/"/g, '') || dn;

// stan podpisu Authenticode instalatora (sam odczyt, niczego nie podpisuje)
export function podpisPliku(plik) {
  const wynik = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$s = Get-AuthenticodeSignature -LiteralPath $env:LPC_PLIK
     '' + $s.Status + '|' + $s.SignerCertificate.Subject + '|' + $s.SignerCertificate.Issuer + '|' + [bool]$s.TimeStamperCertificate`],
  { env: { ...process.env, LPC_PLIK: plik }, encoding: 'utf8' }).trim();
  const [stan, podmiot, wystawca, znacznik] = wynik.split('|');
  return { stan, podmiot: cn(podmiot), wystawca: cn(wystawca), znacznik: znacznik === 'True' };
}

export function zapiszCzytaj(folder, { wersja, plik, sha256, rozmiar, data }, zmiany = []) {
  const p = podpisPliku(join(folder, plik));
  const mb = rozmiar < 10 * 1048576 ? (rozmiar / 1048576).toFixed(1).replace('.', ',') : String(Math.round(rozmiar / 1048576));
  const podpis = p.stan === 'Valid'
    ? [`Instalator jest podpisany cyfrowo (wydawca: ${p.podmiot}, certyfikat ${p.wystawca})` +
        (p.znacznik ? ',\nze znacznikiem czasu, więc podpis zostaje ważny także po wygaśnięciu certyfikatu.' : ', bez znacznika czasu.')]
    : p.stan === 'NotSigned'
      ? ['Instalator nie jest podpisany cyfrowo. Windows może pokazać „Nieznany wydawca” i niebieskie okno',
        'SmartScreen: wtedy Więcej informacji, a potem Uruchom mimo to.']
      : [`Podpis instalatora: ${p.stan}. Sprawdź:  Get-AuthenticodeSignature .\\${plik}`];
  const tytul = `LivePL Connect ${wersja} (${dzien(data)})`;
  const tekst = [
    tytul,
    '='.repeat(tytul.length),
    '',
    'DO PRZENOSZENIA NA INNE KOMPUTERY',
    `  ${plik}   ${mb} MB   cały program w jednym pliku, instaluje się bez internetu`,
    '  (Windows 10 bez składnika Microsoft Edge WebView2: instalator sam go pobierze od Microsoftu)',
    '',
    ...podpis,
    'Po instalacji LivePL Connect sam się aktualizuje z aktualizacje.livepl.eu/connect.',
    '',
    'Suma SHA-256 (ta sama jest na app.livepl.eu w części „Czy plik na pewno jest od nas?”):',
    `  ${plik}  ${sha256}`,
    `Sprawdzenie w PowerShell:  Get-FileHash .\\${plik}`,
    '',
    'NA SERWER',
    '  instalator z wierzchu   -> aktualizacje.livepl.eu/connect/  oraz  app.livepl.eu/pobierz/',
    '  na-serwer\\wersja.json   -> aktualizacje.livepl.eu/connect/  (stąd zainstalowane Connecty wiedzą',
    '                             o nowej wersji i sprawdzają sumę pobranego instalatora)',
    '  na-serwer\\latest.yml    -> aktualizacje.livepl.eu/connect/  (dla najstarszych Connectów 0.4.1)',
    '  Instalatora nie ma drugi raz w na-serwer\\, żeby nie zajmował miejsca podwójnie.',
    '  Wgrywa to i poprawia wersję, rozmiar i sumę na app.livepl.eu skrypt',
    '  LivePL-RMM\\connect\\deploy\\wydanie-na-serwerze.sh (opis w LivePL-RMM\\connect\\deploy\\WYDANIE.md).',
    '  Nie wgrywaj innej treści pod tą samą nazwą pliku: zainstalowane Connecty odrzuciłyby ją przez złą sumę.',
    ...(zmiany.length ? ['', 'Co nowego:', ...zmiany.map((z) => '  - ' + z)] : []),
    ''
  ].join('\r\n');
  writeFileSync(join(folder, 'CZYTAJ.txt'), '﻿' + tekst);
  return p;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const folder = resolve(process.argv[2] || '.');
  const w = JSON.parse(readFileSync(join(folder, 'na-serwer', 'wersja.json'), 'utf8'));
  const p = zapiszCzytaj(folder, w, process.argv.slice(3));
  console.log(`CZYTAJ.txt: LivePL Connect ${w.wersja}, podpis: ${p.stan}`);
}
