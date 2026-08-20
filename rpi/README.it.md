# Immagine Raspberry Pi di FoodDesk

Un'appliance pronta all'uso: scrivi la scheda, accendi il Raspberry, ti
colleghi al suo Wi-Fi e prendi le comande. Alla festa non serve nessuna
conoscenza di Linux.

*Prefer English? → [README.md](README.md)*

**Hardware**: consigliato Raspberry Pi 4 (2 GB+) o Pi 5; Pi 3 / Zero 2 W
vanno bene per allestimenti piccoli. La radio integrata serve senza
problemi ~10–20 dispositivi — per una squadra più grande collega un vero
access point alla porta Ethernet (l'AP del Pi è una comodità, non un
requisito).

## Come si usa

1. Scarica `fooddesk-rpi-<versione>.img.xz` dalla
   [pagina delle release](https://github.com/adefilippo83/FoodDesk/releases)
   e scrivilo sulla microSD con
   [Raspberry Pi Imager](https://www.raspberrypi.com/software/) o `dd`
   (salta la personalizzazione OS dell'Imager: l'immagine si configura da
   sola).
2. *(Facoltativo)* Reinserisci la scheda nel computer e modifica
   **`fooddesk.txt`** sulla piccola partizione `bootfs` — vedi
   [Configurazione](#configurazione-fooddesktxt). Puoi farlo anche dopo: il
   file viene riletto a ogni avvio.
3. Inserisci la scheda, accendi, aspetta ~2 minuti per il primo avvio.
4. Collegati al Wi-Fi **FoodDesk** (password predefinita `fooddesk-wifi`) e
   apri **http://10.42.0.1/** — oppure `http://fooddesk.local/`, o in
   realtà qualunque indirizzo: il DNS dell'AP risponde sempre con il Pi.
5. Credenziali: la **password admin** generata viene scritta in
   **`fooddesk-info.txt`** sulla partizione `bootfs` (leggibile da
   qualunque computer) e mostrata su uno schermo HDMI collegato.

## Configurazione (`fooddesk.txt`)

Tutta la configurazione della festa vive in un solo file,
**`fooddesk.txt`**, sulla piccola partizione FAT della scheda (`bootfs`) —
quella che qualunque portatile Windows/macOS/Linux sa aprire. L'immagine lo
include già con esempi commentati. Regole del formato: un `KEY=VALORE` per
riga, senza virgolette (gli spazi nei valori vanno bene), le righe che
iniziano con `#` sono ignorate, i fine riga Windows sono tollerati.

Un esempio compilato:

```ini
# Rete Wi-Fi a cui si collegano i dispositivi della festa (password: 8+ caratteri).
WIFI_SSID=SagraBorgo
WIFI_PASSWORD=festa2026!

# Codice paese Wi-Fi di due lettere (dominio regolatorio).
WIFI_COUNTRY=IT

# Mostrato sugli scontrini; modificabile anche dopo dalle Impostazioni.
RESTAURANT_NAME=Sagra del Borgo

# Lingua dei documenti stampati: it, en, es, fr, pt.
PDF_LANG=it

# Collega uno schermo touch HDMI e imposta "kitchen" per avviare
# direttamente il display cucina; "off" per spegnere il kiosk.
KIOSK=kitchen
```

| Chiave | Default | Cosa fa |
|---|---|---|
| `WIFI_SSID` | `FoodDesk` | Nome della rete Wi-Fi creata dal Pi |
| `WIFI_PASSWORD` | `fooddesk-wifi` | Password WPA2, minimo 8 caratteri (valori più corti vengono ignorati) |
| `WIFI_COUNTRY` | `IT` | Codice paese di due lettere per la radio |
| `RESTAURANT_NAME` | — | Intestazione degli scontrini; le Impostazioni dell'app possono cambiarla in seguito |
| `PDF_LANG` | `it` | Lingua dei documenti stampati: `it`, `en`, `es`, `fr`, `pt` |
| `ADMIN_PASSWORD` | *(generata)* | Lascia commentata: al primo avvio viene generata una password casuale. Impostarla **(re)imposta la password admin al riavvio successivo** |
| `KIOSK` | *(spento)* | `kitchen` avvia lo schermo collegato come display cucina; `off` lo disattiva |

### Cambiare la configurazione in seguito

Modifica `fooddesk.txt` — mettendo la scheda in un portatile, oppure via
SSH (`sudo nano /boot/firmware/fooddesk.txt`) — e **riavvia**. Il servizio
di provisioning rilegge il file ogni volta che è cambiato e lo riapplica;
a un avvio normale con file invariato non fa nulla. Dopo ogni
applicazione, `fooddesk-info.txt` e il volantino QR accanto vengono
riscritti di conseguenza.

Due garanzie da conoscere:

- **Il database non viene mai toccato** dalla riconfigurazione — ordini,
  menù e account sopravvivono a qualunque modifica e riavvio.
- **La password admin non cambia mai, a meno che tu non imposti
  esplicitamente `ADMIN_PASSWORD`.** Che è anche il recupero per una
  password persa: scrivi `ADMIN_PASSWORD=qualcosa` nel file, riavvia,
  accedi, poi togli la riga (altrimenti la prossima modifica alla
  configurazione la reimposterebbe di nuovo).

## Cosa c'è dentro

- Raspberry Pi OS Lite (arm64, Trixie) + Node 24
- FoodDesk come servizio systemd blindato dietro nginx sulla porta 80,
  database in `/var/lib/fooddesk`, fotografato ogni 15 minuti in
  `/var/backups/fooddesk` (le stesse unit di `deploy/`)
- Un profilo access point NetworkManager (`fooddesk-ap`): WPA2, DHCP + DNS
  via `ipv4.method=shared`, DNS pigliatutto così qualunque URL digitato
  porta a FoodDesk
- **Funziona senza internet**: nginx risponde ai controlli di connettività
  dei sistemi operativi (Android `generate_204`, Apple `hotspot-detect`,
  NCSI di Windows, Firefox), quindi telefoni e portatili considerano l'AP
  online — niente richieste di captive portal, niente avvisi "senza
  internet", niente passaggi alla rete mobile. Un hook dispatcher di
  NetworkManager riporta automaticamente il DNS dell'AP all'inoltro
  normale appena viene collegato un uplink vero (Ethernet o tethering
  USB), dando ai client internet reale via NAT invece delle risposte finte
- Provisioning (`fooddesk-provision.service`): applica `fooddesk.txt` al
  primo avvio e lo riapplica ogni volta che il file cambia; crea l'account
  admin e scrive `fooddesk-info.txt` + il volantino QR
- Login di manutenzione `fooddesk-admin` (sudo, SSH abilitato) — la password,
  diversa per ogni dispositivo, viene generata al primo avvio e scritta in
  `fooddesk-info.txt`; ti viene chiesto di cambiarla al primo accesso
- La Ethernet resta libera: collega un uplink per internet o una stampante
  di rete

## Stampa

FoodDesk invia i ticket cucina come PDF, quindi la stampante ha bisogno di
una coda CUPS capace di PDF:

- **Plug-and-play**: collega una stampante USB che parla IPP (la maggior
  parte delle stampanti dal ~2016 in poi, via `ipp-usb`) e l'appliance
  crea da sola una coda driverless chiamata `kitchen`, ci punta
  `KITCHEN_PRINTER` e riavvia l'app. I ticket si stampano e basta. Vale lo
  stesso per le stampanti di rete IPP sulla porta Ethernet.
- **Tutto il resto** (stampanti termiche più vecchie che richiedono un
  driver): apri l'interfaccia web di CUPS su **http://10.42.0.1:631/** da
  un portatile sul Wi-Fi FoodDesk, accedi come `fooddesk-admin` e aggiungi
  la stampante con il nome coda `kitchen`. L'helper hotplug collega
  `KITCHEN_PRINTER` appena la coda esiste.
- Nessuna stampante: resta il solito ripiego della finestra di stampa del
  browser.

## Il volantino della festa

Il provisioning scrive anche **`fooddesk-leaflet.pdf`** sulla partizione
boot: una pagina A4 con due codici QR — collegati al Wi-Fi, apri FoodDesk
— in italiano e inglese. Stampalo e attaccalo dove si radunano i
camerieri. Riporta la password del Wi-Fi ma mai le credenziali admin.

## Modalità kiosk: il Pi è il display cucina

Collega uno schermo HDMI (meglio se touch), imposta `KIOSK=kitchen` in
`fooddesk.txt`, riavvia — il Pi si avvia direttamente sul display cucina:
Chromium a tutto schermo su un compositor Wayland minimale, senza bisogno
di tablet. `KIOSK=off` (e un riavvio) lo spegne.

Sotto il cofano: il provisioning crea un account con ruolo cucina e una
password casuale inutilizzabile e imposta `KIOSK_AUTOLOGIN_USER` in
`/etc/fooddesk/env`; il browser kiosk accede da solo tramite
`/api/auth/kiosk`, una rotta che esiste solo quando quella variabile è
impostata, risponde solo sull'interfaccia loopback (mai attraverso nginx)
e accetta solo account con ruolo cucina — un telefono sul Wi-Fi della
festa non può usarla in nessun modo.

## Fatto per le condizioni delle feste

- **Stacchi di corrente**: i log vivono in RAM (journald volatile), non
  c'è swapfile e i lavori in background di apt/man-db sono spenti — la
  scheda SD non vede quasi scritture oltre al database WAL (sicuro per
  design contro le scritture troncate) e ai suoi snapshot ogni 15 minuti.
  Staccare la spina in pratica non è un evento; compra comunque una SD
  decente.
- **Blocchi**: il watchdog hardware riavvia in pochi secondi una macchina
  impallata; il servizio FoodDesk riparte sempre da solo in caso di crash.

## Backup su chiavetta USB

Il backup è **opt-in per chiavetta**: una chiavetta prestata per spostare
foto non deve portarsi via l'incasso della serata e gli hash delle password
del personale. Prepara la chiavetta una volta sola creando un file vuoto
chiamato `FOODDESK_BACKUP` nella sua radice — da qualsiasi computer:

```bash
touch /media/<la-tua-chiavetta>/FOODDESK_BACKUP
```

Inserisci quella chiavetta (FAT32/exFAT/ext4) nel Pi: riceve una cartella
`fooddesk-backups/` con lo storico degli snapshot più uno nuovo, poi si
aggiorna ogni 15 minuti finché resta inserita. Una chiavetta senza il file
marcatore viene lasciata completamente in pace, e l'appliance si rifiuta di
copiare i backup sul proprio disco di sistema (un Pi avviato da SSD USB).
Il resto della chiavetta non viene toccato. I mount sono sincroni, quindi
sfilarla senza cerimonie va bene: al massimo perdi lo snapshot in scrittura
in quell'istante, mai quelli precedenti. Lascia una chiavetta inserita per
tutto il servizio e l'incasso della serata sopravvive anche a una microSD
morta.

## Aggiornamenti

Con un uplink internet collegato:

```bash
sudo fooddesk-update            # ultima release (oppure: fooddesk-update v1.2.3)
```

Fa uno snapshot del database, scarica il tarball della release, installa,
scambia e verifica la salute del servizio — tornando indietro da solo se
la nuova versione non parte. `sudo fooddesk-update --rollback` riporta
alla versione precedente in qualunque momento.

I tuoi dati non vengono mai buttati via, ma il database *viene* modificato:
la nuova versione migra lo schema all'avvio, ed è per questo che prima viene
fatto uno snapshot. Se durante un rollback la versione precedente non riesce
a leggere lo schema migrato, l'updater ripristina quello snapshot da solo e
te lo dice.

## Compilarla da soli

L'immagine viene prodotta da `.github/workflows/rpi-image.yml` a ogni
release: la build di web e server gira nativamente sul runner, poi
`rpi/setup.sh` personalizza l'immagine Raspberry Pi OS di serie dentro un
chroot QEMU (`pguyot/arm-runner-action`) e il risultato viene compresso e
allegato alla release con il suo SHA256.

**Provare una modifica**: le PR che toccano `rpi/**` (o il workflow)
compilano l'immagine automaticamente — scarica la `.img.xz` dagli artifact
della run. Per qualunque altro branch, lancia il workflow a mano dalla tab
Actions (*workflow dispatch*, scegliendo il branch).

Ogni build viene anche **avviata e testata in CI** (`rpi/test-image.sh`):
una copia dell'immagine parte sotto systemd-nspawn con emulazione arm64, e
la run verifica il provisioning del primo avvio, la salute dell'app, le
risposte di nginx ai controlli di connettività, un login vero con la
password admin generata, e che modificare `fooddesk.txt` venga riapplicato
al riavvio senza toccare quella password.

Anche il **Wi-Fi viene testato** (`rpi/test-wifi.sh`): il simulatore
`mac80211_hwsim` del kernel dà alla CI due radio virtuali — una entra nel
container avviato, dove NetworkManager attiva il vero profilo
`fooddesk-ap`, l'altra fa il telefono del cameriere: si collega alla rete
WPA2, riceve un indirizzo DHCP, risolve i nomi tramite il DNS pigliatutto
(compreso l'IP magico NCSI di Windows), supera il controllo Android e fa
login su FoodDesk attraverso l'aria simulata — poi si ricollega dopo una
riconfigurazione di SSID e password. (Portata e capacità della radio
vera, stampanti e comportamento all'accensione restano compito del test
su hardware vero.)
