# Provare le fondamenta CLI

Implementazione del 7 novembre 2026: HOT-54, HOT-55, HOT-63 e HOT-56, con follow-up UX e protezione chart_update HOT-108 su `codex/cli-foundations-ux`. Le cinque issue hanno l'etichetta Linear **CLI foundations UX**. HOT-57 (hooks, agente headless, automazione JSON), HOT-61 e HOT-65 restano escluse; anche preservazione dei ritocchi HOT-66, valori/reset/detach HOT-95 e aggiornamenti proposti/watch/pannello HOT-91 restano fuori da questo intervento. Nessun rilascio o merge è stato eseguito.

## Verifica automatica

Dalla cartella del repository, con Node >=24:

```sh
npm run typecheck
npm run test:unit
npm run smoke
npm run build
npm test
npm run test:foundations:live
npm run test:chart-safety:live
npm run test:package
```

Unit test e smoke usano provider finti, motore stub e server MCP locali: non richiedono chiavi API. Le ultime quattro prove richiedono macOS e il DesignCraft 0.13.0 fissato dal progetto, già installato (`maquette install-designcraft`). `test:package` crea un tarball e lo installa in una cartella temporanea senza dipendenze di sviluppo; può accedere al registro npm per installare le dipendenze. Non pubblica nulla.

`test:foundations:live` usa DesignCraft reale con risposte del modello scriptate: crea e salva un chart, lo aggiorna da un client MCP SDK separato, rende cinque pagine, riavvia il runtime e riprende la conversazione senza ripetere la creazione. Stampa il percorso dei documenti e dei journal temporanei. Non misura la qualità delle risposte di un modello reale.

`test:chart-safety:live` usa oggetti DesignCraft reali. Verifica input invalido e CSV assente senza effetti; inietta un errore dopo il primo effetto di disegno e dopo la prima etichetta definitiva, poi confronta il documento e il registro con l'originale. Verifica inoltre spostamento dell'intero gruppo, preview fallita dopo un aggiornamento riuscito e rifiuto dopo un ritocco interno. I guasti di connessione e pulizia sono coperti separatamente dai test unitari deterministici.

Per ripetere solo le nuove prove senza DesignCraft né chiavi:

```sh
cd /Users/timwoodman/maquette-cli
node --test test/unit/cli-ux.test.ts test/unit/chart-safety.test.ts
```

Le prove UX inviano veri tasti al componente Ink: Ctrl-C/Esc durante `/compact`, Ctrl-C durante un tool non cancellabile, paginazione, dettaglio Ctrl-O, mantenimento degli input in coda e ripresa dei journal precedenti.

## Prova personale delle novità UX

Prepara la cartella temporanea come nella sezione successiva. Anche senza chiamare un modello puoi provare input, tool diretti, ripresa e shell:

```text
/sessions
inspect_document
/clear
!echo Second conversation
/resume
```

Ogni invio deve lasciare una sola riga `❯`. `/resume` mostra titoli, data, provider/modello e ID; la conversazione corrente e quelle occupate sono disabilitate. Seleziona la prima conversazione con frecce e Invio: l'header deve precedere i turni ripristinati e spiegare che documento e permessi `always` non vengono ripristinati. Nessun tool viene rieseguito. `/resume <id>` evita il menu; Esc lo chiude senza cambiare conversazione. Provider, modello e modalità dei permessi rimangono quelli correnti.

Esci e riavvia dalla stessa cartella: scegli fra nuova conversazione, selezionata di default, e le tre più recenti non vuote. Non serve più rilanciare il processo per cambiare conversazione. Con oltre dieci conversazioni, `/resume` deve mostrare **Next page** in posizione 11 e **Previous page** dopo le voci successive. Le sessioni vuote non occupano questi posti; `/sessions` continua a dare anche le diagnostiche dei file non validi.

