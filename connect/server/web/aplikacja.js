'use strict';
// LivePL Connect w przeglądarce (telefon, tablet, komputer): łączy się z komputerem po ID i haśle,
// pokazuje jego ekran i steruje nim. Na dotyku: stuknięcie = klik, przytrzymanie = prawy przycisk,
// przytrzymanie i przesunięcie = przeciąganie, jeden palec = przewijanie, dwa palce = powiększenie.
// W trybie „Mysz” ekran działa jak touchpad laptopa (przydatne przy drobnych elementach).

const $ = (s) => document.querySelector(s);
const ICE = [{ urls: 'stun:stun.l.google.com:19302' }];
// Strona działa pod https://connect.livepl.eu/ (zwykły port) i pod :5938; serwer pośredniczący
// zawsze słucha na 5938. Lokalnie (testy) łączymy się z tym samym adresem, z którego przyszła strona.
const SERWER = /(^|\.)livepl\.eu$/i.test(location.hostname)
  ? 'wss://connect.livepl.eu:5938/ws'
  : (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
const DOTYK = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;

document.querySelectorAll('[data-ik]').forEach((el) => el.insertAdjacentHTML('afterbegin', window.ikona(el.dataset.ik)));

const cyfry = (t) => String(t || '').replace(/\D/g, '');
const formatuj = (id) => cyfry(id).slice(0, 9).replace(/(\d{3})(?=\d)/g, '$1 ');

let ws = null;
let pc = null;
let ctrl = null;
let hostConn = null;
let sesjaId = null;
let sesjaWidoczna = false;
let pierwszaKlatka = false;
let czasomierz = null;
let rozlaczCzas = null;
let blokadaEkranu = null;
const klatki = new Map();

// ---------------------------------------------------------------- formularz

function komunikat(tekst, blad) {
  const k = $('#komunikat');
  k.textContent = tekst || '';
  k.classList.toggle('blad', !!blad);
}

$('#rid').addEventListener('input', (e) => {
  const el = e.target;
  el.value = formatuj(el.value);
  $('.pole-id').classList.remove('zle');
  if (cyfry(el.value).length === 9 && document.activeElement === el && !$('#pw').value) $('#pw').focus();
});
$('#pw').addEventListener('input', () => $('.pole-haslo').classList.remove('zle'));
$('#rid').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#pw').focus(); } });

$('#formularz').addEventListener('submit', (e) => {
  e.preventDefault();
  document.activeElement && document.activeElement.blur();
  polacz(cyfry($('#rid').value), $('#pw').value.trim());
});

function trwaLaczenie(tak) {
  const b = $('#polacz');
  b.disabled = tak;
  b.classList.toggle('trwa', tak);
  b.querySelector('.napis').textContent = tak ? 'Łączę…' : 'Połącz';
}

// ---------------------------------------------------------------- ostatnie połączenia

function ostatnie() {
  try { return JSON.parse(localStorage.getItem('lpc-ostatnie') || '[]').filter((o) => /^\d{9}$/.test(o.id)); } catch { return []; }
}

function zapiszOstatnie(lista) {
  try { localStorage.setItem('lpc-ostatnie', JSON.stringify(lista.slice(0, 6))); } catch { /* prywatne okno */ }
}

function kiedy(ms) {
  const roznica = (Date.now() - ms) / 60000;
  if (roznica < 1) return 'przed chwilą';
  if (roznica < 60) return Math.round(roznica) + ' min temu';
  const d = new Date(ms);
  const dzis = new Date();
  const godz = d.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === dzis.toDateString()) return 'dziś, ' + godz;
  const wczoraj = new Date(dzis); wczoraj.setDate(dzis.getDate() - 1);
  if (d.toDateString() === wczoraj.toDateString()) return 'wczoraj, ' + godz;
  return d.toLocaleDateString('pl-PL', { day: 'numeric', month: 'short' }) + ', ' + godz;
}

