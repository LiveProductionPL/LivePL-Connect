'use strict';

// Okno instalatora LivePL Connect: powitanie → postęp → gotowe (albo odinstalowanie).
// W trybie aktualizacji od razu pokazuje postęp i na końcu sam uruchamia program.

const $ = (s) => document.querySelector(s);
const I = window.instalator;

$('#minimalizuj').innerHTML = window.ikona('minus');
$('#zamknij').innerHTML = window.ikona('zamknij');
document.querySelectorAll('[data-ik]').forEach((el) => { el.innerHTML = window.ikona(el.dataset.ik); });
$('#gotowe-ik').innerHTML = window.ikona('ok');
$('#blad-ik').innerHTML = window.ikona('krzyzyk');

let S = null;
let trwa = false;

function pokaz(id) {
  document.querySelectorAll('.ekran').forEach((e) => { e.hidden = e.id !== id; });
  const glowny = document.querySelector('#' + id + ' .przycisk.glowny');
  if (glowny) setTimeout(() => glowny.focus(), 30);
}

function porownaj(a, b) {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}

async function start() {
  S = await I.stan();
  $('#wersja').textContent = 'wersja ' + S.wersja;
  if (S.tryb === 'odinstaluj') {
    $('#tytul-okna').textContent = 'Odinstaluj LivePL Connect';
    if (S.zainstalowana && S.zainstalowana !== 'starsza') $('#odinstaluj-wstep').textContent = `LivePL Connect ${S.zainstalowana} zniknie z tego komputera razem ze skrótami w menu Start i na pulpicie.`;
    $('#odinstaluj-dziala').hidden = !S.dziala;
    pokaz('ekran-odinstaluj');
    return;
  }
  if (S.aktualizacja) {
    instaluj(true);
    return;
  }
  if (S.zainstalowana) {
    const r = S.zainstalowana === 'starsza' ? 1 : porownaj(S.wersja, S.zainstalowana);
    $('#start-tytul').textContent = r > 0 ? `Zaktualizuj LivePL Connect do ${S.wersja}` : r === 0 ? 'Zainstaluj LivePL Connect ponownie' : `Zainstaluj LivePL Connect ${S.wersja}`;
    $('#start-wstep').textContent = r > 0
      ? 'Na tym komputerze jest starsza wersja. Twoje ustawienia i ID komputera zostaną.'
      : r === 0 ? `Ta wersja (${S.wersja}) już jest zainstalowana. Instalacja odświeży pliki programu; ustawienia zostaną.`
        : `Na tym komputerze jest nowsza wersja (${S.zainstalowana}). Zainstalujesz starszą ${S.wersja}; ustawienia zostaną.`;
    $('#start-instaluj').textContent = r > 0 ? 'Zaktualizuj' : 'Zainstaluj';
  }
  $('#start-dziala').hidden = !S.dziala;
  $('#start-gdzie').textContent = 'Tylko dla Ciebie, bez uprawnień administratora · ' + S.cel + (S.test ? ' (test)' : '');
  pokaz('ekran-start');
}

I.naPostep((p) => {
  const proc = Math.round(p.ulamek * 100);
  $('#postep-pasek').style.width = proc + '%';
  $('#postep-procent').textContent = proc + '%';
  if (p.opis) $('#postep-opis').textContent = p.opis;
});

async function instaluj(automatycznie) {
  if (trwa) return;
  trwa = true;
  const aktualizacja = automatycznie === true || $('#start-instaluj').textContent === 'Zaktualizuj';
  const pulpit = automatycznie === true ? false : $('#opcja-pulpit').checked;
  $('#postep-tytul').textContent = aktualizacja ? 'Aktualizuję LivePL Connect…' : 'Instaluję LivePL Connect…';
  pokaz('ekran-postep');
  const w = await I.instaluj({ pulpit });
  trwa = false;
  if (!w.ok) {
    $('#blad-opis').textContent = w.blad;
    $('#blad-ponow').onclick = () => instaluj(automatycznie);
    pokaz('ekran-blad');
    return;
  }
  $('#gotowe-tytul').textContent = aktualizacja ? 'Zaktualizowano LivePL Connect' : 'LivePL Connect jest gotowy';
  const wroci = automatycznie === true && S.uruchomPo !== false;
  $('#gotowe-opis').textContent = automatycznie === true
    ? `Wersja ${S.wersja} jest zainstalowana.` + (wroci ? ' Uruchamiam program…' : ' Uruchomisz ją ze skrótu LivePL Connect.')
    : 'Znajdziesz go w menu Start' + (pulpit ? ' i na pulpicie.' : '.') + ' Miłej pracy!';
  $('#gotowe-uruchom').hidden = false;
  pokaz('ekran-gotowe');
  if (wroci) setTimeout(() => I.uruchom(), 1200);
  else if (automatycznie === true) setTimeout(() => I.zamknij(), 4000);
}

async function odinstaluj() {
  if (trwa) return;
  trwa = true;
  const dane = $('#opcja-dane').checked;
  $('#postep-tytul').textContent = 'Odinstalowuję LivePL Connect…';
  pokaz('ekran-postep');
  const w = await I.odinstaluj({ dane });
  trwa = false;
  if (!w.ok) {
    $('#blad-opis').textContent = w.blad;
    $('#blad-ponow').onclick = odinstaluj;
    pokaz('ekran-blad');
    return;
  }
  $('#gotowe-tytul').textContent = 'LivePL Connect został odinstalowany';
  $('#gotowe-opis').textContent = 'Pliki programu znikną po zamknięciu tego okna.' + (dane ? ' Ustawienia zostały usunięte.' : ' Ustawienia i ID komputera zostały, na wypadek ponownej instalacji.');
  $('#gotowe-uruchom').hidden = true;
  pokaz('ekran-gotowe');
}

$('#start-instaluj').addEventListener('click', () => instaluj(false));
$('#odinstaluj-tak').addEventListener('click', odinstaluj);
$('#gotowe-uruchom').addEventListener('click', () => I.uruchom());
for (const id of ['#zamknij', '#start-anuluj', '#odinstaluj-anuluj', '#gotowe-zamknij', '#blad-zamknij']) {
  $(id).addEventListener('click', () => { if (!trwa) I.zamknij(); });
}
$('#minimalizuj').addEventListener('click', () => I.minimalizuj());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !trwa) I.zamknij(); });

start();
