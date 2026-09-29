# Overdracht: uniforme lichtaansturing Dreamscape (DMX + Zigbee)

> Voor Claude Code. Dit document legt de eisen, de research en de beslissingen tot nu toe vast. De implementatiekeuze ligt bij jou (en Jeroen). Onderaan staat een prototype dat je als referentie kunt gebruiken. Het is **niet** bindend.

## 1. Doel

Eén **programmeerbare interface** die twee soorten licht samen aanstuurt:

- **DMX-partylampen** via de **Light Rider LR512**-interface
- **Zigbee-lampen** via **Home Assistant**

Dit vervangt **Daslight 5**, omdat dat jaarlijks licentiekosten heeft.

## 2. Context

- Het licht is voor **Dreamscape editie IV, "The Alchemist's Shadow"**, een DIY micro-festival thuis in Alphen aan den Rijn. Het event is op **za 7 november 2026, van 16:00 tot ca. 23:00**.
- Dramaturgie: vier fasen/stations, **Aurum · Umbra · Ignis · Solve**. De spanning zit tussen warm (amber, koper, sepia) en koud (blauw, cyaan). Het publiek houdt van een langzame visuele opbouw, zonder overprikkeling. De lounge is stil.
- Jeroen is platform engineer: Kubernetes, homelab, Home Assistant met ZHA, ESP/WLED. Hij bouwt liever zelf dan dat hij off-the-shelf gebruikt. De visuals zijn eigen werk in de browser (WebGL).

## 3. Harde eisen (door Jeroen genoemd)

| Eis | Detail |
|---|---|
| **Alles op Linux** | Geen Windows-DLL's, geen Wine, geen Mac-only tools |
| **Taal** | TypeScript/Node |
| **Runtime** | Container op een bestaande server (Kubernetes/homelab) |
| **Bediening** | Web-UI op een tablet |
| **LR512** | Hergebruiken als dat haalbaar is: direct aansturen, zonder Daslight |
| **K8s-manifests** | **Geen `metadata.namespace`**: er wordt geapplyd in de target-namespace |

Heeft Jeroen **niet** gekozen, dus niet nodig tenzij hij het vraagt: MIDI-controller, automatische tijdlijn, entities in Home Assistant.

## 4. Hardware en wat we ervan weten

### Light Rider LR512 (Nicolaudie, zelfde fabrikant als Daslight)

