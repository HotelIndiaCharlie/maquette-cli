# Provare le fondamenta CLI

Implementazione del 7 novembre 2026: HOT-54, HOT-55, HOT-63 e HOT-56. HOT-57 (hooks, agente headless, automazione JSON), HOT-61 e HOT-65 restano escluse. Nessun rilascio o merge è stato eseguito.

## Verifica automatica

Dalla cartella del repository, con Node >=24:

```sh
npm run typecheck
npm run test:unit
npm run smoke
npm run build
npm test
npm run test:foundations:live
npm run test:package
```

Unit test e smoke usano provider finti, motore stub e server MCP locali: non richiedono chiavi API. Le ultime tre prove richiedono macOS e il DesignCraft 0.13.0 fissato dal progetto, già installato (`maquette install-designcraft`). `test:package` crea un tarball e lo installa in una cartella temporanea senza dipendenze di sviluppo; può accedere al registro npm per installare le dipendenze. Non pubblica nulla.

`test:foundations:live` usa DesignCraft reale con risposte del modello scriptate: crea e salva un chart, lo aggiorna da un client MCP SDK separato, rende cinque pagine, riavvia il runtime e riprende la conversazione senza ripetere la creazione. Stampa il percorso dei documenti e dei journal temporanei. Non misura la qualità delle risposte di un modello reale.

## Prova personale: salvataggio e resume

Configura il provider/modello come descritto nel README e rendi disponibili le sue credenziali. Prepara una cartella di prova separata:

```sh
cd /Users/timwoodman/maquette-cli
npm run build
maquette_trial=$(mktemp -d /tmp/maquette-trial.XXXXXX)
cd "$maquette_trial"
node /Users/timwoodman/maquette-cli/dist/cli.js example
node /Users/timwoodman/maquette-cli/dist/cli.js
```

Al prompt Maquette:

```text
open_document example/annual-report.designcraft
inspect_document
```

Chiedi: «Crea il chart dei ricavi nello slot firstlight:slot:01 usando example/specs/01-revenue.json; poi salva esplicitamente working.designcraft». Approva le chiamate richieste. Controlla `chart_list`, poi `/sessions`: annota l'ID. Esci con `exit` e riparti **dalla stessa cartella**, nello stesso terminale:

```sh
node /Users/timwoodman/maquette-cli/dist/cli.js --resume
# Oppure: node /Users/timwoodman/maquette-cli/dist/cli.js --resume <id>
```

Chiedi cosa è stato fatto. Il modello deve ricordare la conversazione; il riavvio non apre documenti né ripete modifiche. Apri esplicitamente il file salvato e ispezionalo:

```text
open_document working.designcraft
inspect_document
chart_list
```

Deve esserci un solo chart. Chiedi ora una continuazione specificando di non ricrearlo. `/clear` apre una nuova conversazione; `/sessions` deve elencare anche quella precedente. La memoria della conversazione è nel journal `.maquette/sessions/<id>.jsonl`; il layout richiede sempre `save_document`.

I permessi `always` della vecchia sessione non vengono ripristinati. Se una chiamata è iniziata ma il risultato non è durabile, Maquette segnala l'esito incerto senza rieseguirla. Una riga finale incompleta produce una copia recuperata e conserva l'originale; corruzione interna o versione sconosciuta fermano la ripresa. Un secondo scrittore sulla stessa sessione è rifiutato: usare una nuova conversazione.

## Skills e /init

Elenco e dettagli funzionano senza modello o motore:

```sh
node /Users/timwoodman/maquette-cli/dist/cli.js skills
node /Users/timwoodman/maquette-cli/dist/cli.js skills chart
```

Al prompt prova `/skills`, `/report-review` o `/designcraft`. Il solo elenco non carica il corpo delle skills nel prompt. Il tool `skill` può leggere il corpo e le risorse testuali della skill risolta; non esegue script. Le chiamate successive conservano i normali permessi, anche in plan mode.

