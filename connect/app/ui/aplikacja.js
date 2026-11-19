'use strict';

// Okno LivePL Connect: ID i hasło tego komputera, łączenie z innym komputerem
// i podgląd ze sterowaniem (WebRTC: obraz w kanale „video”, mysz i klawiatura w „ctrl”).

const $ = (s) => document.querySelector(s);
const L = window.lpc;
const ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

document.querySelectorAll('[data-ik]').forEach((el) => el.insertAdjacentHTML('afterbegin', window.ikona(el.dataset.ik)));

const formatuj = (id) => String(id || '').replace(/\D/g, '').slice(0, 9).replace(/(\d{3})(?=\d)/g, '$1 ');
const cyfry = (t) => String(t || '').replace(/\D/g, '');

let S = { serwer: '', domyslnySerwer: '' };

// ---------------------------------------------------------------- drobiazgi

let toastCzas = null;
function toast(tekst, ik = 'ok') {
  const t = $('#toast');
  t.innerHTML = window.ikona(ik) + '<span></span>';
  t.querySelector('span').textContent = tekst;
  t.hidden = false;
  t.style.animation = 'none';
  void t.offsetWidth;
  t.style.animation = '';
  clearTimeout(toastCzas);
  toastCzas = setTimeout(() => { t.hidden = true; }, 1800);
}

function komunikat(tekst, blad) {
  const k = $('#komunikat');
  k.className = 'komunikat' + (blad ? ' blad' : '');
  k.innerHTML = tekst && blad ? window.ikona('uwaga') : '';
  if (tekst) k.insertAdjacentText('beforeend', tekst);
}

// ---------------------------------------------------------------- ten komputer

const NAPISY = {
  online: ['Gotowy na połączenia', 'Online'],
  laczenie: ['Łączenie z serwerem…', 'Łączenie…'],
  blad: ['Brak połączenia z serwerem', 'Offline']
};

function pokazStatus(s) {
  S = { ...S, ...s };
  const id = $('#moje-id');
  const haslo = $('#moje-haslo');
  if (s.id) { id.textContent = formatuj(s.id); id.classList.remove('szkielet'); } else { id.textContent = '000 000 000'; id.classList.add('szkielet'); }
  if (s.haslo) { haslo.textContent = s.haslo; haslo.classList.remove('szkielet'); } else { haslo.textContent = '000000'; haslo.classList.add('szkielet'); }
  $('#kopiuj-id').disabled = !s.id;
  $('#kopiuj-haslo').disabled = !s.haslo;
  const napis = NAPISY[s.stan] || NAPISY.laczenie;
  const chip = $('#stan');
  chip.dataset.stan = s.stan;
  chip.querySelector('span').textContent = s.stan === 'blad' && s.komunikat ? s.komunikat : napis[0];
  chip.title = chip.querySelector('span').textContent;
  const marka = $('#status-marka');
  marka.dataset.stan = s.stan;
  marka.querySelector('span').textContent = napis[1];
  if (s.haslo) $('#nowe-haslo').classList.remove('kreci');
}

async function kopiuj(tekst, przycisk, co) {
  await L.kopiuj(tekst);
  toast(co);
  przycisk.classList.add('zrobione');
  przycisk.innerHTML = window.ikona('ok');
  setTimeout(() => { przycisk.classList.remove('zrobione'); przycisk.innerHTML = window.ikona('kopiuj'); }, 1400);
}

$('#kopiuj-id').addEventListener('click', (e) => kopiuj(cyfry(S.id), e.currentTarget, 'Skopiowano ID'));
$('#kopiuj-haslo').addEventListener('click', (e) => kopiuj(S.haslo, e.currentTarget, 'Skopiowano hasło'));
$('#nowe-haslo').addEventListener('click', () => {
  $('#nowe-haslo').classList.add('kreci');
  pokazStatus({ ...S, stan: 'laczenie', haslo: null });
  L.noweHaslo();
});

// ---------------------------------------------------------------- ostatnie połączenia

const KLUCZ_OSTATNICH = 'lpc-ostatnie';

function ostatnie() {
  try { return JSON.parse(localStorage.getItem(KLUCZ_OSTATNICH)) || []; } catch { return []; }
}

function zapiszOstatnie(lista) {
  try { localStorage.setItem(KLUCZ_OSTATNICH, JSON.stringify(lista.slice(0, 8))); } catch { /* bez pamięci też działa */ }
}

