# CLI foundations UX — consegna del 7 novembre 2026

Branch locale: `codex/cli-foundations-ux`, basato su `codex/cli-foundations`.
Issue raggruppate in Linear dall'etichetta **CLI foundations UX**: HOT-54, HOT-55, HOT-56, HOT-63 e HOT-108. Il feedback originale in `docs/cli-foundations-feedback.md` resta un file dell'utente non modificato e non incluso nei commit.

## Implementato

- Selezione iniziale: nuova conversazione di default e tre recenti non vuote. `/resume` cambia conversazione nel processo, dieci voci per pagina; `/resume <id>` e `--resume [id]` aprono direttamente. Titoli deterministici dal primo input significativo, senza LLM.
- Lettura asincrona dei journal con cessione al loop durante il parsing e contatore reale. Lock e validazione del candidato precedono la chiusura del writer corrente; un errore di ripresa mantiene la conversazione corrente. All'avvio, un errore mostra la diagnostica nell'header e crea una nuova conversazione se possibile.
- Ultimi dieci turni di input chiusi ripristinati come presentazione, senza eseguire tool o aprire documenti. Compatibilità con journal precedenti, anche dopo nuovi turni. La ricostruzione legacy è esplicita; non mostra thinking/payload nativi. I nuovi metadati UI referenziano risposte e risultati già registrati.
- Avvisi di ripresa e gap nell'header prima delle risposte; altri avvisi cronologici. Provider, modello e modalità correnti mantenuti, grant `always` azzerati. Memoria, tool e feed runtime riletti.
- Un solo echo per ogni input, comandi inclusi. Attività condivisa per modello, compattazione, shell, tool, skills e ripresa; spinner, etichetta e input accodati. Ctrl-C/Esc interrompono le attività cancellabili; i tool non cancellabili restano occupati fino all'esito effettivo.
- Output compatti anche per i tool diretti; Ctrl-O apre/chiude un dettaglio aggiornato durante la chiamata. Troncamenti dichiarati con percorso al journal. Risultati riusciti, identici e adiacenti collassati nello stesso turno, con durate aggregate e ID delle singole chiamate nel dettaglio. Esecuzione, journal e storia provider conservano tutte le chiamate.
- UI inglese; il contenuto dell'utente, del modello e dei tool mantiene la propria lingua.
- `chart_update` prepara spec/dati/plan senza effetti, disegna con label provvisorie, finalizza e cancella l'originale per ultimo. Errori intermedi puliscono il candidato; esiti incerti richiedono ispezione senza retry. Ritocchi interni rilevati bloccano l'update; lo spostamento del gruppo è conservato. Preview fallita dopo la sostituzione è un avviso.

## Commit

| Commit | Consegna |
| --- | --- |
| `e0974a6` | Protezione chart_update, test deterministici e contratto nelle skills |
| `33f6b34` | Verifica dei guasti parziali su oggetti DesignCraft reali |
| `e6fed0b` | Conversazioni, presentazione, attività, output e 15 nuovi test UX; sorgenti e dist insieme |

Le modifiche di sessione, attività e transcript sono nello stesso commit perché condividono eventi e metadati persistiti. README, roadmap e guida personale completano la consegna con un commit di documentazione separato.

## Verifiche eseguite

| Comando/prova | Esito |
| --- | --- |
| `npm run typecheck` / `npm run build` | Passati; dist generato incluso |
| `npm run test:unit` | 133 passati, zero failure/skipped |
| `npm run smoke` | 18 tool, 8 turni modello, 8 chiamate in coda |
| `npm test` | DesignCraft 0.13.0: 5 chart, salvataggio/riapertura e 2 aggiornamenti puliti |
| `npm run test:chart-safety:live` | Validazione senza effetti, errori dopo primo disegno e prima label, pulizia e originale identici; move, preview e ritocchi |
| `npm run test:foundations:live` | DesignCraft condiviso con client SDK MCP esterno; update, 5 render, save/restart/resume senza replay |
| `npm run test:package` | Tarball installato senza dipendenze dev; binario, skills/risorsa e facade MCP con DesignCraft reale |
| CLI compilata in PTY | 110 → 44 → 110 colonne, tool diretto, Ctrl-O/Esc, /sessions, Ctrl-C shell, /clear, /resume, uscita e rilascio lock |

Artefatti temporanei dell'ultima verifica (non fanno parte del repository):

- Chart: `/var/folders/y_/ph41165j66j4hzn0n77vbg040000gn/T/maquette-test-NZba4K`.
- Sicurezza nativa: `/private/var/folders/y_/ph41165j66j4hzn0n77vbg040000gn/T/maquette-chart-safety-live-WoEsmq`.
- Runtime/resume: `/private/var/folders/y_/ph41165j66j4hzn0n77vbg040000gn/T/maquette-foundations-live-2woIYF`.
- Pacchetto: `/var/folders/y_/ph41165j66j4hzn0n77vbg040000gn/T/maquette-package-hKaRUW`.
- PTY: `/var/folders/y_/ph41165j66j4hzn0n77vbg040000gn/T/maquette-pty-zo3b8o_q`; output e script di prova in `/tmp/maquette-pty-output.txt` e `/tmp/maquette-pty-check.py`.

## Limiti e prova personale