function pokazOstatnie() {
  const lista = ostatnie();
  const ul = $('#lista-ostatnich');
  ul.textContent = '';
  $('#ostatnie-sekcja').hidden = !lista.length;
  for (const o of lista) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="ostatni-ik">' + window.ikona('monitor') + '</span><span class="ostatni-tekst"><b></b><span></span></span>'
      + '<button type="button" class="ostatni-usun" aria-label="Usuń z listy">' + window.ikona('kosz') + '</button>';
    li.querySelector('b').textContent = formatuj(o.id);
    li.querySelector('.ostatni-tekst span').textContent = kiedy(o.kiedy);
    li.addEventListener('click', () => {
      $('#rid').value = formatuj(o.id);
      $('#pw').value = '';
      $('#pw').focus();
      komunikat('Wpisz hasło, które widzi osoba przy komputerze.');
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
}

// ---------------------------------------------------------------- łączenie

function polacz(id, haslo) {
  if (ws || pc) return;
  if (id.length !== 9) { $('.pole-id').classList.add('zle'); komunikat('Wpisz 9-cyfrowe ID komputera.', true); return; }
  if (!haslo) { $('.pole-haslo').classList.add('zle'); komunikat('Wpisz hasło, które widzi osoba przy komputerze.', true); return; }

  sesjaId = id;
  pierwszaKlatka = false;
  trwaLaczenie(true);
  komunikat('Łączę z serwerem…');
  ws = new WebSocket(SERWER);
  ws.onopen = () => {
    komunikat('Czekam na odpowiedź komputera ' + formatuj(id) + '…');
    ws.send(JSON.stringify({ type: 'connect', id, password: haslo }));
  };
  ws.onmessage = sygnal;
  ws.onerror = () => zakoncz('Nie mogę połączyć się z serwerem. Sprawdź internet.');
  ws.onclose = () => { ws = null; if (!pc && sesjaId) zakoncz('Serwer zakończył połączenie.'); };
  czasomierz = setTimeout(() => { if (!pierwszaKlatka) zakoncz('Komputer nie odpowiada. Sprawdź ID i hasło i spróbuj ponownie.'); }, 25000);
}

async function sygnal(ev) {
  let m;
  try { m = JSON.parse(ev.data); } catch { return; }
  if (m.type === 'error') {
    const e = String(m.error || '');
    if (/no online host/i.test(e)) zakoncz('Komputer o tym ID jest teraz niedostępny.');
    else if (/wrong password/i.test(e)) { zakoncz('Nieprawidłowe hasło.'); $('.pole-haslo').classList.add('zle'); }
    else if (/too many/i.test(e)) zakoncz('Za dużo błędnych haseł. Komputer przyjmie kolejną próbę za kilka minut.');
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
      else if (st === 'failed') zakoncz('Nie udało się zestawić połączenia z komputerem (sieć może je blokować).');
      else if (st === 'disconnected') rozlaczCzas = setTimeout(() => zakoncz('Połączenie z komputerem zostało przerwane.'), 6000);
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
  // gest „wstecz” telefonu w trakcie sesji rozłącza, zamiast zamykać stronę
  try { history.pushState({ sesja: true }, ''); } catch { /* nic */ }
  dodajOstatni(sesjaId);
  $('#sesja-id').textContent = formatuj(sesjaId);
  $('#laczenie-id').textContent = formatuj(sesjaId);
  $('#sesja-laczenie').hidden = pierwszaKlatka;
  $('#start').hidden = true;
  $('#sesja').hidden = false;
  document.body.classList.add('w-sesji');
  ustawTryb(tryb);
  dopasuj();
  trzymajEkranWlaczony();
  if (DOTYK) podpowiedz(tryb === 'mysz'
    ? 'Tryb myszy: przesuwaj palcem jak po touchpadzie, stuknij, żeby kliknąć.'
    : 'Stuknij, żeby kliknąć. Przytrzymaj: prawy przycisk. Dwa palce: powiększenie.', 4200);
}

function zakoncz(blad) {
  clearTimeout(czasomierz);
  clearTimeout(rozlaczCzas);
  const bylaSesja = sesjaWidoczna;
  if (bylaSesja) zwolnijWszystko();
  try { if (pc) pc.close(); } catch { /* nic */ }
  try { if (ws) ws.close(); } catch { /* nic */ }
  pc = null; ws = null; ctrl = null; hostConn = null; sesjaId = null;
  sesjaWidoczna = false;
  klatki.clear();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  try { if (blokadaEkranu) blokadaEkranu.release(); } catch { /* nic */ }
  blokadaEkranu = null;
  $('#pisanie').blur();
  $('#sesja').hidden = true;
  $('#klawisze').hidden = true;
  $('#p-klawisze').classList.remove('aktywny');
  $('#start').hidden = false;
  document.body.classList.remove('w-sesji');
  $('#sesja').style.cssText = '';
  if (bylaSesja && history.state && history.state.sesja) history.back();
  trwaLaczenie(false);
  pokazOstatnie();
  if (blad) komunikat(blad, true);
  else komunikat(bylaSesja ? 'Rozłączono.' : '');
}

// telefon nie gaśnie w trakcie sesji (tam, gdzie przeglądarka na to pozwala)
async function trzymajEkranWlaczony() {
  try { if ('wakeLock' in navigator) blokadaEkranu = await navigator.wakeLock.request('screen'); } catch { /* nie szkodzi */ }
}
document.addEventListener('visibilitychange', () => { if (sesjaWidoczna && document.visibilityState === 'visible') trzymajEkranWlaczony(); });

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
    if (c.width !== bmp.width || c.height !== bmp.height) { c.width = bmp.width; c.height = bmp.height; dopasuj(); }
    c.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close();
    if (!pierwszaKlatka) { pierwszaKlatka = true; clearTimeout(czasomierz); $('#sesja-laczenie').hidden = true; }
  }).catch(() => { /* uszkodzona klatka */ });
}