Per provare un override crea `.maquette/skills/brand-check/SKILL.md` nella cartella di prova:

```markdown
---
name: brand-check
description: Controlla la coerenza del documento con il brief del progetto.
---
Leggi brief.md, ispeziona e rendi la prima pagina. Riporta tre osservazioni con evidenza. Non modificare il documento.
```

Scrivi un `brief.md` con destinatari, tono e una regola grafica. `/skills` deve mostrare la nuova skill; `/<name>` si completa con Tab. `/brand-check` deve caricarla. La precedenza è `.maquette/skills` → `.claude/skills` → `~/.maquette/skills` → skills distribuite. YAML invalido, nomi non conformi e percorsi fuori dalla skill sono segnalati.

Prova poi:

```text
tree
tree --path example --depth 2
/init usa il brief presente nella cartella
```

La mappa deve escludere cartelle nascoste, node_modules, .git, .maquette e maquette-renders, collassare directory con oltre 20 elementi e indicare conteggi parziali quando incontra limiti. `document_survey` include la stessa mappa anche senza documento aperto. `/init` deve dichiarare e leggere al massimo cinque testi di supporto e tre immagini, citare i percorsi relativi nella memoria e non chiedere ciò che il brief già chiarisce. Se due guide contrastano, deve chiedere quale prevale. Ripetendo `/init`, verifica che proponga le modifiche a MAQUETTE.md e attenda l'accordo. I PDF restano non letti quando pdftotext non è già disponibile; nessun convertitore viene installato.

## Runtime condiviso e notifiche

Avvia prima Maquette nella cartella di prova, poi configura il client MCP esterno per lanciare **nella stessa cartella** e sulla stessa porta:

```json
{"mcpServers":{"maquette":{"command":"node","args":["/Users/timwoodman/maquette-cli/dist/cli.js","mcp","--port","8787"]}}}
```

Il client deve vedere gli stessi tool e lo stesso documento. Chiedigli un'ispezione e una modifica piccola, poi salva esplicitamente. Al turno successivo nel terminale, Maquette deve attribuire la modifica all'altro chiamante e richiedere un'ispezione prima di modifiche dipendenti. I client HTTP/MCP diretti usano l'autorizzazione del proprio host, indipendente dalla modalità di permessi del terminale.

Un client che si collega non arresta il runtime altrui. Se la facade ha avviato il runtime, ne è proprietaria: chiuderla arresta quel runtime. Tenere quindi aperto il terminale proprietario durante la prova. Una porta di un altro progetto/processo è rifiutata. Le modifiche a server esterni vengono attribuite all'app esterna, senza chiamarle modifiche del documento DesignCraft. Riavvio o perdita di eventi richiedono nuova ispezione.

Per server aggiuntivi, inserisci `.mcp.json` con `mcpServers`; sono supportati stdio, HTTP e SSE legacy esplicito. Usa `${ENV_VAR}` per le credenziali. La configurazione di progetto richiede `/mcp trust` e conferma esplicita della cartella/configurazione, poi `/mcp reconnect <name>`. Ogni modifica della configurazione invalida la fiducia. `/mcp` mostra stato, origine, trasporto e numero dei tool. I test dimostrano i trasporti con fixture locali; nessuna integrazione con Figma o servizi di ricerca reali è dichiarata.

## Compattazione

Dopo diverse conversazioni complete, prova `/compact` oppure `/compact concentrati sul lavoro ancora aperto`. Il contesto deve diventare un riepilogo più i gruppi recenti intatti. Il journal originale resta completo. I test verificano che firme e accoppiamenti chiamata/risultato siano conservati, e che errore o Ctrl-C lascino attivo il contesto precedente. Non c'è compattazione automatica lato client. I risultati pesanti vengono limitati alla prima acquisizione, con riferimenti al contenuto completo, senza riscrivere la storia già inviata.
