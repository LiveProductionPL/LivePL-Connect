'use strict';

// LivePL Connect: punkt wejścia. Ten sam program jest aplikacją albo
// (z „--instalator” / „--odinstaluj”) swoim własnym instalatorem.

const tryb = process.argv.includes('--instalator') ? 'instaluj'
  : process.argv.includes('--odinstaluj') ? 'odinstaluj' : null;

if (tryb) require('./instalator').uruchom(tryb);
else require('./aplikacja').uruchom();