// ---------------------------------------------------------------- widok: dopasowanie, powiększenie, przesuwanie

const scena = $('#scena');
const ekran = $('#ekran');
const W = { z: 1, tx: 0, ty: 0, bw: 1, bh: 1 }; // powiększenie, przesunięcie, rozmiar „dopasowany”
const MAKS_ZOOM = 6;

function dopasuj() {
  const sw = scena.clientWidth;
  const sh = scena.clientHeight;
  const iw = ekran.width || 16;
  const ih = ekran.height || 9;
  const s = Math.min(sw / iw, sh / ih);
  W.bw = iw * s;
  W.bh = ih * s;
  ekran.style.width = W.bw + 'px';
  ekran.style.height = W.bh + 'px';
  W.z = 1;
  W.tx = (sw - W.bw) / 2;
  W.ty = (sh - W.bh) / 2;
  zastosuj();
}

function ogranicz() {
  const sw = scena.clientWidth;
  const sh = scena.clientHeight;
  const w = W.bw * W.z;
  const h = W.bh * W.z;
  W.tx = w <= sw ? (sw - w) / 2 : Math.min(0, Math.max(sw - w, W.tx));
  W.ty = h <= sh ? (sh - h) / 2 : Math.min(0, Math.max(sh - h, W.ty));
}

function zastosuj() {
  ogranicz();
  ekran.style.transform = `translate(${W.tx}px, ${W.ty}px) scale(${W.z})`;
  if (tryb === 'mysz') pokazKursor();
}

function powieksz(z, cx, cy) {
  const nz = Math.min(MAKS_ZOOM, Math.max(1, z));
  const px = (cx - W.tx) / W.z;
  const py = (cy - W.ty) / W.z;
  W.z = nz;
  W.tx = cx - px * nz;
  W.ty = cy - py * nz;
  zastosuj();
}

// nowy rozmiar sceny (obrót telefonu, klawiatura, pasek klawiszy): dopasuj, zachowując powiększenie
function przelicz() {
  if (!sesjaWidoczna) return;
  const z = W.z;
  dopasuj();
  if (z > 1) powieksz(z, scena.clientWidth / 2, scena.clientHeight / 2);
}

// klawiatura telefonu zasłania dół ekranu: sesja kurczy się do widocznej części (pasek nad klawiaturą)
function dopasujDoKlawiatury() {
  if (!sesjaWidoczna || !window.visualViewport) return;
  const v = window.visualViewport;
  const s = $('#sesja');
  s.style.top = v.offsetTop + 'px';
  s.style.height = v.height + 'px';
  s.style.bottom = 'auto';
  przelicz();
}

window.addEventListener('resize', () => { if (window.visualViewport) dopasujDoKlawiatury(); else przelicz(); });
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', dopasujDoKlawiatury);
  window.visualViewport.addEventListener('scroll', dopasujDoKlawiatury);
}

