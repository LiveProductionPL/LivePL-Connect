// LivePL Connect: most między stroną okna a programem (WebView2). Daje stronie te same wywołania,
// które w wersji z Electronem dawał preload.js / preload-instalator.js: window.lpc albo window.instalator.
// Program wkleja tu RODZAJ ('lpc' albo 'instalator') i ROZMIAR (czy okno zmienia rozmiar).
(function () {
  'use strict';
  var wv = window.chrome && window.chrome.webview;
  if (!wv || window.lpc || window.instalator) return;
  var RODZAJ = '__RODZAJ__';
  var ROZMIAR = __ROZMIAR__;
  var PRZESUWANIE = __PRZESUWANIE__; // starszy WebView2 bez app-region: okno przesuwamy sami
  var licznik = 0;
  var czekajace = {};
  var sluchacze = {};

  wv.addEventListener('message', function (ev) {
    var m = ev.data;
    if (!m) return;
    if (m.id) {
      var c = czekajace[m.id];
      if (!c) return;
      delete czekajace[m.id];
      if (m.blad) c.zle(new Error(m.blad)); else c.ok(m.w);
    } else if (m.e) {
      (sluchacze[m.e] || []).forEach(function (fn) {
        try { fn(m.d); } catch (e) { console.error(e); }
      });
    }
  });

  function wywolaj(nazwa, argumenty) {
    return new Promise(function (ok, zle) {
      var id = ++licznik;
      czekajace[id] = { ok: ok, zle: zle };
      wv.postMessage({ id: id, m: nazwa, a: argumenty || [] });
    });
  }
  function wyslij(nazwa, argumenty) { wv.postMessage({ m: nazwa, a: argumenty || [] }); }
  function na(zdarzenie) {
    return function (fn) { (sluchacze[zdarzenie] = sluchacze[zdarzenie] || []).push(fn); };
  }

  if (RODZAJ === 'lpc') {
    window.lpc = Object.freeze({
      stan: function () { return wywolaj('stan'); },
      naStatus: na('status'),
      naAktualizacje: na('aktualizacja'),
      naOkno: na('okno-stan'),
      kopiuj: function (t) { return wywolaj('kopiuj', [String(t)]); },
      noweHaslo: function () { return wywolaj('nowe-haslo'); },
      ustawSerwer: function (a) { return wywolaj('ustaw-serwer', [String(a || '')]); },
      sprawdzAktualizacje: function () { return wywolaj('sprawdz-aktualizacje'); },
      aktualizuj: function () { return wywolaj('aktualizuj'); },
      sesja: function (trwa) { wyslij('sesja', [!!trwa]); },
      staleHaslo: function (h) { return wywolaj('stale-haslo', [String(h || '')]); },
      usunStaleHaslo: function () { return wywolaj('stale-haslo-usun'); },
      autostart: function (wl) { return wywolaj('autostart', [!!wl]); },
      okno: function (co) { wyslij('okno', [String(co)]); }
    });
  } else {
    window.instalator = Object.freeze({
      stan: function () { return wywolaj('instalator:stan'); },
      instaluj: function (o) { return wywolaj('instalator:instaluj', [{ pulpit: !!(o && o.pulpit) }]); },
      odinstaluj: function (o) { return wywolaj('instalator:odinstaluj', [{ dane: !!(o && o.dane) }]); },
      naPostep: na('postep'),
      uruchom: function () { wyslij('instalator:uruchom'); },
      zamknij: function () { wyslij('instalator:zamknij'); },
      minimalizuj: function () { wyslij('instalator:minimalizuj'); }
    });
  }

  // Starszy WebView2 nie zna app-region: element (albo jego przodek) z app-region: drag, bez bliższego
  // no-drag, przesuwa okno, a podwójne kliknięcie go maksymalizuje (tak jak pasek tytułu Windows).
  if (PRZESUWANIE) {
    var obszar = function (el) {
      for (; el && el.nodeType === 1; el = el.parentElement) {
        var s = getComputedStyle(el);
        var r = s.getPropertyValue('app-region') || s.getPropertyValue('-webkit-app-region');
        if (r === 'drag') return true;
        if (r === 'no-drag') return false;
        if (/^(BUTTON|INPUT|SELECT|TEXTAREA|A)$/.test(el.tagName)) return false;
      }
      return false;
    };
    document.addEventListener('mousedown', function (e) {
      if (e.button === 0 && e.detail === 1 && obszar(e.target)) { e.preventDefault(); wyslij('okno-przesun'); }
    }, true);
    document.addEventListener('dblclick', function (e) {
      if (ROZMIAR && obszar(e.target)) wyslij('okno', ['max']);
    }, true);
  }

  // Górna krawędź okna: boki i dół zmieniają rozmiar zwykłą ramką Windows, a górę zakrywa strona,
  // więc tu łapiemy wąski pasek i prosimy program o zmianę rozmiaru (jak w oknie z ramką).
  if (ROZMIAR) {
    var krawedz = null;
    var stanOkna = { max: false, pelny: false };
    function zbuduj() {
      if (krawedz || !document.body) return;
      krawedz = document.createElement('div');
      krawedz.setAttribute('aria-hidden', 'true');
      // no-drag: pasek tytułu strony (app-region: drag) inaczej przejąłby ten pasek i okno by się przesuwało
      krawedz.style.cssText = 'position:fixed;left:0;right:0;top:0;height:5px;z-index:2147483647;cursor:n-resize;background:transparent;app-region:no-drag;-webkit-app-region:no-drag';
      ['nw', 'ne'].forEach(function (r) {
        var rog = document.createElement('div');
        rog.style.cssText = 'position:absolute;top:0;width:10px;height:5px;cursor:' + r + '-resize;' + (r === 'nw' ? 'left:0' : 'right:0');
        rog.dataset.kierunek = r;
        krawedz.appendChild(rog);
      });
      krawedz.addEventListener('mousedown', function (e) {
        if (e.button !== 0) return;
        e.preventDefault();
        wyslij('okno-krawedz', [e.target.dataset.kierunek || 'n']);
      });
      document.body.appendChild(krawedz);
      odswiez();
    }
    function odswiez() { if (krawedz) krawedz.style.display = stanOkna.max || stanOkna.pelny ? 'none' : 'block'; }
    na('okno-stan')(function (o) { stanOkna = o || stanOkna; odswiez(); });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', zbuduj); else zbuduj();
  }
})();
