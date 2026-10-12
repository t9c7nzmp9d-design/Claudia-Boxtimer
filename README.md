# Claudia Boxtimer

Einfacher Boxtimer als Web-App (PWA) fürs iPhone – private, nicht-kommerzielle Nutzung.

## Funktionen
- **Rundenzeit in Grün**, **Pausenzeit in Rot**, Vorbereitungszeit in Gelb – jeweils mit großer Zeitanzeige
- Beliebig viele **Profile** (anlegen, bearbeiten, duplizieren, löschen); Standardprofile: Boxen Amateur, Boxen Profi, Sparring, Sandsack, MMA, Muay Thai, Tabata
- **Klopfsignal 5 Sekunden** (einstellbar 0–30 s) vor jedem Wechsel, **Gong** bei jedem Wechsel, dreifacher Gong am Ende
- Start/Pause, nächste Phase überspringen, zurücksetzen
- Rundenzähler, Fortschrittsbalken, Vorschau der nächsten Phase, Restzeit gesamt
- Display bleibt wach (Wake Lock), Hoch- und Querformat, funktioniert offline
- Töne werden auf dem Gerät erzeugt; Lautstärke einstellbar
- Keine Daten verlassen das Gerät (siehe Datenschutzseite in der App)

## Veröffentlichen (GitHub Pages)
1. Diesen Branch nach `main` mergen.
2. Im Repository: **Settings → Pages → Build and deployment → Source: „Deploy from a branch“**, Branch `main`, Ordner **`/docs`** → Save.
3. Nach ca. 1 Minute ist die App unter `https://<benutzername>.github.io/claudia-boxtimer/` erreichbar.

## Auf dem iPhone installieren
Seite in **Safari** öffnen → **Teilen** → **„Zum Home-Bildschirm“**.

## Lokal testen
```
cd docs && python3 -m http.server 8000
```