Nessuna valutazione della qualità di un provider live o di servizi MCP SaaS reali: le risposte del modello sono scriptate. La prova PTY verifica il processo e i tasti; resta utile il controllo visivo nel proprio emulatore Terminal. Non è stata introdotta una suite di confronti visuali pixel per pixel dei chart.

HOT-66 conserva la futura preservazione delle proprietà di stile; HOT-95 valori/reset/detach e HOT-91 aggiornamenti proposti/watch/pannello restano esclusi. Il guard attuale rileva geometria, testo visibile, fill/stroke e aggiunte/rimozioni, senza promettere la conservazione di ogni proprietà. Nessun nuovo vocabolario chart, contratto di stile, versione della grammatica o limite dati è aggiunto qui.

I controlli con server locali richiedono un ambiente che consenta loopback; quelli DesignCraft richiedono il binario macOS fissato dal progetto. Nessun push, PR, merge, rilascio o pubblicazione npm eseguito.

Istruzioni ripetibili: [guida personale](../cli-foundations-testing.md).

## Follow-up: copie nello scrollback durante il ridimensionamento

Il test iniziale in PTY verificava che la CLI rimanesse utilizzabile, ma non contava le copie del contenuto già stampato. La segnalazione dell'utente ha rivelato che ogni resize ricreava Ink Static e ristampava tutto il transcript, mentre una seconda callback cancellava il viewport. Cinque eventi di resize producevano sei copie della stessa risposta nello stream terminale.

Rimosse sia la ricreazione di Static sul resize sia la cancellazione manuale del viewport. Ink gestisce il frame attivo e il terminale il riflusso dello scrollback. Il cambio conversazione continua a mostrare una volta lo storico selezionato.

La regressione in `test/unit/terminal-output.test.ts` usa il writer interattivo reale di Ink, una risposta di 80 righe e variazioni di larghezza/altezza; dopo cinque resize il contenuto deve rimanere stampato una sola volta, senza cancellare lo storico. `ink-testing-library` usa debug mode e ristampa intenzionalmente il frame completo: il suo ultimo frame non è una verifica delle scritture nello scrollback.

Passati typecheck/build, tutti i 134 unit test e smoke. Anche la build compilata in PTY mantiene una sola copia di 80 righe attraverso cinque resize; input, dettaglio, interruzione shell e ripresa restano funzionanti. La ripresa visualizza lo storico selezionato una sola volta aggiuntiva. Artefatti: `/var/folders/y_/ph41165j66j4hzn0n77vbg040000gn/T/maquette-pty-d7xgkcqu`; script e stream in `/tmp/maquette-resize-check.py` e `/tmp/maquette-resize-output.txt`.

## Follow-up: bordi e prompt residui dopo il riflusso

La seconda segnalazione ha mostrato il limite del test precedente: contare le scritture della risposta non rileva un prompt rimasto sullo schermo dopo che il terminale ha ripiegato le righe. Il nuovo test usa `@xterm/headless` 5.5.0 (MIT, solo sviluppo) per applicare davvero sequenze ANSI e ridimensionamenti, poi conta prompt e bordi nell'intero buffer. Senza correzione riproduceva due prompt dopo i piccoli restringimenti successivi.

Ink 8.0.0 cancella il frame usando il precedente numero di righe logiche; una riga di bordo può invece occupare più righe fisiche dopo il restringimento. È la classe di problema descritta nell'[issue upstream sul riflusso](https://github.com/vadimdemedes/ink/issues/907). Il suo `clear()` pubblico usa lo stesso conteggio e non permette di sincronizzarlo. L'adattatore isolato in `src/ui/resize.ts` usa il renderer interno della versione esatta 8.0.0, controlla versione e struttura all'avvio, sincronizza il frame usando `wrap-ansi` 10.0.2 (la stessa versione già usata da Ink), cancella solo l'area attiva e ancora il nuovo frame in fondo alla finestra. Non cambia i file di node_modules e non richiede script postinstall. **Un aggiornamento di Ink richiede revisione dell'adattatore e ripetizione di queste prove.**

L'ancoraggio è necessario anche dopo un allargamento: il riflusso può portare il cursore vicino alla cima, e il restringimento successivo spingere una parte del vecchio prompt nello scrollback, dove la normale cancellazione non può più raggiungerlo. Il test comprende allargamenti/restringimenti alternati e una bozza con caratteri a larghezza doppia. Verifica un prompt, due bordi, nessuna bozza residua dopo Ctrl-U e conservazione della risposta precedente. Il test iniziale continua a verificare che non vengano ristampate copie dello storico.

Passati typecheck/build, 135 unit test e smoke. Il pacchetto senza dipendenze dev prova ora esplicitamente l'adattatore contro la propria installazione Ink prima della facade DesignCraft reale: `/var/folders/y_/ph41165j66j4hzn0n77vbg040000gn/T/maquette-package-wsu5HV`. La CLI compilata in PTY verifica ancora input, dettaglio, cancellazione, resize e resume: `/var/folders/y_/ph41165j66j4hzn0n77vbg040000gn/T/maquette-pty-pvy4q6b9`. La verifica visiva diretta in Terminal.app resta da ripetere dall'utente; non è stata dichiarata come eseguita automaticamente.