- USB-C en **wifi**. Wifi werkt als **access point** (SSID `Smart DMX Interface XXXXXX`, wachtwoord op de sticker), in **station mode** (DHCP op het thuisnetwerk) of in **dual mode** (standaard).
- De besturing loopt over **poorten 2430 en 2431**. Volgens de gepubliceerde Nicolaudie-documentatie voor dezelfde productfamilie (zie §6) is **2430 UDP en 2431 TCP**. De LR512-datasheet noemt alleen de poortnummers.
- **Er is geen openbaar ontcijferd of gedecompileerd LR512-protocol te vinden.** Gezocht is naar GitHub-projecten, HA-integraties en forumdraden: niets gevonden (22-09-2026).
- **Geen Art-Net-ontvangst.** De Light Rider-app kan wel zelf Art-Net *sturen*, maar dat helpt ons niet.
- Gesloten protocol. QLC+, OLA en Home Assistant ondersteunen het voor zover bekend niet.
- **Afgevallen:** de Nicolaudie-SDK (`DasHard2006.dll`, `DasUsbCommand(cmd, param, buf)` met `DHC_INIT=9`, `DHC_OPEN=1`, `DHC_DMXOUT=4`, `DHC_CLOSE=2`, `DHC_EXIT=10`). Die werkt alleen op Windows, is waarschijnlijk 32-bit, en het is onbekend of hij de LR512 ondersteunt.
- Bronnen: [datasheet](https://storage.googleapis.com/nicolaudie-us-litterature/Release/lr512_datasheet.pdf), [Light Rider user guide](https://storage.googleapis.com/nicolaudie-us-litterature/Release/Light%20Rider%20Classic%20User%20Guide%20-%20EN.pdf)

### DMX-armaturen

- Spider moving heads: **8×15W RGBW**, twee balken met elk een eigen tilt-motor en eigen kleur.
- **De kanaalindeling is niet geverifieerd.** Aangenomen is de gangbare 15-kanaals modus: `tilt1, tilt2, speed, dimmer, strobe, R1,G1,B1,W1, R2,G2,B2,W2, programma's, reset`. **Vraag Jeroen om de handleiding of de display-modus**, en vraag ook hoeveel spiders er zijn en op welke adressen.

### Zigbee

- Home Assistant met **ZHA**, niet Zigbee2MQTT. Aansturing via de HA WebSocket API (`call_service light.turn_on/turn_off`).
- De entity_id's zijn nog onbekend: vraag ze op of haal ze op met `get_states`.

## 5. Beslissingen en ontwerpprincipes

1. **Twee snelheden.** DMX draait op ~40 fps en is geschikt voor beweging, chases en strobe. Zigbee is de trage ambiancelaag. Stuur **hooguit ~1 commando per lamp per seconde**, altijd met `transition`, en houd een globaal budget aan (~10 commando's per seconde). Anders loopt het mesh vol.
2. **Scènewissel naar Zigbee:** stuur de eindlook één keer, met `transition` gelijk aan de fadetijd. Stuur tijdens die fade niets tussendoor.
3. **Eén fixture-model voor beide werelden.** Attributen zijn genormaliseerd van 0 tot 1: dimmer, rood, groen, blauw, wit, pan, tilt, strobe. Kelvin voor tunable white is absoluut. Per protocol is er een aparte **output-adapter**. Daardoor is de DMX-output (LR512, Art-Net of sACN) uitwisselbaar zonder dat de show verandert.
4. **Scènes als complete looks** met crossfade. Effecten lopen door tijdens de fade. Daarnaast komen er **hold-knoppen** (flash/strobe, ingedrukt houden), een master en een blackout.
5. **De show als code of config in git** (YAML), met hot reload. Een ongeldige config mag de draaiende show nooit onderbreken.
6. **Kubernetes:** `hostNetwork: true`, omdat UDP-broadcast en -multicast naar het LAN niet door pod-networking heen komen. Verder `replicas: 1` en `strategy: Recreate`: twee engines tegelijk zouden om het DMX-universe vechten. Pin de pod op een node in hetzelfde LAN.
7. **Reservepad:** een Art-Net-node (bijv. DMXking eDMX1 PRO, ~€100–150) of een ESP32 met MAX485. Verander dan alleen de output-adapter. Houd dat pad open tot de LR512 aantoonbaar werkt, want de deadline is 7 november.

## 6. Grootste risico: het LR512-protocol

> **Besluit (22-09-2026):** Jeroen kiest voor **het ontcijferen van het LR512-protocol**, niet voor het kopen van een Art-Net-node. Claude doet de analyse van de captures; Jeroen levert de captures aan. Een Art-Net-node blijft alleen het noodplan als het niet lukt vóór de generale repetitie.

### 6.1 Wat wél openbaar is: Nicolaudie "STICK Remote Protocol"

Nicolaudie heeft voor de STICK-controllers een remote protocol gepubliceerd ([PDF](https://flexfireleds.com/content/Nicolaudie-Stick-DE3-Remote-Protocol.pdf)). Het gebruikt **dezelfde poorten** als de LR512, en is daarom de beste aanwijzing voor de protocolfamilie:

- **UDP 2430, "quick triggering"**, zonder authenticatie. Een pakket van 20 bytes:

  | Veld | Bytes | Waarde |
  |---|---|---|
  | ID | 8 | ASCII `Stick_3A` (`53 74 69 63 6B 5F 33 41`) |
  | OpCode | 2 | `6D 00` (109) |
  | Scene number | 2 | page × 50 + scene# |
  | Zone sync ID | 1 | |
  | Command | 1 | 0 = off, 1 = on, 5 = dimmer set, 6 = speed set, 7 = color set |
  | Dimmer | 2 | |
  | Speed | 2 | |
  | Unused | 2 | |
  | Color | 4 | RGBA |

- **Button simulation**: `Stick_3A` + opcode `0x65` + button ID + event (1 = click, 2 = touched, 3 = released, 4 = double, 5 = long) + value.
- **TCP 2431**: triggering, knoppen nabootsen en statusberichten. **Vanaf firmware v2 met authenticatie.** Maximaal 6 remote clients.
- **Er zit geen commando in om losse DMX-kanalen live te zetten.** Alleen opgeslagen scènes starten en daarop dimmer, snelheid en kleur toepassen.

Gevolgen voor dit project:
1. De live DMX-aansturing vanuit de Light Rider-app loopt vermoedelijk via **TCP 2431**, mogelijk na een login- of challenge-stap, of via een ongedocumenteerde opcode op 2430. **Captures moeten dus TCP én UDP bevatten.**
2. Het is onbekend of de LR512 exact hetzelfde protocol spreekt als de STICK (ID `Stick_3A` is productspecifiek). Controleer dat eerst.
3. **Gegarandeerd minimum (plan A-min):** scènes programmeren in de Light Rider-app, opslaan op de LR512, en ze vanuit de engine starten en dimmen via het gedocumenteerde UDP-triggerprotocol. Minder flexibel, maar het werkt zonder reverse-engineering, *als* de LR512 dit protocol ondersteunt.

### 6.2 Aanpak, in volgorde

**A. De Android-app decompileren en tegelijk captures maken (voorkeur).**

- De app is `com.lightingsoft.lightrider2` ([Google Play](https://play.google.com/store/apps/details?id=com.lightingsoft.lightrider2)). Haal de APK van je eigen toestel en decompileer hem met **jadx**:
  ```bash
  adb shell pm path com.lightingsoft.lightrider2
  adb pull <pad>/base.apk lightrider.apk
  jadx -d lightrider-src lightrider.apk
  ```
  Zoek naar `2430`, `2431`, `Stick_`, `Socket`, `DatagramPacket` en `DMX`, en naar de klassen die frames opbouwen: headers, opcodes, checksums, login. Is de app grotendeels native (`lib/*/*.so`, C++/Qt)? Gebruik dan `strings`, Ghidra en de exports van de `.so`-bestanden. Constanten zijn meestal nog te vinden.
- **Captures** bevestigen wat de code laat zien:
  - **PCAPdroid** op de Android-tablet (geen root nodig, exporteert een pcap), of
  - een **Linux-laptop als hotspot**, waar tablet én LR512 (in station mode) mee verbinden. **Filter op host, niet op UDP:**
    ```bash
    nmcli device wifi hotspot ifname wlan0 ssid lr-lab password '…'
    sudo tcpdump -i wlan0 -w <naam>.pcap host <ip-van-lr512>
    ```
  - Kan de LR512 alleen in AP-mode? Dan met een wifi-kaart in monitor mode, en WPA2 ontsleutelen in Wireshark met de PSK van de sticker. Leg daarvoor de 4-way handshake vast.
- Maak een aparte, korte opname per handeling, en start de app telkens opnieuw:

  | # | Bestand | Handeling |
  |---|---|---|
  | 1 | `connect.pcap` | app starten, verbinden, 10 s niets doen |
  | 2 | `vast.pcap` | ch1 = 17, ch2 = 34, ch3 = 51, ch512 = 255, 10 s laten staan (herkenbare waarden, ook bij encoding of compressie) |
  | 3 | `sweep-ch1.pcap` | ch1 langzaam 0 → 255 → 0, de rest op 0 |
  | 4 | `sweep-ch2.pcap` | idem ch2 |
  | 5 | `sweep-ch100.pcap` | idem ch100 |
  | 6 | `idle.pcap` | 60 s niets doen (keep-alive?) |
  | 7 | `scene.pcap` | een opgeslagen scène starten (vergelijk met het STICK-protocol) |

- Zoek naar: het transport (TCP 2431 of UDP 2430), de login- of handshake-stap, de header en opcode, sequence-bytes, de offset van kanaal 1, een checksum, en een keep-alive. Test ook of een replay werkt, en of de `Stick_3A`-triggers uit §6.1 werken.
- Het prototype bevat hiervoor al tools. Let op: `tools/pcap.ts` en `lr512-analyze` verwerken nu **alleen UDP** en moeten uitgebreid worden met TCP-stream-reassembly. Tot die tijd kun je Wireshark gebruiken (Follow TCP Stream).
- Of de app bij het koppelen van een interface online activeert (lightrider.com heeft een pagina "Activate your interface") is niet onderzocht. Kijk in de `connect`-capture of er verkeer naar internet gaat.

**B. USB via libusb/pyusb** (alleen als A vastloopt). Leer het protocol door Daslight in een Windows-VM met USB-passthrough te draaien en op de Linux-host `usbmon` plus Wireshark te gebruiken. Risico: Nicolaudie-interfaces laden soms bij het aansluiten eerst firmware. Kijk eerst met `lsusb -v`.

**C. Art-Net-node** als het bovenstaande niet op tijd lukt.

In de EU is reverse-engineering voor interoperabiliteit met eigen hardware in principe toegestaan.

## 7. Voorgestelde mijlpalen

1. **Hardware-bewijs:** één DMX-kanaal van een spider beweegt, vanaf Linux. Via de LR512 als het protocol bekend is, anders tijdelijk via Art-Net.
2. **Zigbee-bewijs:** fade van een lamp via de HA WebSocket API met throttling, zonder dat het mesh vastloopt (test met 5+ lampen tegelijk).
3. **Engine:** scènes, crossfade, effecten (minimaal breathe, wave, chase, vuur-flicker en een kleurovergang), holds, master en blackout.
4. **Tablet-UI** met fases en live status van de outputs.
5. **Container en manifests**, deploy op het homelab, en een **generale repetitie met alle hardware** ruim vóór 7 november.

## 8. Bestaand prototype (optioneel)

In de chat is een werkend prototype gemaakt: `dreamscape-lumen.tar.gz`, TypeScript, ongeveer 2.000 regels. Jeroen heeft aangegeven dat hij het **niet zo** wil implementeren. Gebruik het hooguit als referentie of als bron van losse onderdelen, en vraag Jeroen wat hij anders wil voordat je iets overneemt.

Wat erin zit, en wat daarvan is gevalideerd (unit tests, en een end-to-end-test tegen een nagemaakte HA en een Art-Net-sniffer):

- Art-Net- en sACN-packet-builders, getest op byte-layout.
- Een Home Assistant WebSocket-client met throttling, batching en een scène-transition-hint.
- Een pcap/pcapng-reader (Ethernet, raw IP, Linux SLL/SLL2) plus `lr512-analyze`, dat header, counters en fader-offset vindt en op synthetische captures correct werkte. Daarnaast `lr512-probe` (listen/send/replay/sweep).
- `tools/fake-ha.ts`, een nagemaakte HA-WebSocket om te repeteren zonder echte lampen.
- Een YAML-showformaat met multi-head-attributen (`red@2`, `tilt@1`), een virtuele dimmer en zod-validatie.

Bekende beperkingen:

- De LR512-codec is leeg.
- Het spider-profiel is aangenomen, niet gecontroleerd.
- Niets is getest op echte hardware.
- Geen MIDI of tijdlijn.
- Scène, master en blackout overleven een herstart niet.
- De output-chips in de UI worden bij elke state-update opnieuw opgebouwd.

## 9. Eerst aan Jeroen vragen

1. Wat wil hij anders dan in het prototype: architectuur, stack of scope?
2. De handleiding of kanaalmodus van de spiders, hoeveel het er zijn, en hun DMX-adressen.
3. De Zigbee entity_id's, en of hij ZHA-groepen gebruikt.
4. Draait de Light Rider-app op Android of op een iPad? Dat bepaalt de opnamemethode.
5. Op welke node of welk VLAN komt de container, en hoe is HA daarvandaan bereikbaar?
