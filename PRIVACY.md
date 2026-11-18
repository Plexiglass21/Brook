# Informativa privacy — Brook

Brook è un’estensione Chrome per rilevare risorse multimediali nelle pagine visitate e, su richiesta dell’utente, salvarle sul computer.

## Dati trattati

- Per individuare i video, l’estensione legge gli URL delle risorse multimediali, il titolo della pagina, le informazioni del player e alcuni metadati dei siti visitati.
- Questi dati vengono elaborati localmente nel browser; le sorgenti rilevate e lo stato dei download sono conservati nella memoria di sessione dell’estensione.
- La preferenza relativa alla scelta della destinazione del download è salvata localmente nel browser.
- Quando l’utente richiede analisi, anteprima o download, il programma locale interroga direttamente le URL indicate, utilizzando `yt-dlp` e/o FFmpeg. Le richieste sono quindi visibili ai server che ospitano le risorse, come accade con le normali richieste di rete.

## Trasmissione e conservazione

Il codice fornito nel repository non implementa account, telemetria, analisi statistiche o invio di dati a un server gestito dal progetto Brook. I file vengono salvati nella destinazione scelta dall’utente.

Brook non legge tramite API dell’estensione i cookie, le password o i contenuti dei moduli. I siti web, Chrome e i componenti esterni usati dall’utente (tra cui yt-dlp e FFmpeg) hanno proprie condizioni e pratiche di trattamento dei dati.

## Controllo e rimozione

Puoi interrompere l’uso di Brook disattivando o rimuovendo l’estensione. La rimozione dell’estensione non rimuove automaticamente il motore Python registrato nel sistema né i file scaricati.

Questa pagina descrive il comportamento del codice pubblicato. Prima di usarla per una scheda Chrome Web Store, il maintainer deve verificarne la corrispondenza con la versione effettivamente distribuita e fornire un contatto pubblico per richieste relative alla privacy.