// punkt na scenie (px) → współrzędne zdalnego ekranu (0..1)
function naZdalny(sx, sy) {
  return {
    x: Math.min(1, Math.max(0, (sx - W.tx) / (W.bw * W.z))),
    y: Math.min(1, Math.max(0, (sy - W.ty) / (W.bh * W.z)))
  };
}

function naScene(x, y) {
  return { sx: W.tx + x * W.bw * W.z, sy: W.ty + y * W.bh * W.z };
}

function punkt(e) {
  const r = scena.getBoundingClientRect();
  return { sx: e.clientX - r.left, sy: e.clientY - r.top };
}

// ---------------------------------------------------------------- wysyłanie sterowania

const wyslij = (o) => { if (ctrl && ctrl.readyState === 'open') ctrl.send(JSON.stringify(o)); };
let ostatniRuch = 0;
let czekajacyRuch = null;

function ruch(p, odrazu) {
  const t = performance.now();
  if (!odrazu && t - ostatniRuch < 16) {
    if (!czekajacyRuch) czekajacyRuch = setTimeout(() => { czekajacyRuch = null; ruch(ostatniPunkt, true); }, 18);
    ostatniPunkt = p;
    return;
  }
  ostatniRuch = t;
  ostatniPunkt = p;
  wyslij({ t: 'm', x: p.x, y: p.y });
}
let ostatniPunkt = { x: 0.5, y: 0.5 };

function przycisk(b, wcisniety) { wyslij({ t: 'b', b, d: wcisniety }); }
function klik(p, b = 0) { ruch(p, true); przycisk(b, true); przycisk(b, false); }
function kolko(w) { wyslij({ t: 'w', w }); }

const wcisniete = new Set(); // przyciski myszy wciśnięte przez nas (do puszczenia przy rozłączeniu)
function zwolnijWszystko() {
  for (const b of wcisniete) przycisk(b, false);
  wcisniete.clear();
  for (const vk of [...modyfikatory]) klawisz(vk, false);
  modyfikatory.clear();
  odswiezModyfikatory();
}

// ---------------------------------------------------------------- tryb: dotyk albo mysz (touchpad)

let tryb = (() => { try { return localStorage.getItem('lpc-tryb') === 'mysz' ? 'mysz' : 'dotyk'; } catch { return 'dotyk'; } })();
const K = { x: 0.5, y: 0.5 }; // kursor w trybie myszy (0..1)

function ustawTryb(t) {
  tryb = t;
  try { localStorage.setItem('lpc-tryb', t); } catch { /* nic */ }
  $('#p-tryb-napis').textContent = t === 'mysz' ? 'Mysz' : 'Dotyk';
  $('#p-tryb-ik').innerHTML = window.ikona(t === 'mysz' ? 'mysz' : 'dotyk');
  $('#p-tryb').classList.toggle('aktywny', t === 'mysz');
  $('#kursor').toggleAttribute('hidden', !(t === 'mysz' && DOTYK)); // SVG nie ma właściwości .hidden
  if (t === 'mysz') pokazKursor();
}

function pokazKursor() {
  const { sx, sy } = naScene(K.x, K.y);
  $('#kursor').style.transform = `translate(${sx}px, ${sy}px)`;
}

// w trybie myszy widok jedzie za kursorem, gdy ten zbliża się do krawędzi
function podazajZaKursorem() {
  if (W.z <= 1) return;
  const { sx, sy } = naScene(K.x, K.y);
  const m = 48;
  const sw = scena.clientWidth;
  const sh = scena.clientHeight;
  if (sx < m) W.tx += m - sx; else if (sx > sw - m) W.tx -= sx - (sw - m);
  if (sy < m) W.ty += m - sy; else if (sy > sh - m) W.ty -= sy - (sh - m);
  zastosuj();
}

function krag(sx, sy, rodzaj) {
  const k = $('#krag');
  k.style.left = sx + 'px';
  k.style.top = sy + 'px';
  k.classList.remove('klik', 'trzymaj');
  if (rodzaj) { void k.offsetWidth; k.classList.add(rodzaj); }
}

let podpowiedzCzas = null;
function podpowiedz(tekst, ms = 2200) {
  const p = $('#podpowiedz');
  p.textContent = tekst;
  p.hidden = false;
  clearTimeout(podpowiedzCzas);
  podpowiedzCzas = setTimeout(() => { p.hidden = true; }, ms);
}

