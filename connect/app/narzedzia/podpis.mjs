// KOPIA narzedzi przeglądarki LivePL (przegladarka-livepl/narzedzia/podpis.mjs); poprawki wprowadzaj w obu miejscach.
// Podpis Authenticode plików .exe certyfikatem do podpisywania kodu z magazynu Windows (konto, Osobiste).
// Certyfikat Certum „w chmurze” jest tam widoczny, gdy działa i jest zalogowany SimplySign Desktop;
// klucz zostaje u Certum, a logowanie (mail i kod z telefonu) robi właściciel certyfikatu.
// Podpis ze znacznikiem czasu Certum, więc zostaje ważny także po wygaśnięciu certyfikatu.
//
// LIVEPL_PODPIS:  (brak) – bez podpisu
//                 certum – jedyny ważny certyfikat do podpisywania kodu od Certum z kluczem
//                 <odcisk SHA-1> – ten konkretny certyfikat
//
// Po każdym podpisie sprawdzamy, że plik ma dokładnie jeden podpis, ważny i ze znacznikiem czasu.
// (Set-AuthenticodeSignature potrafi przy dużym pliku najpierw zapisać podpis bez znacznika czasu, a potem
// dopisać drugi zamiast go zastąpić; Windows uznaje wtedy plik za zmieniony.) Gdy coś się nie zgadza,
// przywracamy plik do stanu sprzed podpisu i próbujemy jeszcze raz.
import { execFileSync } from 'node:child_process';
import { openSync, readSync, writeSync, closeSync, ftruncateSync, fstatSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ZNACZNIK_CZASU = 'http://time.certum.pl';
const PROBY = 3;
// Certyfikat Certum zostaje w magazynie Windows także po wygaśnięciu sesji SimplySign Desktop, a podpis
// wtedy się nie udaje albo wisi. Dlatego sesję sprawdza próbny podpis, a każdy podpis ma limit czasu.
export const ZALOGUJ = 'Podpis Certum teraz nie działa: sesja SimplySign Desktop wygasła albo się nie połączyła. '
  + 'Zaloguj się w SimplySign Desktop (kod z aplikacji SimplySign w telefonie) i uruchom jeszcze raz.';
// sam start PowerShella przy obciążonym komputerze potrafi trwać blisko minutę (16.11.2026: 50 s)
const LIMIT_PROBY = 180_000;
const LIMIT_PODPISU = 300_000;

function powershell(skrypt, env = {}, limit = 0) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', skrypt],
    { env: { ...process.env, ...env }, encoding: 'utf8', timeout: limit, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// próbny podpis małego skryptu .ps1 w folderze tymczasowym (bez znacznika czasu: sprawdzamy tylko dostęp
// do klucza w chmurze); true, gdy sesja SimplySign działa
export function sesjaDziala(certyfikat) {
  const plik = join(tmpdir(), `livepl-proba-podpisu-${process.pid}-${Date.now()}.ps1`);
  writeFileSync(plik, '# proba podpisu LivePL\r\n');
  try {
    return powershell(`
      $c = Get-Item ('Cert:\\CurrentUser\\My\\' + $env:LIVEPL_PODPIS_ODCISK)
      '' + (Set-AuthenticodeSignature -FilePath $env:LIVEPL_PODPIS_PLIK -Certificate $c -HashAlgorithm SHA256).Status`,
    { LIVEPL_PODPIS_ODCISK: certyfikat.odcisk, LIVEPL_PODPIS_PLIK: plik }, LIMIT_PROBY) === 'Valid';
  } catch {
    return false;
  } finally {
    rmSync(plik, { force: true });
  }
}

// rzuca błąd z prośbą o zalogowanie, gdy podpis teraz nie zadziała
export function sprawdzSesje(certyfikat) {
  if (certyfikat && !sesjaDziala(certyfikat)) throw new Error(ZALOGUJ);
}

// zwraca { odcisk, opis } albo null (bez podpisu)
export function wybierzCertyfikat(wybor = process.env.LIVEPL_PODPIS) {
  if (!wybor) return null;
  const lista = [].concat(JSON.parse(powershell(`
    $c = @(Get-ChildItem Cert:\\CurrentUser\\My -CodeSigningCert | Where-Object { $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date) } |
      ForEach-Object { [pscustomobject]@{ odcisk = $_.Thumbprint; wystawca = $_.Issuer; podmiot = $_.Subject; do = $_.NotAfter.ToString('yyyy-MM-dd') } })
    ConvertTo-Json -InputObject $c -Compress`) || '[]'));
  const pasujace = /^[0-9a-f]{40}$/i.test(wybor)
    ? lista.filter((c) => c.odcisk.toLowerCase() === wybor.toLowerCase())
    : lista.filter((c) => /certum/i.test(c.wystawca));
  if (pasujace.length !== 1) {
    throw new Error(pasujace.length === 0
      ? 'Nie widzę certyfikatu do podpisywania kodu. Czy SimplySign Desktop działa i jest zalogowany?'
      : 'Jest kilka certyfikatów Certum; podaj odcisk w LIVEPL_PODPIS: ' + pasujace.map((c) => c.odcisk).join(', '));
  }
  const c = pasujace[0];
  return { odcisk: c.odcisk, opis: `${c.podmiot.split(',')[0]} (${c.wystawca.split(',')[0]}, do ${c.do})` };
}

// położenie wpisu „tabela certyfikatów” (katalog danych nr 4) w nagłówku PE
function wpisPodpisu(fd) {
  const b = Buffer.alloc(4096);
  readSync(fd, b, 0, b.length, 0);
  if (b.toString('ascii', 0, 2) !== 'MZ') throw new Error('to nie jest plik .exe');
  const pe = b.readUInt32LE(0x3c);
  if (b.toString('ascii', pe, pe + 4) !== 'PE\0\0') throw new Error('brak nagłówka PE');
  const opt = pe + 24;
  const magic = b.readUInt16LE(opt);
  const katalogi = opt + (magic === 0x20b ? 112 : 96);
  const pole = katalogi + 4 * 8;
  return { pole, przesuniecie: b.readUInt32LE(pole), rozmiar: b.readUInt32LE(pole + 4), dlugosc: fstatSync(fd).size };
}

function stanPodpisu(plik) {
  const fd = openSync(plik, 'r');
  try { return wpisPodpisu(fd); } finally { closeSync(fd); }
}

const czekaj = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// cofnięcie do stanu sprzed podpisu: obcięcie pliku i wyzerowanie wpisu tabeli certyfikatów.
// Zaraz po podpisie Windows (najpewniej Defender) potrafi trzymać duży plik zmapowany i odrzuca skrócenie
// (ftruncate: UNKNOWN, errno -4094); po kilkudziesięciu sekundach przechodzi, więc ponawiamy do 90 s.
function przywroc(plik, dlugosc) {
  const koniec = Date.now() + 90_000;
  for (;;) {
    try {
      const fd = openSync(plik, 'r+');
      try {
        const w = wpisPodpisu(fd);
        writeSync(fd, Buffer.alloc(8), 0, 8, w.pole);
        ftruncateSync(fd, dlugosc);
      } finally { closeSync(fd); }
      return;
    } catch (e) {
      if (!['UNKNOWN', 'EBUSY', 'EPERM', 'EACCES'].includes(e.code) || Date.now() > koniec) throw e;
      czekaj(2000);
    }
  }
}

function podpiszJeden(plik, certyfikat) {
  const przed = stanPodpisu(plik);
  if (przed.przesuniecie !== 0) throw new Error(`${plik} ma już podpis; podpisujemy tylko świeżo zbudowane pliki`);
  for (let proba = 1; proba <= PROBY; proba++) {
    let blad = null;
    try {
      const wynik = powershell(`
        $c = Get-Item ('Cert:\\CurrentUser\\My\\' + $env:LIVEPL_PODPIS_ODCISK)
        $s = Set-AuthenticodeSignature -FilePath $env:LIVEPL_PODPIS_PLIK -Certificate $c -HashAlgorithm SHA256 -TimestampServer '${ZNACZNIK_CZASU}' -IncludeChain NotRoot
        $spr = Get-AuthenticodeSignature -FilePath $env:LIVEPL_PODPIS_PLIK
        '' + $s.Status + '|' + $spr.Status + '|' + [bool]$spr.TimeStamperCertificate`,
      { LIVEPL_PODPIS_ODCISK: certyfikat.odcisk, LIVEPL_PODPIS_PLIK: plik }, LIMIT_PODPISU);
      const [stan, sprawdzenie, znacznik] = wynik.split('|');
      const po = stanPodpisu(plik);
      const jeden = po.przesuniecie >= przed.dlugosc && po.przesuniecie - przed.dlugosc < 8 && po.przesuniecie + po.rozmiar === po.dlugosc;
      if (stan === 'Valid' && sprawdzenie === 'Valid' && znacznik === 'True' && jeden) {
        console.log(`    podpisano: ${plik.split(/[\\/]/).pop()}${proba > 1 ? ` (za ${proba}. razem)` : ''}`);
        return;
      }
      blad = `podpis ${stan}, sprawdzenie ${sprawdzenie}, znacznik czasu ${znacznik}, jeden podpis ${jeden}`;
    } catch (e) {
      blad = e.message.split('\n').filter(Boolean).slice(-3).join(' ');
      // błąd PowerShella albo przekroczony czas: jeśli to wygasła sesja, nie ma sensu ponawiać
      if (!sesjaDziala(certyfikat)) {
        przywroc(plik, przed.dlugosc);
        throw new Error(ZALOGUJ);
      }
    }
    console.log(`    podpis ${plik.split(/[\\/]/).pop()} nieudany (${blad})${proba < PROBY ? ', cofam i próbuję jeszcze raz' : ''}`);
    przywroc(plik, przed.dlugosc);
    if (proba < PROBY) czekaj(5000);
  }
  throw new Error(`Nie udało się podpisać ${plik} po ${PROBY} próbach`);
}

// czy plik .exe/.dll ma już jakiś podpis (np. Microsoftu na d3dcompiler_47.dll) – takich nie podpisujemy
export function maPodpis(plik) {
  return stanPodpisu(plik).przesuniecie !== 0;
}

// zdjęcie istniejącego podpisu (np. starego, z własnego certyfikatu), żeby podpisać ten sam program od nowa;
// kod programu się nie zmienia: znika tylko tabela certyfikatów z końca pliku i wpis o niej w nagłówku
export function zdejmijPodpis(plik) {
  const w = stanPodpisu(plik);
  if (w.przesuniecie === 0) return false;
  if (w.przesuniecie + w.rozmiar !== w.dlugosc) throw new Error(`${plik}: podpis nie leży na końcu pliku, nie zdejmuję go`);
  przywroc(plik, w.przesuniecie);
  return true;
}

export function podpisz(pliki, certyfikat) {
  if (!certyfikat) return;
  for (const plik of pliki) podpiszJeden(plik, certyfikat);
}
