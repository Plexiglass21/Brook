# Brook

**Brook v1.1.0** è un’estensione per Google Chrome (Manifest V3) che rileva video e audio nelle pagine web. Permette di visualizzare un’anteprima e salvare file diretti (per esempio MP4 e WebM) con Chrome, oppure gestire HLS (`.m3u8`) e DASH (`.mpd`) attraverso un motore locale basato su **Python, yt-dlp e FFmpeg**.

> **Stato:** progetto sperimentale. Non tutti i siti e i formati sono supportati. Brook non aggira DRM, non estrae cookie o credenziali e non garantisce l’accesso a video protetti o riservati. Usa Brook solo per contenuti che sei autorizzato a scaricare.

## Funzioni

- Rilevamento delle sorgenti multimediali mediante richieste di rete e HTML della pagina.
- Elenco dei video trovati, con titolo, risoluzione e durata quando disponibili.
- Download diretto con Chrome per file video riconosciuti, **senza installare il motore Python**.
- Download di flussi HLS/DASH e analisi avanzata delle pagine con il motore locale.
- Anteprima diretta o generata localmente tramite FFmpeg, scelta della cartella e del nome file.
- Selezione di qualità e lingua audio quando l’analisi riesce a identificarle.

## Requisiti

- Google Chrome (versione 116 o successiva).
- Per **HLS/DASH, anteprime elaborate e analisi avanzata**: Python 3, pacchetto `yt-dlp` e programmi FFmpeg/FFprobe.
- Script di configurazione del motore forniti per **Windows e macOS**; Linux non dispone al momento di uno script di installazione dedicato.

## Installare Brook da GitHub

1. Apri il repository su GitHub, clicca **Code → Download ZIP**, estrai l’archivio e sposta la cartella in un luogo definitivo. **Non cancellare né spostare la cartella dopo aver collegato il motore locale.**
2. Apri Google Chrome e visita `chrome://extensions`.
3. Attiva **Modalità sviluppatore** in alto a destra.
4. Premi **Carica estensione non pacchettizzata** e seleziona la cartella **`extension`** (non la cartella principale del repository).
5. Usa l’icona Brook nella barra di Chrome, apri una pagina con un file video e avvia la riproduzione. I file diretti possono essere scaricati già adesso.

L’estensione chiede accesso alle pagine e alle richieste di rete per individuare le risorse video. I permessi e l’informativa sono documentati in [`PRIVACY.md`](PRIVACY.md).

## Abilitare HLS/DASH e le funzioni avanzate (Windows)

1. Installa **Python 3** dal sito ufficiale. Verifica che da PowerShell funzioni `py -3 --version`.
2. Installa `yt-dlp` da PowerShell:

   ```powershell
   py -3 -m pip install --upgrade yt-dlp
   ```

3. Installa **FFmpeg** e assicurati che `ffmpeg -version` e `ffprobe -version` funzionino da PowerShell. Se hai appena modificato il PATH, chiudi e riapri Chrome.
4. Da `chrome://extensions`, individua Brook e copia il suo **ID** (32 lettere).
5. Apri PowerShell nella cartella principale del progetto e lancia:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\native\install_windows.ps1 -ExtensionId "INCOLLA_QUI_ID_ESTENSIONE"
   ```

6. Chiudi tutte le finestre di Chrome, riaprilo e verifica che Brook indichi **Pronto**.

Lo script genera il file `native/com.streamscout.personal.json` **specifico del tuo PC** e registra l’host Native Messaging nel registro Windows. Questo file è escluso da Git e non va condiviso. Il nome tecnico `com.streamscout.personal` è mantenuto per compatibilità con le precedenti installazioni.

**Se Brook mostra “Motore offline”:** verifica che Python, `yt-dlp`, `ffmpeg` e `ffprobe` siano raggiungibili; ripeti lo script usando l’ID corretto. Per i file diretti non è necessario il motore locale.

## Abilitare HLS/DASH e le funzioni avanzate (macOS)

1. Installa Python 3, `yt-dlp` e FFmpeg/FFprobe (ad esempio FFmpeg con Homebrew: `brew install ffmpeg`).
2. Nella cartella del repository, installa `yt-dlp` usando l’interprete che verrà configurato:

   ```bash
   python3 -m pip install --upgrade yt-dlp
   ```

   Se Python è gestito da un package manager che blocca `pip`, configura prima un ambiente Python adatto; l’installer usa l’interprete `python3` individuato dal terminale.
3. Carica la cartella `extension` in Chrome, copia l’ID dell’estensione e dalla cartella principale esegui:

   ```bash
   bash native/install_macos.sh ID_ESTENSIONE
   ```

4. Chiudi e riapri Chrome. Per la finestra “Scegli dove salvare” il tuo Python deve includere `tkinter`; in alternativa disattiva la scelta manuale della cartella.

## Utilizzo

- Avvia un video nella scheda corrente e apri Brook.
- Per un MP4/WebM diretto, premi **Scarica** e scegli il nome/destinazione. Chrome gestisce il salvataggio del file originale.
- Per uno streaming HLS/DASH, verifica di aver installato il motore, premi **Scarica**, scegli qualità e formato quando disponibili e avvia il download.
- **Analizza pagina** prova a identificare contenuti non rilevati automaticamente. **Verifica sorgenti** analizza formato e tracce; questa operazione può richiedere richieste di rete ai siti da cui provengono i video.
- Il motore locale salva per impostazione predefinita in `Downloads/Brook/` se non scegli un’altra cartella.

## Test del progetto

Sono disponibili test automatici senza download reali:

```bash
python -m unittest discover -s tests -v
node tests/test_background.cjs
```

Node.js è necessario **solo** per eseguire il test JavaScript, non per utilizzare Brook.

## Sviluppo e pubblicazione

- Codice dell’estensione: `extension/`
- Motore Python e installer Native Messaging: `native/`
- Test: `tests/`
- Informativa: [`PRIVACY.md`](PRIVACY.md)
- Licenza: [`MIT`](LICENSE). Prima di rendere pubblico il repository, verifica che la licenza MIT rispecchi la tua volontà: consente anche ridistribuzione e uso commerciale del codice.

Per contribuire apri una Issue su GitHub e indica Chrome, sistema operativo, versione dell’estensione e riproduzione del problema **senza includere link firmati, cookie, token o dati personali**.

### Nota sulla distribuzione

GitHub rende disponibile il sorgente per l’installazione manuale in **Modalità sviluppatore**, ma non sostituisce il **Chrome Web Store**: per offrire il normale pulsante «Aggiungi a Chrome» occorre pubblicare separatamente la sola cartella `extension` nello Store. **Il motore locale non viene installato dal Chrome Web Store**: ha comunque bisogno di Python, FFmpeg e dello script di configurazione Native Messaging sul PC dell’utente.
