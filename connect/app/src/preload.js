'use strict';
// Okno LivePL Connect: tylko te wywołania widzi strona. Nazwa „lpc” celowo nie pokrywa się
// z żadną funkcją strony (kolizja nazw z „connect” zatrzymywała kiedyś cały skrypt okna).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lpc', {
  stan: () => ipcRenderer.invoke('stan'),
  naStatus: (fn) => ipcRenderer.on('status', (e, d) => fn(d)),
  naAktualizacje: (fn) => ipcRenderer.on('aktualizacja', (e, d) => fn(d)),
  naOkno: (fn) => ipcRenderer.on('okno-stan', (e, d) => fn(d)),
  kopiuj: (tekst) => ipcRenderer.invoke('kopiuj', String(tekst)),
  noweHaslo: () => ipcRenderer.invoke('nowe-haslo'),
  ustawSerwer: (adres) => ipcRenderer.invoke('ustaw-serwer', String(adres || '')),
  sprawdzAktualizacje: () => ipcRenderer.invoke('sprawdz-aktualizacje'),
  aktualizuj: () => ipcRenderer.invoke('aktualizuj'),
  sesja: (trwa) => ipcRenderer.send('sesja', !!trwa),
  staleHaslo: (haslo) => ipcRenderer.invoke('stale-haslo', String(haslo || '')),
  usunStaleHaslo: () => ipcRenderer.invoke('stale-haslo-usun'),
  autostart: (wl) => ipcRenderer.invoke('autostart', !!wl),
  okno: (co) => ipcRenderer.send('okno', String(co))
});
