# LivePL Connect

Zdalna pomoc Live Production: program na Windows, pomocnik `host.exe`, serwer pośredniczący
i strona do sterowania z telefonu (connect.livepl.eu). Obraz ekranu i sterowanie idą bezpośrednio
między komputerami (WebRTC, szyfrowane DTLS). Serwer pośredniczący tylko kojarzy je po ID, a każde
połączenie wymaga hasła z komputera, z którym się łączysz.

## Co gdzie leży

| Folder | Co to |
|---|---|
| `connect/app` | program na Windows (C# i WebView2, bez Electrona): `okno/` program i instalator, `ui/` strony okien, `narzedzia/` budowanie |
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

W programie licencja leży w `LICENSE` obok `LivePL Connect.exe`. `LICENSE-WebView2.txt` to licencja bibliotek
Microsoftu do silnika WebView2 (`Microsoft.Web.WebView2.*.dll`, `WebView2Loader.dll`), które leżą obok programu.

## Jak to działa (od 0.6.0)

Okno programu i instalatora to te same strony co wcześniej (`ui/index.html`, `ui/instalator.html`), ale
wyświetla je WebView2: silnik Microsoft Edge wbudowany w Windows 11 i w każdy aktualny Windows 10. Program
to mały `LivePL Connect.exe` w C# (.NET Framework 4.8, też wbudowany w Windows), który:
- daje stronom te same wywołania co wcześniej Electron (`window.lpc`, `window.instalator`, plik `okno/most.js`),
- rysuje okno bez ramki Windows (pasek tytułu rysuje strona, CSS `app-region: drag`) z cieniem i zaokrąglonymi rogami,
- uruchamia pomocnika `host.exe` i kończy go razem ze sobą (zadanie Windows), także po awarii,
- czyta i zapisuje te same ustawienia co wersja z Electronem (`%APPDATA%\LivePL Connect\ustawienia.json`:
  ID komputera, stałe hasło, serwer, autostart), więc po aktualizacji nic się nie zmienia,
- przy pierwszym starcie przenosi listę ostatnich połączeń z danych Electrona i sprząta jego pamięć podręczną.

Instalator ma ok. 5 MB zamiast 116 MB, a zainstalowany program ok. 12 MB zamiast ok. 265 MB. Gdy w Windows
brakuje WebView2 (rzadko: stary Windows 10 bez aktualizacji Edge, wersje LTSC), instalator pobiera go od
Microsoftu i sprawdza podpis Microsoftu. Przy aktualizacji bez WebView2 wraca poprzednia wersja programu.

## Budowanie

Potrzebne: Windows, Node.js, Go 1.23 i `rcedit-x64.exe` (w `connect/app/narzedzia/instalator/`). Kompilator C#
jest w Windows (.NET Framework 4), więc Visual Studio nie jest potrzebne. Biblioteki WebView2 budowanie pobiera
raz z NuGet (paczka `Microsoft.Web.WebView2` o wersji i sumie SHA-256 wpisanych w `narzedzia/program.mjs`),
sprawdza podpis Microsoftu i trzyma je w `%LOCALAPPDATA%\LivePL-Connect-budowanie`.

1. Podnieś `version` w `connect/app/package.json`. Wersji, która już jest w folderze wydań, skrypt nie nadpisze:
   zainstalowane Connecty znają sumę pliku o tej nazwie.
2. Zbuduj instalator (kilkanaście sekund; pomocnika `host.exe` skrypt sam buduje z `connect/host`, pliki
   robocze idą do `%TEMP%`):
   ```
   cd connect/app
   npm run instalator -- --zmiana "co nowego" --zmiana "druga zmiana"
   ```
   Wynik trafia obok folderu z kodem, do `..\Wydania\LivePL-Connect\<wersja>`: instalator,
   `na-serwer\wersja.json`, `na-serwer\latest.yml` i `CZYTAJ.txt` z sumą SHA-256 i informacją o podpisie.

Oficjalne wersje są podpisane certyfikatem Certum w chmurze (SimplySign Desktop): instalator,
`LivePL Connect.exe` i `host.exe`. Biblioteki WebView2 mają podpis Microsoftu i zostają bez zmian. Budowa do folderu wydań wymaga tego certyfikatu i bez niego przerywa się na początku.
Bez certyfikatu zbudujesz wersję próbną, bez podpisu, w innym folderze:
```
npm run instalator -- --do %TEMP%\connect-proba
```

Na próbę, bez instalowania: `npm start` składa program w `%TEMP%\LivePL-Connect-dev` i uruchamia go z osobnymi
ustawieniami (`LPC_DANE`) w trybie deweloperskim (`LPC_DEV=1`: bez autostartu i aktualizacji, z narzędziami
programisty w oknie). Potrzebny jest wtedy zbudowany `connect/host/host.exe`. Instalator próbnie, bez rejestru
i prawdziwych skrótów: `--cel=<folder>`.

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

Od 0.6.0 program instaluje pobraną aktualizację tylko wtedy, gdy ma ona ważny podpis Authenticode certyfikatem
z Certum wystawionym na „Open Source Developer Karol Kowalski” (lista w `okno/Systemowe.cs`, klasa `Podpis`).
Przy zmianie certyfikatu na taki z inną nazwą najpierw wydaj wersję, która zna nową nazwę, a dopiero potem
podpisuj nowym certyfikatem. Inaczej zainstalowane Connecty odrzucą aktualizację.

Nieudana aktualizacja (np. pliki w użyciu, brak WebView2) nie zostawia komputera bez programu. Nowa wersja
powstaje w folderze obok i podmienia starą dopiero na końcu, a przy błędzie wraca poprzednia wersja. Tej samej
wersji program nie próbuje potem sam przez 6 godzin (`aktualizacja-nieudana.txt` w `%LOCALAPPDATA%\LivePL Connect`).

`connect/app/okno/Aplikacja.cs` co godzinę czyta `https://aktualizacje.livepl.eu/connect/wersja.json`,
pobiera instalator, sprawdza jego SHA-256 z `wersja.json` i instaluje go, gdy nikt nie jest połączony
(`--aktualizuj`). Stara wersja 0.4.1 przechodzi na nowe instalatory przez `latest.yml`.