function kiedy(ms) {
  const d = new Date(ms);
  const teraz = new Date();
  const roznica = (teraz - d) / 60000;
  if (roznica < 1) return 'przed chwilą';
  if (roznica < 60) return Math.round(roznica) + ' min temu';
  const godz = d.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === teraz.toDateString()) return 'dziś, ' + godz;
  const wczoraj = new Date(teraz); wczoraj.setDate(teraz.getDate() - 1);
  if (d.toDateString() === wczoraj.toDateString()) return 'wczoraj, ' + godz;
  return d.toLocaleDateString('pl-PL', { day: 'numeric', month: 'short' }) + ', ' + godz;
}

function pokazOstatnie() {
  const lista = ostatnie();
  const ul = $('#ostatnie');
  ul.innerHTML = '';
  $('#pusto').hidden = lista.length > 0;
  for (const o of lista) {
    const li = document.createElement('li');
    li.title = 'Wpisz to ID';
    li.innerHTML = '<span class="ostatni-ik">' + window.ikona('monitor') + '</span>'
      + '<span class="ostatni-tekst"><b></b><span></span></span>'
      + '<button type="button" class="ostatni-usun" title="Usuń z listy">' + window.ikona('zamknij') + '</button>';
    li.querySelector('b').textContent = formatuj(o.id);
    li.querySelector('.ostatni-tekst span').textContent = kiedy(o.kiedy);
    li.addEventListener('click', () => {
      $('#rid').value = formatuj(o.id);
      $('#pw').value = '';
      $('#pw').focus();
      komunikat('Wpisz hasło, które widzi partner.');
    });
    li.querySelector('.ostatni-usun').addEventListener('click', (e) => {
      e.stopPropagation();
      zapiszOstatnie(ostatnie().filter((x) => x.id !== o.id));
      pokazOstatnie();
    });
    ul.appendChild(li);
  }
}

function dodajOstatni(id) {
  zapiszOstatnie([{ id, kiedy: Date.now() }, ...ostatnie().filter((x) => x.id !== id)]);
  pokazOstatnie();
}

// ---------------------------------------------------------------- łączenie z partnerem

let ws = null;
let pc = null;
let ctrl = null;
let hostConn = null;
let sesjaId = null;
let sesjaWidoczna = false;
let pierwszaKlatka = false;
let czasomierz = null;
let rozlaczCzas = null;
const klatki = new Map();

$('#rid').addEventListener('input', (e) => {
  e.target.value = formatuj(e.target.value);
  $('.pole-id').classList.remove('zle');
});
$('#pw').addEventListener('input', () => $('.pole-haslo').classList.remove('zle'));

$('#formularz').addEventListener('submit', (e) => {
  e.preventDefault();
  polacz(cyfry($('#rid').value), $('#pw').value.trim());
});

function trwaLaczenie(tak) {
  const b = $('#polacz');
  b.disabled = tak;
  b.classList.toggle('trwa', tak);
  b.querySelector('.napis').textContent = tak ? 'Łączę…' : 'Połącz';
}

function polacz(id, haslo) {
  if (ws || pc) return;
  if (id.length !== 9) { $('.pole-id').classList.add('zle'); komunikat('Wpisz 9-cyfrowe ID partnera.', true); $('#rid').focus(); return; }
  if (!haslo) { $('.pole-haslo').classList.add('zle'); komunikat('Wpisz hasło, które widzi partner.', true); $('#pw').focus(); return; }
  if (S.id && id === cyfry(S.id)) { $('.pole-id').classList.add('zle'); komunikat('To ID tego komputera. Wpisz ID partnera.', true); return; }

  sesjaId = id;
  pierwszaKlatka = false;
  trwaLaczenie(true);
  komunikat('Łączę z serwerem…');
  try {
    ws = new WebSocket(S.serwer);
  } catch {
    zakoncz('Nieprawidłowy adres serwera pośredniczącego (Ustawienia).');
    return;
  }
  ws.onopen = () => {
    komunikat('Czekam na odpowiedź komputera ' + formatuj(id) + '…');
    ws.send(JSON.stringify({ type: 'connect', id, password: haslo }));
  };
  ws.onmessage = sygnal;
  ws.onerror = () => zakoncz('Nie mogę połączyć się z serwerem pośredniczącym. Sprawdź internet.');
  ws.onclose = () => { ws = null; if (!pc && sesjaId) zakoncz('Serwer zakończył połączenie.'); };
  czasomierz = setTimeout(() => { if (!pierwszaKlatka) zakoncz('Partner nie odpowiada. Sprawdź ID i hasło i spróbuj ponownie.'); }, 25000);
}