// ---------------------------------------------------------------- gesty dotykowe

const palce = new Map(); // pointerId → { sx, sy }
let G = null;            // bieżący gest
let ignorujDoKonca = false;
const PRZESUNIECIE = 10; // px: mniej to jeszcze „stuknięcie”
const PRZYTRZYMANIE = 450; // ms
const KROK_PRZEWIJANIA = 34; // px palca na jeden „ząbek” kółka myszy

function odleglosc(a, b) { return Math.hypot(a.sx - b.sx, a.sy - b.sy); }
function srodek(a, b) { return { sx: (a.sx + b.sx) / 2, sy: (a.sy + b.sy) / 2 }; }

function startJeden(p) {
  G = { typ: 'jeden', start: p, ostatni: p, t0: performance.now(), ruszony: false, przytrzymany: false, przeciaga: false, przewijanie: 0 };
  G.licznik = setTimeout(() => {
    if (!G || G.typ !== 'jeden' || G.ruszony) return;
    G.przytrzymany = true;
    if (navigator.vibrate) navigator.vibrate(12);
    if (tryb === 'dotyk') krag(G.start.sx, G.start.sy, 'trzymaj');
  }, PRZYTRZYMANIE);
}

function startDwa() {
  const [a, b] = [...palce.values()];
  if (G && G.typ === 'jeden') {
    clearTimeout(G.licznik);
    if (G.przeciaga) { przycisk(0, false); wcisniete.delete(0); }
  }
  krag(0, 0, null);
  G = { typ: 'dwa', d0: odleglosc(a, b), m0: srodek(a, b), z0: W.z, tx0: W.tx, ty0: W.ty, t0: performance.now(), rodzaj: null, przewijanie: 0, ostatniY: srodek(a, b).sy };
}

scena.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse') return; // mysz komputera ma osobną obsługę niżej
  e.preventDefault();
  try { scena.setPointerCapture(e.pointerId); } catch { /* palec już zniknął */ }
  palce.set(e.pointerId, punkt(e));
  if (ignorujDoKonca) return;
  if (palce.size === 1) startJeden(punkt(e));
  else if (palce.size === 2) startDwa();
  else { if (G && G.typ === 'jeden') clearTimeout(G.licznik); G = null; ignorujDoKonca = true; }
});

scena.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'mouse' || !palce.has(e.pointerId)) return;
  e.preventDefault();
  const p = punkt(e);
  palce.set(e.pointerId, p);
  if (!G || ignorujDoKonca) return;

  if (G.typ === 'jeden') {
    if (!G.ruszony && odleglosc(p, G.start) > PRZESUNIECIE) {
      G.ruszony = true;
      if (!G.przytrzymany) clearTimeout(G.licznik);
    }
    const dx = p.sx - G.ostatni.sx;
    const dy = p.sy - G.ostatni.sy;
    G.ostatni = p;
    if (!G.ruszony) return;

    if (tryb === 'mysz') {
      // touchpad: ruch względny, szybszy przy szybkim ruchu palca
      const szybkosc = 1.25 + Math.min(1.5, Math.hypot(dx, dy) / 18);
      K.x = Math.min(1, Math.max(0, K.x + (dx * szybkosc) / (W.bw * W.z)));
      K.y = Math.min(1, Math.max(0, K.y + (dy * szybkosc) / (W.bh * W.z)));
      if (G.przytrzymany && !G.przeciaga) { G.przeciaga = true; ruch(K, true); przycisk(0, true); wcisniete.add(0); }
      ruch(K);
      pokazKursor();
      podazajZaKursorem();
      return;
    }

    // dotyk
    if (G.przytrzymany) {
      if (!G.przeciaga) {
        G.przeciaga = true;
        krag(0, 0, null);
        ruch(naZdalny(G.start.sx, G.start.sy), true);
        przycisk(0, true);
        wcisniete.add(0);
      }
      ruch(naZdalny(p.sx, p.sy));
      return;
    }
    // przewijanie jednym palcem: palec w górę = treść w dół, jak na telefonie
    G.przewijanie += dy;
    while (G.przewijanie <= -KROK_PRZEWIJANIA) { kolko(-120); G.przewijanie += KROK_PRZEWIJANIA; }
    while (G.przewijanie >= KROK_PRZEWIJANIA) { kolko(120); G.przewijanie -= KROK_PRZEWIJANIA; }
    return;
  }

  if (G.typ === 'dwa' && palce.size >= 2) {
    const [a, b] = [...palce.values()];
    const d = odleglosc(a, b);
    const m = srodek(a, b);
    if (!G.rodzaj) {
      const zmianaD = Math.abs(d - G.d0);
      const zmianaM = Math.hypot(m.sx - G.m0.sx, m.sy - G.m0.sy);
      if (zmianaD > 16) G.rodzaj = 'zoom';
      else if (zmianaM > 14) G.rodzaj = (tryb === 'mysz' || W.z <= 1) ? 'przewijanie' : 'zoom';
      else return;
    }
    if (G.rodzaj === 'zoom') {
      // punkt pod palcami zostaje pod palcami: powiększenie i przesuwanie naraz
      const nz = Math.min(MAKS_ZOOM, Math.max(1, G.z0 * (d / G.d0)));
      const px = (G.m0.sx - G.tx0) / G.z0;
      const py = (G.m0.sy - G.ty0) / G.z0;
      W.z = nz;
      W.tx = m.sx - px * nz;
      W.ty = m.sy - py * nz;
      zastosuj();
    } else {
      G.przewijanie += m.sy - G.ostatniY;
      G.ostatniY = m.sy;
      while (G.przewijanie <= -KROK_PRZEWIJANIA) { kolko(-120); G.przewijanie += KROK_PRZEWIJANIA; }
      while (G.przewijanie >= KROK_PRZEWIJANIA) { kolko(120); G.przewijanie -= KROK_PRZEWIJANIA; }
    }
  }
});

