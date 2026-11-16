'use strict';
// Ikony LivePL: kreska 1.8 px na siatce 24×24 (te same co w programie LivePL Connect).
window.IKONY = {
  strzalka: '<path d="M5 12h13.5M13 6.5l5.5 5.5-5.5 5.5"/>',
  tarcza: '<path d="M12 3.2 5 6v5.4c0 4.3 2.9 7.9 7 9.4 4.1-1.5 7-5.1 7-9.4V6z"/><path d="m9 12 2.2 2.2L15.3 10"/>',
  pelny: '<path d="M4.5 9V4.5H9M15 4.5h4.5V9M19.5 15v4.5H15M9 19.5H4.5V15"/>',
  'pelny-wyjdz': '<path d="M9 4.5V9H4.5M19.5 9H15V4.5M15 19.5V15h4.5M4.5 15H9v4.5"/>',
  rozlacz: '<path d="M12 4v7"/><path d="M7.4 6.9a7 7 0 1 0 9.2 0"/>',
  monitor: '<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M9 20h6M12 16.5V20"/>',
  kosz: '<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/>',
  klawiatura: '<rect x="2.8" y="6" width="18.4" height="12" rx="2"/><path d="M6.5 9.5h.01M9.5 9.5h.01M12.5 9.5h.01M15.5 9.5h.01M17.5 12.3h.01M6.5 12.3h.01M9.5 12.3h.01M12.5 12.3h.01M8.5 15h7"/>',
  klawisze: '<rect x="3.5" y="4" width="7" height="7" rx="1.6"/><rect x="13.5" y="4" width="7" height="7" rx="1.6"/><rect x="3.5" y="14" width="17" height="6" rx="1.6"/><path d="M6.2 7.5h1.6M16.2 7.5h1.6"/>',
  dotyk: '<path d="M9.5 11.5V5.8a1.6 1.6 0 0 1 3.2 0v5.2"/><path d="M12.7 10.4a1.6 1.6 0 0 1 3.2 0v1.2M15.9 11a1.6 1.6 0 0 1 3.2.4v3.4c0 3.4-2.4 5.7-5.7 5.7h-.8c-2 0-3.3-.8-4.4-2.4l-2.6-3.9a1.6 1.6 0 0 1 2.6-1.8l1.5 1.7"/>',
  mysz: '<rect x="6.5" y="3.5" width="11" height="17" rx="5.5"/><path d="M12 3.5v6M6.5 9.5h11"/>',
  dopasuj: '<path d="M4.5 9V6.3c0-1 .8-1.8 1.8-1.8H9M15 4.5h2.7c1 0 1.8.8 1.8 1.8V9M19.5 15v2.7c0 1-.8 1.8-1.8 1.8H15M9 19.5H6.3c-1 0-1.8-.8-1.8-1.8V15"/><rect x="8.5" y="8.5" width="7" height="7" rx="1.2"/>'
};

window.ikona = function ikona(nazwa, klasa) {
  return '<svg viewBox="0 0 24 24" class="ik' + (klasa ? ' ' + klasa : '') + '" aria-hidden="true">' + (window.IKONY[nazwa] || '') + '</svg>';
};
