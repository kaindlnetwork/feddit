# Foto-Sortierung für PhotoPrism

Eine kleine Web-App, um die eigene [PhotoPrism](https://www.photoprism.app/)-Bibliothek
im Tinder-Stil auszusortieren: ein Foto nach dem anderen, per Wisch-Geste entscheiden.

| Geste | Taste | Wirkung |
| --- | --- | --- |
| nach rechts wischen | `→` / `D` | **Behalten** – optional zusätzlich in ein Album legen |
| nach links wischen | `←` / `A` | **Löschen** – das Foto wird in PhotoPrism archiviert |
| nach oben wischen | `↑` / `W` | **Behalten und Favorit** |
| Rückgängig-Knopf | `Z` / `⌫` | letzte Entscheidung zurücknehmen |
| Info-Knopf | `I` | Dateiname, Kamera, Auflösung, Größe |
| auf Video tippen | `Leertaste` | Video abspielen / pausieren |

Gelöschte Fotos landen im **PhotoPrism-Archiv** und können dort jederzeit
wiederhergestellt werden. Endgültiges Löschen von der Festplatte ist nur möglich,
wenn `ALLOW_PERMANENT_DELETE=true` gesetzt ist, und wird in den Einstellungen
ausdrücklich ausgelöst.

Der Fortschritt (welche Fotos bereits entschieden sind) wird serverseitig in
`DATA_DIR/state.json` gespeichert – man kann also jederzeit aufhören und auf
einem anderen Gerät weitermachen. Sortierung und Filter (PhotoPrism-Suchsyntax,
z. B. `year:2019`, `type:video`, `album:urlaub`) lassen sich in den Einstellungen wählen.

Die Oberfläche folgt dem Kaindl Network Design System (Tokens in `public/tokens.css`)
und unterstützt Hell- und Dunkelmodus.

## Start mit Docker Compose

```bash
# Werte in docker-compose.yml anpassen, dann:
docker compose up -d --build
```

Danach läuft die App auf <http://localhost:8080>.

## Start ohne Docker

Benötigt Node.js ≥ 20, keine weiteren Abhängigkeiten.

```bash
PHOTOPRISM_URL=http://localhost:2342 \
PHOTOPRISM_USERNAME=admin \
PHOTOPRISM_PASSWORD=geheim \
APP_PASSWORD=swipe \
npm start
```

## Konfiguration

| Variable | Standard | Beschreibung |
| --- | --- | --- |
| `PHOTOPRISM_URL` | `http://localhost:2342` | Adresse der PhotoPrism-Instanz |
| `PHOTOPRISM_TOKEN` | – | App-Passwort / Access-Token (`photoprism auth add`), alternativ zu Benutzername + Passwort |
| `PHOTOPRISM_USERNAME` / `PHOTOPRISM_PASSWORD` | – | Zugangsdaten eines PhotoPrism-Kontos mit Schreibrechten |
| `APP_PASSWORD` | – | Schützt die App per Browser-Login (Benutzername beliebig). **Dringend empfohlen**, sobald die App außerhalb des eigenen Rechners erreichbar ist |
| `KEEP_ALBUM` | – | Albumname; behaltene Fotos werden zusätzlich dort abgelegt (Album wird bei Bedarf angelegt) |
| `ALLOW_PERMANENT_DELETE` | `false` | Erlaubt das endgültige Löschen der hier archivierten Fotos |
| `PORT` | `8080` | HTTP-Port |
| `DATA_DIR` | `./data` | Speicherort für den Fortschritt |

## Aufbau

- `server.js` – kleiner Node-Server ohne Abhängigkeiten. Er hält die PhotoPrism-Zugangsdaten,
  stellt nur die wenigen benötigten Endpunkte bereit (`/api/batch`, `/api/decide`, `/api/undo`,
  `/api/purge`, `/api/reset`, `/api/stats`) und reicht Vorschaubilder und Videos durch.
  Die Zugangsdaten verlassen den Server nie.
- `public/` – statisches Frontend (HTML, CSS, Vanilla-JS) mit Wisch-Gesten, Tastatursteuerung
  und Vorladen der nächsten Bilder.