function koniecPalca(e) {
  if (e.pointerType === 'mouse' || !palce.has(e.pointerId)) return;
  palce.delete(e.pointerId);
  const anulowany = e.type === 'pointercancel';

  if (G && G.typ === 'jeden' && !ignorujDoKonca) {
    clearTimeout(G.licznik);
    if (G.przeciaga) {
      if (tryb === 'mysz') ruch(K, true); else ruch(naZdalny(G.ostatni.sx, G.ostatni.sy), true);
      przycisk(0, false);
      wcisniete.delete(0);
    } else if (!G.ruszony && !anulowany) {
      const prawy = G.przytrzymany;
      if (tryb === 'mysz') {
        klik(K, prawy ? 1 : 0);
      } else {
        klik(naZdalny(G.start.sx, G.start.sy), prawy ? 1 : 0);
        krag(G.start.sx, G.start.sy, 'klik');
      }
    } else {
      krag(0, 0, null);
    }
    G = null;
  } else if (G && G.typ === 'dwa') {
    // szybkie stuknięcie dwoma palcami = prawy przycisk
    if (!G.rodzaj && !anulowany && performance.now() - G.t0 < 320) {
      if (tryb === 'mysz') klik(K, 1);
      else { klik(naZdalny(G.m0.sx, G.m0.sy), 1); krag(G.m0.sx, G.m0.sy, 'klik'); }
    }
    G = null;
    ignorujDoKonca = palce.size > 0; // pozostały palec nie zaczyna nowego gestu
  }
  if (palce.size === 0) ignorujDoKonca = false;
}

scena.addEventListener('pointerup', koniecPalca);
scena.addEventListener('pointercancel', koniecPalca);
scena.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------------------------------------------------------------- mysz i kółko (przeglądarka na komputerze)

const PRZYCISKI = { 0: 0, 1: 2, 2: 1 }; // przeglądarka (lewy, środkowy, prawy) → komputer (lewy, prawy, środkowy)

scena.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse' || !sesjaWidoczna) return;
  const p = punkt(e);
  ruch(naZdalny(p.sx, p.sy));
});
scena.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'mouse') return;
  e.preventDefault();
  $('#pisanie').blur();
  const b = PRZYCISKI[e.button] ?? 0;
  const p = punkt(e);
  ruch(naZdalny(p.sx, p.sy), true);
  przycisk(b, true);
  wcisniete.add(b);
});
window.addEventListener('pointerup', (e) => {
  if (e.pointerType !== 'mouse' || !sesjaWidoczna) return;
  const b = PRZYCISKI[e.button] ?? 0;
  if (wcisniete.has(b)) { przycisk(b, false); wcisniete.delete(b); }
});
scena.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey) { // gest szczypania na touchpadzie albo Ctrl + kółko: powiększenie u nas
    const p = punkt(e);
    powieksz(W.z * (e.deltaY > 0 ? 0.9 : 1.1), p.sx, p.sy);
    return;
  }
  kolko(e.deltaY > 0 ? -120 : 120);
}, { passive: false });