Premi Ctrl-O dopo un tool: appare un pannello di dettaglio, richiudibile con Ctrl-O o Esc senza aggiungere copie allo storico. Il testo lungo dichiara il troncamento e indica il journal completo. Per provare il collasso, chiedi al modello tre chiamate consecutive a `chart_list`, senza testo fra esse: tre risultati riusciti e identici diventano una riga `×3, same result`. La verifica automatica controlla che siano state eseguite e registrate tutte e tre; il modello può scegliere diversamente durante una prova libera.

Esegui `!sleep 20`, attendi **Running shell command...**, poi Ctrl-C o Esc: deve comparire **Interrupted.** e tornare il prompt. Dopo diversi turni completi esegui `/compact` e interrompilo durante **Compacting conversation...**: il contesto precedente deve restare utilizzabile. Durante una chiamata tool non cancellabile, l'interruzione mostra **Stopping after the current call...** fino al risultato effettivo. Un altro input già accodato deve poi essere eseguito.

Ridimensiona più volte il terminale fra circa 110 e 44 colonne, con una risposta lunga già completata e un dettaglio visibili, poi ripeti `/resume`. Alterna anche piccoli restringimenti, allargamenti e nuovi restringimenti mentre una bozza è già digitata. Deve rimanere una sola barra del prompt, con due bordi, senza copie residue nello schermo o nello scrollback; la bozza deve restare modificabile. Prompt e stato devono rimanere utilizzabili e lo scrollback non deve accumulare nuove copie della risposta a ogni ridimensionamento. Il terminale gestisce il riflusso dello storico; solo il cambio conversazione ristampa lo storico selezionato. Controlla personalmente la leggibilità nel tuo emulatore. Le etichette CLI sono inglesi; input, risposte del modello e contenuto restituito dai tool mantengono la loro lingua.

## Prova personale della sicurezza chart_update

Dopo aver creato e salvato il grafico dei ricavi come sotto, annota l'ID da `chart_list`. Prova gli errori intenzionali:

```text
chart_update <id> --spec '{"mark":"area"}'
chart_update <id> --data '{"url":"missing.csv"}'
chart_list
render_page --page 0
```

Il chart originale deve rimanere presente e invariato. Per la prova con dati validi:

```text
chart_update <id> --data '{"url":"example/data/01-revenue-updated.csv"}'
save_document
```

Se modifichi una barra o il testo di un'etichetta tramite i comandi nativi, l'update deve rifiutare i **ritocchi rilevati**, mantenendo l'originale. Lo spostamento del gruppo intero è invece mantenuto. Dopo aver mostrato l’elenco dei ritocchi e ricevuto conferma esplicita, è disponibile `chart_update <id> --discard_hand_changes true`. Il successo deve elencare i ritocchi scartati. Conservazione dei ritocchi, reset e detach restano esclusi. Il rilevamento corrente controlla geometria, testo visibile, fill/stroke e aggiunte/rimozioni; non rappresenta ancora un contratto completo di conservazione di ogni proprietà di stile. Una perdita di connessione o un fallimento della pulizia richiede ispezione: non ripetere automaticamente l'update.

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

## Follow-up delle revisioni del 7 novembre

Le correzioni e le prove sono tracciate in [cli-foundations-review-followup.md](plans/cli-foundations-review-followup.md). Ripetere la suite con `node --test --test-concurrency=1 test/unit/*.test.ts` se l’esecuzione parallela mostra le race di avvio già osservate nei test UI/server.

Checklist aggiuntiva per una prova Anthropic live, con credenziali configurate dalla persona: generare alcuni turni con tool e thinking attivo, eseguire `/compact`, continuare con un tool, quindi cambiare modello e ripetere. La richiesta di riepilogo deve contenere solo testo, senza blocchi tool_use/tool_result o thinking storici; i gruppi recenti firmati devono rimanere intatti. Questa prova verifica l’API e la qualità del riepilogo e non è sostituita dai provider scriptati. Nessun esito live Anthropic è dichiarato da questi test automatici.