async function sygnal(ev) {
  let m;
  try { m = JSON.parse(ev.data); } catch { return; }
  if (m.type === 'error') {
    const e = String(m.error || '');
    if (/no online host/i.test(e)) zakoncz('Komputer o tym ID jest teraz niedostępny.');
    else if (/wrong password/i.test(e)) { zakoncz('Nieprawidłowe hasło.'); $('.pole-haslo').classList.add('zle'); }
    else if (/too many/i.test(e)) zakoncz('Za dużo błędnych haseł. Tamten komputer przyjmie kolejną próbę za kilka minut.');
    else zakoncz('Nie udało się połączyć: ' + e);
    return;
  }
  if (m.type === 'offer') {
    hostConn = m.from;
    pc = new RTCPeerConnection({ iceServers: ICE });
    pc.onicecandidate = (e) => {
      if (e.candidate && ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'ice', to: hostConn, data: e.candidate.toJSON() }));
    };
    pc.onconnectionstatechange = () => {
      const st = pc ? pc.connectionState : 'closed';
      clearTimeout(rozlaczCzas);
      if (st === 'connected') otworzSesje();
      else if (st === 'failed') zakoncz('Nie udało się zestawić połączenia z partnerem (sieć może je blokować).');
      else if (st === 'disconnected') rozlaczCzas = setTimeout(() => zakoncz('Połączenie z partnerem zostało przerwane.'), 6000);
    };
    pc.ondatachannel = (e) => {
      const ch = e.channel;
      if (ch.label === 'video') { ch.binaryType = 'arraybuffer'; ch.onmessage = klatka; }
      else if (ch.label === 'ctrl') ctrl = ch;
    };
    await pc.setRemoteDescription(m.data);
    const odp = await pc.createAnswer();
    await pc.setLocalDescription(odp);
    ws.send(JSON.stringify({ type: 'answer', to: hostConn, data: odp }));
    komunikat('Zestawiam bezpośrednie połączenie…');
  } else if (m.type === 'ice' && pc) {
    try { await pc.addIceCandidate(m.data); } catch { /* spóźniony kandydat */ }
  }
}

function otworzSesje() {
  if (sesjaWidoczna) return;
  sesjaWidoczna = true;
  L.sesja(true); // w trakcie sesji aktualizacja w tle czeka
  dodajOstatni(sesjaId);
  $('#sesja-id').textContent = formatuj(sesjaId);
  $('#sesja-laczenie').hidden = pierwszaKlatka;
  $('#sesja').hidden = false;
  $('#ekran').focus();
}

function zakoncz(blad) {
  clearTimeout(czasomierz);
  clearTimeout(rozlaczCzas);
  const bylaSesja = sesjaWidoczna;
  try { if (pc) pc.close(); } catch { /* nic */ }
  try { if (ws) ws.close(); } catch { /* nic */ }
  pc = null; ws = null; ctrl = null; hostConn = null; sesjaId = null;
  sesjaWidoczna = false;
  if (bylaSesja) L.sesja(false);
  klatki.clear();
  if (document.body.classList.contains('pelny')) L.okno('pelny');
  $('#sesja').hidden = true;
  trwaLaczenie(false);
  if (blad) komunikat(blad, true);
  else komunikat(bylaSesja ? 'Rozłączono.' : '');
}

$('#sesja-rozlacz').addEventListener('click', () => zakoncz(null));
$('#sesja-pelny').addEventListener('click', () => L.okno('pelny'));