// ---------------------------------------------------------------- klawiatura

const modyfikatory = new Set(); // Ctrl/Alt/Shift/Win „przyklejone” z paska klawiszy
function klawisz(vk, wcisniety) { wyslij({ t: 'k', vk, d: wcisniety }); }

function odswiezModyfikatory() {
  document.querySelectorAll('.klawisze .mod').forEach((b) => b.classList.toggle('wcisniety', modyfikatory.has(Number(b.dataset.mod))));
}

// jeden klawisz z przyklejonymi modyfikatorami (np. Ctrl + C), potem modyfikatory puszczamy
function nacisnij(vk) {
  for (const m of modyfikatory) klawisz(m, true);
  klawisz(vk, true);
  klawisz(vk, false);
  for (const m of modyfikatory) klawisz(m, false);
  if (modyfikatory.size) { modyfikatory.clear(); odswiezModyfikatory(); }
}

// tekst z klawiatury telefonu: zwykłe znaki jako tekst (polskie litery też),
// a z przyklejonym Ctrl/Alt/Win litery i cyfry jako skróty klawiszowe
function piszTekst(tekst) {
  if (!tekst) return;
  if (modyfikatory.size && /^[a-z0-9]$/i.test(tekst)) { nacisnij(tekst.toUpperCase().charCodeAt(0)); return; }
  for (const czesc of tekst.split(/(\n)/)) {
    if (czesc === '\n') nacisnij(13);
    else if (czesc) wyslij({ t: 'u', s: czesc });
  }
}

document.querySelectorAll('.klawisze [data-vk]').forEach((b) => {
  b.addEventListener('pointerdown', (e) => e.preventDefault()); // klawiatura telefonu zostaje otwarta
  b.addEventListener('click', () => nacisnij(Number(b.dataset.vk)));
});
document.querySelectorAll('.klawisze [data-mod]').forEach((b) => {
  b.addEventListener('pointerdown', (e) => e.preventDefault());
  b.addEventListener('click', () => {
    const m = Number(b.dataset.mod);
    if (modyfikatory.has(m)) modyfikatory.delete(m); else modyfikatory.add(m);
    odswiezModyfikatory();
  });
});

// Ukryte pole do pisania. Porównujemy jego treść przed i po zmianie: znikające znaki to Backspace,
// nowe to tekst. Tak działa też autokorekta i podpowiedzi klawiatury (słowo podmienione w całości).
const pisanie = $('#pisanie');
const ZAPAS = '​​​​'; // niewidoczne znaki: Backspace w „pustym” polu też coś kasuje
let poprzedni = ZAPAS;
let sklada = false;

function wyzerujPole() {
  pisanie.value = ZAPAS;
  poprzedni = ZAPAS;
  try { pisanie.setSelectionRange(ZAPAS.length, ZAPAS.length); } catch { /* nic */ }
}

function porownajPole() {
  const teraz = pisanie.value;
  let wspolne = 0;
  while (wspolne < poprzedni.length && wspolne < teraz.length && poprzedni[wspolne] === teraz[wspolne]) wspolne++;
  const usuniete = poprzedni.length - wspolne;
  const nowe = teraz.slice(wspolne);
  poprzedni = teraz;
  for (let i = 0; i < usuniete; i++) nacisnij(8);
  piszTekst(nowe.replace(/​/g, ''));
  if (teraz.length < 2 || teraz.length > 200 || teraz.endsWith('\n')) wyzerujPole();
}

// Porównujemy przy każdej zmianie, także w trakcie składania słowa przez klawiaturę (Gboard,
// podpowiedzi): litery pojawiają się na komputerze od razu, a podmiana słowa to Backspace + tekst.
pisanie.addEventListener('compositionstart', () => { sklada = true; });
pisanie.addEventListener('compositionend', () => { sklada = false; porownajPole(); });
pisanie.addEventListener('input', porownajPole);
pisanie.addEventListener('focus', () => { wyzerujPole(); $('#p-klawiatura').classList.add('aktywny'); });
pisanie.addEventListener('blur', () => $('#p-klawiatura').classList.remove('aktywny'));

