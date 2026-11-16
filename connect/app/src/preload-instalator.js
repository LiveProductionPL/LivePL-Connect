'use strict';
// Okno instalatora LivePL Connect: tylko te wywołania widzi strona instalatora.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('instalator', {
  stan: () => ipcRenderer.invoke('instalator:stan'),
  instaluj: (opcje) => ipcRenderer.invoke('instalator:instaluj', { pulpit: !!(opcje && opcje.pulpit) }),
  odinstaluj: (opcje) => ipcRenderer.invoke('instalator:odinstaluj', { dane: !!(opcje && opcje.dane) }),
  naPostep: (fn) => ipcRenderer.on('postep', (e, d) => fn(d)),
  uruchom: () => ipcRenderer.send('instalator:uruchom'),
  zamknij: () => ipcRenderer.send('instalator:zamknij'),
  minimalizuj: () => ipcRenderer.send('instalator:minimalizuj')
});