// obraz przychodzi w kawałkach: [nr klatki u32][nr kawałka u16][liczba kawałków u16][JPEG…]
function klatka(ev) {
  const buf = ev.data;
  if (buf.byteLength < 8) return;
  const v = new DataView(buf);
  const nr = v.getUint32(0);
  const i = v.getUint16(4);
  const ile = v.getUint16(6);
  let k = klatki.get(nr);
  if (!k) {
    k = { ile, mam: 0, czesci: new Array(ile) };
    klatki.set(nr, k);
    for (const x of klatki.keys()) if (x < nr - 3) klatki.delete(x);
  }
  if (i >= k.ile || k.czesci[i]) return;
  k.czesci[i] = new Uint8Array(buf, 8);
  if (++k.mam !== k.ile) return;
  klatki.delete(nr);
  createImageBitmap(new Blob(k.czesci, { type: 'image/jpeg' })).then((bmp) => {
    const c = $('#ekran');
    if (c.width !== bmp.width || c.height !== bmp.height) { c.width = bmp.width; c.height = bmp.height; }
    c.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close();
    if (!pierwszaKlatka) { pierwszaKlatka = true; clearTimeout(czasomierz); $('#sesja-laczenie').hidden = true; }
  }).catch(() => { /* uszkodzona klatka */ });
}

// ---------------------------------------------------------------- sterowanie

const PRZYCISKI = { 0: 0, 1: 2, 2: 1 };
let ostatniRuch = 0;
const wyslijCtrl = (o) => { if (ctrl && ctrl.readyState === 'open') ctrl.send(JSON.stringify(o)); };
function pozycja(e) {
  const r = $('#ekran').getBoundingClientRect();
  return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
}

const ekran = $('#ekran');
ekran.addEventListener('mousemove', (e) => {
  const t = performance.now();
  if (t - ostatniRuch < 16) return;
  ostatniRuch = t;
  const p = pozycja(e);
  wyslijCtrl({ t: 'm', x: p.x, y: p.y });
});
ekran.addEventListener('mousedown', (e) => {
  e.preventDefault();
  ekran.focus();
  const p = pozycja(e);
  wyslijCtrl({ t: 'm', x: p.x, y: p.y });
  wyslijCtrl({ t: 'b', b: PRZYCISKI[e.button] ?? 0, d: true });
});
window.addEventListener('mouseup', (e) => { if (sesjaWidoczna) wyslijCtrl({ t: 'b', b: PRZYCISKI[e.button] ?? 0, d: false }); });
ekran.addEventListener('contextmenu', (e) => e.preventDefault());
ekran.addEventListener('wheel', (e) => { e.preventDefault(); wyslijCtrl({ t: 'w', w: e.deltaY > 0 ? -120 : 120 }); }, { passive: false });

window.addEventListener('keydown', (e) => {
  if (!sesjaWidoczna) return;
  if (e.key === 'F11') { e.preventDefault(); L.okno('pelny'); return; }
  e.preventDefault();
  wyslijCtrl({ t: 'k', vk: e.keyCode, d: true });
});
window.addEventListener('keyup', (e) => {
  if (!sesjaWidoczna || e.key === 'F11') return;
  e.preventDefault();
  wyslijCtrl({ t: 'k', vk: e.keyCode, d: false });
});

// ---------------------------------------------------------------- okno

document.querySelectorAll('[data-okno]').forEach((b) => b.addEventListener('click', () => L.okno(b.dataset.okno)));

L.naOkno((o) => {
  document.body.classList.toggle('pelny', !!o.pelny);
  document.querySelectorAll('.przycisk-max').forEach((b) => {
    b.innerHTML = window.ikona(o.max ? 'przywroc-okno' : 'maks');
    b.title = o.max ? 'Przywróć' : 'Maksymalizuj';
  });
  $('#sesja-pelny').innerHTML = window.ikona(o.pelny ? 'pelny-wyjdz' : 'pelny');
});

// ---------------------------------------------------------------- ustawienia

// ---------------------------------------------------------------- stałe ID (nowe tylko na życzenie)

let noweIdCzas = null;
function pokazId() {
  clearTimeout(noweIdCzas);
  noweIdCzas = null;
  $('#ust-id').textContent = S.id ? formatuj(S.id) : '—';
  $('#ust-id-opis').textContent = 'Zostaje na stałe. Zmieni się tylko po kliknięciu „Nowe ID”.';
  $('#ust-nowe-id').textContent = 'Nowe ID';
  $('#ust-nowe-id').classList.remove('glowny');
}
$('#ust-nowe-id').addEventListener('click', async () => {
  if (!noweIdCzas) {
    // pierwsze kliknięcie tylko pyta: stare ID przestanie działać na zawsze
    $('#ust-id-opis').textContent = 'Stare ID przestanie działać i nikt go już nie dostanie. Kto je zna, nie połączy się. Trwające połączenia zostaną przerwane.';
    $('#ust-nowe-id').textContent = 'Tak, zmień ID';
    $('#ust-nowe-id').classList.add('glowny');
    noweIdCzas = setTimeout(pokazId, 8000);
    return;
  }
  clearTimeout(noweIdCzas);
  noweIdCzas = null;
  $('#ust-nowe-id').disabled = true;
  const w = await L.noweId();
  $('#ust-nowe-id').disabled = false;
  pokazId();
  if (!w || !w.ok) { bladUstawien((w && w.blad) || 'Nie udało się zmienić ID.'); return; }
  pokazStatus({ stan: 'laczenie', id: null, haslo: null });
  zamknijUstawienia();
  toast('Ten komputer dostaje nowe ID', 'odswiez');
});