// klawisze specjalne z fizycznej klawiatury (też tej podłączonej do telefonu/tabletu)
const SPECJALNE = { Escape: 27, Tab: 9, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46, Home: 36, End: 35, PageUp: 33, PageDown: 34, Insert: 45 };
pisanie.addEventListener('keydown', (e) => {
  const vk = SPECJALNE[e.key] || (/^F\d{1,2}$/.test(e.key) ? 111 + Number(e.key.slice(1)) : 0);
  if (vk) { e.preventDefault(); nacisnij(vk); return; }
  if (e.key === 'Enter' && !sklada) { e.preventDefault(); nacisnij(13); wyzerujPole(); return; }
  if ((e.ctrlKey || e.altKey || e.metaKey) && e.key.length === 1) {
    e.preventDefault();
    const mods = [e.ctrlKey && 17, e.altKey && 18, e.shiftKey && 16, e.metaKey && 91].filter(Boolean);
    for (const m of mods) klawisz(m, true);
    nacisnij(e.key.toUpperCase().charCodeAt(0));
    for (const m of mods) klawisz(m, false);
  }
});

// przeglądarka na komputerze bez pola tekstowego: klawisze jak w programie (kody klawiszy Windows)
window.addEventListener('keydown', (e) => {
  if (!sesjaWidoczna || document.activeElement === pisanie) return;
  e.preventDefault();
  klawisz(e.keyCode, true);
});
window.addEventListener('keyup', (e) => {
  if (!sesjaWidoczna || document.activeElement === pisanie) return;
  e.preventDefault();
  klawisz(e.keyCode, false);
});

// ---------------------------------------------------------------- pasek

$('#p-klawiatura').addEventListener('pointerdown', (e) => e.preventDefault());
$('#p-klawiatura').addEventListener('click', () => {
  if (document.activeElement === pisanie) pisanie.blur();
  else pisanie.focus({ preventScroll: true });
});

$('#p-klawisze').addEventListener('pointerdown', (e) => e.preventDefault());
$('#p-klawisze').addEventListener('click', () => {
  const k = $('#klawisze');
  k.hidden = !k.hidden;
  $('#p-klawisze').classList.toggle('aktywny', !k.hidden);
  requestAnimationFrame(przelicz);
});

$('#p-tryb').addEventListener('click', () => {
  ustawTryb(tryb === 'mysz' ? 'dotyk' : 'mysz');
  podpowiedz(tryb === 'mysz'
    ? 'Tryb myszy: przesuwaj palcem jak po touchpadzie. Stuknij: klik, dwa palce: przewijanie.'
    : 'Tryb dotyku: stuknij tam, gdzie chcesz kliknąć.');
});

$('#p-dopasuj').addEventListener('click', () => dopasuj());

const mozePelny = !!(document.documentElement.requestFullscreen);
$('#p-pelny').hidden = !mozePelny;
$('#p-pelny').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
});
document.addEventListener('fullscreenchange', () => {
  const pelny = !!document.fullscreenElement;
  $('#p-pelny').querySelector('[data-ik]').innerHTML = window.ikona(pelny ? 'pelny-wyjdz' : 'pelny');
  setTimeout(() => { if (sesjaWidoczna) dopasuj(); }, 120);
});

$('#p-rozlacz').addEventListener('click', () => zakoncz(null));

window.addEventListener('popstate', () => { if (sesjaWidoczna) zakoncz(null); });
window.addEventListener('beforeunload', () => { if (sesjaWidoczna) zwolnijWszystko(); });

// ---------------------------------------------------------------- start

if (!DOTYK) {
  // przeglądarka na komputerze: mysz i klawiatura działają wprost, przyciski dotykowe zbędne
  document.body.classList.add('mysz-pc');
  $('#p-klawiatura').hidden = true;
  $('#p-tryb').hidden = true;
  tryb = 'dotyk';
}
pokazOstatnie();
try {
  const z = new URLSearchParams(location.search).get('id');
  if (z && /^\d{9}$/.test(cyfry(z))) $('#rid').value = formatuj(z);
} catch { /* nic */ }
