// npm start: składa program do %TEMP%\LivePL-Connect-dev i uruchamia go w trybie deweloperskim
// (LPC_DEV=1: bez autostartu w rejestrze i bez aktualizacji, z narzędziami programisty w oknie).
// Osobne ustawienia (LPC_DANE), żeby nie ruszać prawdziwego ID i hasła tego komputera.
//   npm start                      zwykłe okno
//   npm start -- --instalator      okno instalatora (z --cel=<folder> instaluje próbnie do tego folderu)
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zbudujProgram } from './program.mjs';

const katalog = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = process.env.TEMP || process.env.TMP || '.';
const cel = join(tmp, 'LivePL-Connect-dev', 'program');
const wersja = JSON.parse(readFileSync(join(katalog, 'package.json'), 'utf8')).version;
const host = join(katalog, '..', 'host', 'host.exe');
if (!existsSync(host)) throw new Error('Brak host.exe: zbuduj connect/host (go build -trimpath -ldflags "-s -w -H windowsgui" -o host.exe .)');
await zbudujProgram(cel, { wersja, hostExe: host, robocze: join(tmp, 'LivePL-Connect-dev', 'robocze') });
const env = { ...process.env, LPC_DEV: '1', LPC_DANE: process.env.LPC_DANE || join(tmp, 'LivePL-Connect-dev', 'dane') };
spawn(join(cel, 'LivePL Connect.exe'), process.argv.slice(2), { cwd: cel, env, detached: true, stdio: 'ignore' }).unref();
console.log('Uruchomiono ' + join(cel, 'LivePL Connect.exe') + ' (dane: ' + env.LPC_DANE + ')');