function otworzUstawienia(naDostep) {
  pokazId();
  $('#ust-serwer').value = S.serwer || '';
  $('#ust-wersja').textContent = S.wersja || '';
  $('#ust-komunikat').textContent = '';
  pokazDostep(false);
  $('#ustawienia').hidden = false;
  if (naDostep === true && !S.staleHaslo) $('#stale-1').focus();
  else if (naDostep !== true) $('#ust-serwer').focus();
}

// ---------------------------------------------------------------- dostęp bez obsługi (stałe hasło)

function pokazDostep(zmiana) {
  const jest = !!S.staleHaslo;
  $('#stale-jest').hidden = !jest || zmiana;
  $('#stale-brak').hidden = jest && !zmiana;
  $('#stale-ustaw').textContent = jest ? 'Zapisz nowe hasło' : 'Ustaw stałe hasło';
  $('#stale-1').value = '';
  $('#stale-2').value = '';
  $('#ust-autostart').checked = !!S.autostart;
  $('#ust-autostart').disabled = !!S.dev;
  $('#autostart-wiersz').title = S.dev ? 'Działa w zainstalowanej wersji' : '';
  $('#info-stale').hidden = !jest;
}

function bladUstawien(tekst) {
  $('#ust-komunikat').className = 'komunikat blad';
  $('#ust-komunikat').textContent = tekst;
}

$('#stale-ustaw').addEventListener('click', async () => {
  const a = $('#stale-1').value;
  const b = $('#stale-2').value;
  if (a.length < 8) { bladUstawien('Stałe hasło musi mieć co najmniej 8 znaków.'); $('#stale-1').focus(); return; }
  if (a !== b) { bladUstawien('Hasła się różnią. Wpisz to samo hasło dwa razy.'); $('#stale-2').focus(); return; }
  $('#stale-ustaw').disabled = true;
  const w = await L.staleHaslo(a);
  $('#stale-ustaw').disabled = false;
  if (!w.ok) { bladUstawien(w.blad); return; }
  S = { ...S, ...w };
  $('#ust-komunikat').textContent = '';
  pokazDostep(false);
  toast('Stałe hasło ustawione: możesz łączyć się bez nikogo przy komputerze');
});
for (const id of ['#stale-1', '#stale-2']) {
  $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#stale-ustaw').click(); } });
}
$('#stale-zmien').addEventListener('click', () => { pokazDostep(true); $('#stale-1').focus(); });
$('#stale-usun').addEventListener('click', async () => {
  const w = await L.usunStaleHaslo();
  S = { ...S, ...w };
  pokazDostep(false);
  toast('Stałe hasło usunięte: łączyć się można tylko jednorazowym hasłem');
});
$('#ust-autostart').addEventListener('change', async (e) => {
  const w = await L.autostart(e.target.checked);
  S = { ...S, ...w };
  toast(w.autostart ? 'LivePL Connect uruchomi się razem z Windows' : 'LivePL Connect nie będzie startował z Windows');
});
$('#info-stale').addEventListener('click', () => otworzUstawienia(true));
const zamknijUstawienia = () => { $('#ustawienia').hidden = true; };

