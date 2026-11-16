'use strict';
// Ikony LivePL: kreska 1.8 px na siatce 24×24 (ten sam styl co w przeglądarce LivePL).
window.IKONY = {
  monitor: '<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M9 20h6M12 16.5V20"/>',
  kopiuj: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6.3c0-1-.8-1.8-1.8-1.8H6.3c-1 0-1.8.8-1.8 1.8v7.4c0 1 .8 1.8 1.8 1.8h2.2"/>',
  odswiez: '<path d="M19 12.2a7 7 0 1 1-2.1-5"/><path d="M19.2 4.6v3.9h-3.9"/>',
  ustawienia: '<path d="M4.5 7h9M17.5 7h2M4.5 17h2M10.5 17h9"/><circle cx="15.5" cy="7" r="2"/><circle cx="8.5" cy="17" r="2"/>',
  minus: '<path d="M5.5 12h13"/>',
  maks: '<rect x="5.5" y="5.5" width="13" height="13" rx="1.6"/>',
  'przywroc-okno': '<rect x="5" y="8.5" width="10.5" height="10.5" rx="1.6"/><path d="M8.5 8.5V6.6c0-.6.5-1.1 1.1-1.1h7.8c.6 0 1.1.5 1.1 1.1v7.8c0 .6-.5 1.1-1.1 1.1h-1.9"/>',
  zamknij: '<path d="m7.5 7.5 9 9M16.5 7.5l-9 9"/>',
  strzalka: '<path d="M5 12h13.5M13 6.5l5.5 5.5-5.5 5.5"/>',
  tarcza: '<path d="M12 3.2 5 6v5.4c0 4.3 2.9 7.9 7 9.4 4.1-1.5 7-5.1 7-9.4V6z"/><path d="m9 12 2.2 2.2L15.3 10"/>',
  pelny: '<path d="M4.5 9V4.5H9M15 4.5h4.5V9M19.5 15v4.5H15M9 19.5H4.5V15"/>',
  'pelny-wyjdz': '<path d="M9 4.5V9H4.5M19.5 9H15V4.5M15 19.5V15h4.5M4.5 15H9v4.5"/>',
  rozlacz: '<path d="M12 4v7"/><path d="M7.4 6.9a7 7 0 1 0 9.2 0"/>',
  pobrane: '<path d="M12 4.5v10M7.8 10.6 12 14.8l4.2-4.2"/><path d="M4.8 16.2v1.9c0 .9.7 1.6 1.6 1.6h11.2c.9 0 1.6-.7 1.6-1.6v-1.9"/>',
  uwaga: '<path d="M12 4.2 2.9 19.5h18.2z"/><path d="M12 10v4.2M12 16.9h.01"/>',
  kosz: '<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/>',
  ok: '<path d="m5.5 12.5 4.2 4.2 8.8-9.4"/>',
  krzyzyk: '<path d="m7 7 10 10M17 7 7 17"/>',
  blyskawica: '<path d="M13.2 3 5.5 13.4h5.6L10.4 21l7.8-10.4h-5.6z"/>',
  polaczenie: '<circle cx="6.5" cy="13.5" r="3"/><circle cx="17.5" cy="10.5" r="3"/><path d="m9.4 12.7 5.2-1.4"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>',
  klucz: '<circle cx="8" cy="15.5" r="3.6"/><path d="m10.6 13 8.4-8.4M16.2 7.4l2.3 2.3M14 9.6l1.9 1.9"/>'
};

window.ikona = function ikona(nazwa, klasa) {
  return '<svg viewBox="0 0 24 24" class="ik' + (klasa ? ' ' + klasa : '') + '" aria-hidden="true">' + (window.IKONY[nazwa] || '') + '</svg>';
};
