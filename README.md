# LivePL Connect

Zdalna pomoc Live Production: program na Windows, pomocnik `host.exe`, serwer pośredniczący
i strona do sterowania z telefonu (connect.livepl.eu). Obraz ekranu i sterowanie idą bezpośrednio
między komputerami (WebRTC, szyfrowane DTLS). Serwer pośredniczący tylko kojarzy je po ID, a każde
połączenie wymaga hasła z komputera, z którym się łączysz.

## Co gdzie leży

| Folder | Co to |
|---|---|
| `connect/app` | program na Windows (Electron, bez electron-buildera): `src/` główny proces, `ui/` okna, `narzedzia/` budowanie instalatora |
| `connect/host` | pomocnik `host.exe` w Go: ekran, myszka, klawiatura, hasła (`go test ./...`) |
| `connect/server` | serwer pośredniczący (Go) i strona telefonu `server/web` |

## Autor i licencja

Autor: Karol Kowalski. Firma: Live Production. Copyright © 2026 Live Production Karol Kowalski.
LivePL Connect jest otwartym oprogramowaniem na licencji MIT (plik `LICENSE`). Prawa autorskie zgadzają się
z certyfikatem Certum Open Source Code Signing, którym podpisujemy programy. Te dane są:
- w `connect/app/package.json` (autor, licencja),
- w danych plików `LivePL Connect.exe`, `host.exe` i instalatora (firma „Live Production”, prawa autorskie),
- we wpisie „Aplikacje i funkcje” (wydawca „Live Production”),
- w oknie „O programie”, gdzie jest też pełna treść licencji. Budowanie sprawdza, czy ta treść zgadza się z `LICENSE`.

W programie licencja leży w `resources\app\LICENSE`. `LICENSE` i `LICENSES.chromium.html` w głównym folderze
programu to licencje Electrona i Chromium.

## Budowanie

Potrzebne: Windows, Node.js, Go 1.23 i `rcedit-x64.exe` (w `connect/app/narzedzia/instalator/` albo przez
`npm i -D rcedit`). Kompilator C# jest w Windows (.NET Framework 4).

1. Podnieś `version` w `connect/app/package.json`. Wersji, która już jest w folderze wydań, skrypt nie nadpisze:
   zainstalowane Connecty znają sumę pliku o tej nazwie.
2. Jeśli zmienił się kod w `connect/host`, zbuduj pomocnika:
   ```
   cd connect/host
   go build -trimpath -ldflags "-s -w -H windowsgui" -o host.exe .
   ```
3. Zbuduj instalator (ok. 1,5 min; pliki robocze idą do `%TEMP%`):
   ```
   cd connect/app
   npm install
   npm run instalator -- --zmiana "co nowego" --zmiana "druga zmiana"
   ```
   Wynik trafia obok folderu z kodem, do `..\Wydania\LivePL-Connect\<wersja>`: instalator,
   `na-serwer\wersja.json`, `na-serwer\latest.yml` i `CZYTAJ.txt` z sumą SHA-256 i informacją o podpisie.

Oficjalne wersje są podpisane certyfikatem Certum w chmurze (SimplySign Desktop): instalator,
`LivePL Connect.exe`, `host.exe` i każda biblioteka w środku. `d3dcompiler_47.dll` ma podpis Microsoftu
i zostaje bez zmian. Budowa do folderu wydań wymaga tego certyfikatu i bez niego przerywa się na początku.
Bez certyfikatu zbudujesz wersję próbną, bez podpisu, w innym folderze:
```
npm run instalator -- --do %TEMP%\connect-proba
```

Sumy liczone są z gotowego instalatora. Jeśli coś zmienia plik po zbudowaniu (np. podpis), musi się to
stać przed obliczeniem sum, inaczej Connecty odrzucą aktualizację.

## Serwer pośredniczący

```
cd connect/server
go build -o server .
CONNECT_ADDR=127.0.0.1:7000 CONNECT_WEB=./web ./server
```
Program łączy się przez `wss://`, więc serwer potrzebuje TLS: albo reverse proxy (np. nginx albo Caddy),
który przekazuje WebSocket `/ws`, albo własny certyfikat w `CONNECT_TLS_CERT` i `CONNECT_TLS_KEY`.
Program łączy się domyślnie z `wss://connect.livepl.eu:5938/ws`; inny adres ustawisz w programie.

## Aktualizacje w programie

`connect/app/src/aplikacja.js` co godzinę czyta `https://aktualizacje.livepl.eu/connect/wersja.json`,
pobiera instalator, sprawdza jego SHA-256 z `wersja.json` i instaluje go, gdy nikt nie jest połączony
(`--aktualizuj`). Stara wersja 0.4.1 przechodzi na nowe instalatory przez `latest.yml`.