$('#otworz-ustawienia').addEventListener('click', otworzUstawienia);
$('#ust-x').addEventListener('click', zamknijUstawienia);
$('#ust-anuluj').addEventListener('click', zamknijUstawienia);
$('#ustawienia').addEventListener('mousedown', (e) => { if (e.target === e.currentTarget) zamknijUstawienia(); });
$('#ust-domyslny').addEventListener('click', () => { $('#ust-serwer').value = S.domyslnySerwer || ''; });
$('#ust-sprawdz').addEventListener('click', () => L.sprawdzAktualizacje());
$('#ust-zapisz').addEventListener('click', async () => {
  const w = await L.ustawSerwer($('#ust-serwer').value);
  if (!w.ok) {
    $('#ust-komunikat').className = 'komunikat blad';
    $('#ust-komunikat').textContent = w.blad;
    return;
  }
  S.serwer = w.serwer;
  zamknijUstawienia();
  toast('Zapisano ustawienia');
});

// ---------------------------------------------------------------- o programie

function otworzO() {
  $('#o-wersja').textContent = 'wersja ' + (S.wersja || '');
  $('#o-id').textContent = S.id ? formatuj(S.id) : '—';
  $('#o-serwer').textContent = S.serwer || '—';
  $('#o-prawa').textContent = 'Copyright © ' + new Date().getFullYear() + ' Live Production Karol Kowalski. Licencja MIT.';
  $('#o-programie').hidden = false;
}
$('#otworz-o').addEventListener('click', otworzO);
$('#wersja').addEventListener('click', otworzO);
$('#o-x').addEventListener('click', () => { $('#o-programie').hidden = true; });
$('#o-programie').addEventListener('mousedown', (e) => { if (e.target === e.currentTarget) e.currentTarget.hidden = true; });

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#ustawienia').hidden) zamknijUstawienia();
  $('#o-programie').hidden = true;
});

// ---------------------------------------------------------------- aktualizacje

function aktualizacja(a) {
  const baner = $('#baner');
  const tekst = $('#ust-akt');
  switch (a.stan) {
    case 'sprawdzam': tekst.textContent = 'Sprawdzam…'; return;
    case 'aktualna': tekst.textContent = 'Masz najnowszą wersję.'; return;
    case 'dev': tekst.textContent = a.komunikat; return;
    case 'dostepna':
      tekst.textContent = 'Dostępna wersja ' + a.wersja + '.';
      $('#baner-tytul').textContent = 'Dostępna nowa wersja ' + a.wersja;
      $('#baner-opis').textContent = a.opis || 'Zainstaluje się sama, gdy nikt nie będzie połączony. ID tego komputera zostanie bez zmian.';
      $('#baner-postep').hidden = true;
      $('#baner-akcja').hidden = false;
      $('#baner-akcja').disabled = false;
      $('#baner-akcja').textContent = 'Zaktualizuj';
      baner.hidden = false;
      return;
    case 'pobieram':
      baner.hidden = false;
      $('#baner-tytul').textContent = 'Pobieram nową wersję ' + a.wersja + '…';
      $('#baner-opis').textContent = Math.round((a.postep || 0) * 100) + '%';
      $('#baner-postep').hidden = false;
      $('#baner-pasek').style.width = Math.round((a.postep || 0) * 100) + '%';
      $('#baner-akcja').hidden = true;
      return;
    case 'instaluje':
      $('#baner-tytul').textContent = 'Uruchamiam instalator…';
      $('#baner-opis').textContent = 'LivePL Connect zamknie się na chwilę i wróci w nowej wersji.';
      $('#baner-pasek').style.width = '100%';
      return;
    case 'blad':
      tekst.textContent = a.komunikat || 'Błąd aktualizacji.';
      if (a.wersja) {
        baner.hidden = false;
        $('#baner-tytul').textContent = a.komunikat || 'Nie udało się pobrać aktualizacji';
        $('#baner-opis').textContent = 'Sprawdź internet i spróbuj ponownie.';
        $('#baner-postep').hidden = true;
        $('#baner-akcja').hidden = false;
        $('#baner-akcja').textContent = 'Spróbuj ponownie';
      }
  }
}

$('#baner-akcja').addEventListener('click', () => { $('#baner-akcja').disabled = true; L.aktualizuj(); });

// ---------------------------------------------------------------- start

L.naStatus(pokazStatus);
L.naAktualizacje(aktualizacja);
pokazOstatnie();
L.stan().then((s) => {
  S = { ...S, ...s };
  $('#wersja').textContent = 'wersja ' + s.wersja;
  $('#info-stale').hidden = !s.staleHaslo;
  pokazStatus(s);
  if (s.aktualizacja) aktualizacja({ stan: 'dostepna', ...s.aktualizacja });
});
setInterval(pokazOstatnie, 60000);
