# Feedback prova CLI foundations — 2026-11-07

Raccolto durante l'esecuzione di `docs/cli-foundations-testing.md`. Riguarda UX della CLI, non la correttezza funzionale (che è stata verificata).

## Resume delle conversazioni

**Problema**: `--resume` è solo un flag CLI; `/sessions` elenca le conversazioni ma non le riapre. Per cambiare sessione bisogna uscire dal processo e rilanciarlo con `--resume <id>`. Poco scopribile.

**Proposte**:
- All'apertura di una nuova sessione, elencare le **3 conversazioni più recenti** di quella cartella, con la possibilità di sceglierne una (default: nuova conversazione).
- Nuovo slash command `/resume` che apre un menù con le **ultime 10** conversazioni; la voce in posizione 11 è "next page" e mostra 11–20, e così via.
- Ogni conversazione nella lista deve avere un **titolo breve** generato automaticamente dal primo messaggio utente (topic). Il solo ID + timestamp attuale non è navigabile.

## Ordine delle informazioni al resume

**Problema**: gli avvisi di sistema («Resumed 731d48fa… Conversation restored; permissions and document state are not restored…» e «Runtime restarted or change events were lost…») appaiono **dopo** la risposta del modello al primo turno. Il lettore vede la risposta senza sapere in che contesto è stata prodotta.

**Proposta**: mostrare questi avvisi nell'header, subito dopo il banner e la riga del modello/permessi, **prima** del primo turno.

## Dissonanza linguistica

Banner, header, labels in italiano; avvisi di sistema («Resumed…», «Runtime restarted or change events were lost…», «esc dismisses») in inglese. Uniformare alla lingua selezionata (o di sistema).

## Visibilità dell'input utente

**Problema**: quando si digita direttamente un nome di tool (`chart_list`, `inspect_document`) o uno slash command (`/sessions`, `/skills`), la riga di input **non viene rieccheggiata** con il prefisso `❯`. Il `❯` compare solo per messaggi in linguaggio naturale. Scorrendo indietro, le chiamate dirette e gli slash command sembrano "comparire dal nulla" — è difficile ricostruire cosa ha chiesto l'utente vs cosa ha prodotto il modello.

**Proposta**: ogni input dell'utente deve lasciare una traccia con `❯` (o un altro prefisso dedicato per slash/tool), coerente con il comportamento dei messaggi in linguaggio naturale.

## Output ripetuto dei tool

**Problema**: durante la creazione del chart il modello ha invocato `chart_list` più volte nello stesso turno (verifica post-create, verifica post-save, richiesta utente). Ogni invocazione stampa il JSON grezzo intero — nel transcript sono apparsi tre blocchi identici consecutivi, difficili da distinguere senza leggerli per intero.

**Proposta**: deduplicare o collassare output tool identici consecutivi nello stesso turno (es. "`chart_list` ×3, stesso risultato"), oppure mostrare un diff rispetto all'ultima chiamata dello stesso tool.

## Nessun feedback durante azioni in corso

**Problema**: quando viene eseguita un'azione che richiede tempo (es. `/compact`, un tool call lungo, il caricamento di una skill), non c'è alcun indicatore visibile che qualcosa stia succedendo. L'UI resta ferma senza spinner, senza riga di stato, senza etichetta dell'azione in corso. L'utente non sa se il processo è vivo, bloccato, o se l'input non è stato ricevuto.

**Proposta**: separare visivamente l'azione richiesta dalla sua esecuzione con una riga vuota e stampare un indicatore di progresso. Ad esempio:

```text
❯ /compact

⠋ Compacting conversation…
```

Con etichetta dell'azione (`Compacting`, `Loading skill brand-check`, `Calling chart_create`), spinner animato, e — quando possibile — un contatore o una percentuale. La riga vuota prima dell'indicatore serve a distinguere input e stato di esecuzione dallo scroll precedente.

---

# Architettura del tool `chart` — valutazione da senior data-viz engineer

Analisi del codice in `src/tools/chart/` (`chart.ts`, `draw.ts`, `index.ts`, `spec.ts`). Pipeline: spec Vega-Lite (sottoinsieme) → pianificazione con d3 (`d3-scale`, `d3-format`, `d3-time-format`, `d3-time`) → disegno come oggetti nativi DesignCraft (`frame.create`, `style.paragraph.apply`, `style.object.apply`, ecc.) raggruppati sotto label `firstlight:chart:<id>` → check post-render (marks off-position, overset, outside frame, label collisions).

## Cosa fanno di oggettivamente giusto

**1. Native page items invece di immagine/SVG embedded.** Decisione più importante e corretta. Per un tool di stampa, un chart come oggetti DesignCraft nativi guadagna:
- vettoriale perfetto per PDF/offset, zero scelte di risoluzione
- partecipa agli stili del documento (cambi lo swatch `Chart/Bar` → tutti i bar aggiornati)
- gestione colore, spot, overprint, bleed "gratis"
- composizione paragrafo con il font-stack reale del documento
- il designer può ritoccare con gli strumenti normali

Un chart Vega renderizzato in SVG non ha nessuna di queste proprietà. Per la stampa è la via corretta.

**2. Vega-Lite come grammatica di input.** Riusare una grammatica esistente invece di inventarla è giusto: gli LLM già la conoscono dal training, le spec sono portabili, qualsiasi editor Vega-Lite online fa da sanity check.

**3. d3-scale/d3-format per la matematica.** Sono le stesse librerie su cui Vega è costruito: scale, tick, "nice numbers" e formati numerici coincidono con quello che chiunque si aspetta. Niente bug di "nice numbers fatto in casa".

**4. Check post-render nel risultato del tool.** `{marks misplaced, overset, outside frame, label collisions}` restituito al modello è una scelta sottovalutata ma eccellente: in stampa non puoi spedire un chart con testo in overset o etichette fuori frame, e l'agente può auto-correggersi senza che l'umano intervenga. Lo costruisci solo se ti è già successo in produzione.

**5. Hand-change preservation via group label.** `firstlight:chart:<id>` + `handChanges` affronta il problema vero del "dati live + intento del designer", invece di bulldozzare le modifiche manuali a ogni update.

## Dove la pratica non scala

**1. Il "sottoinsieme di Vega-Lite" è la trappola classica.** Ogni team che parte così finisce in uno di due modi:
- congela il sottoinsieme e gli utenti sbattono sul soffitto (facet/small multiples, layer, repeat, concat, stacked-grouped, dual-axis, log/sqrt, bande di errore, regression, density, radial, geo…)
- continua ad aggiungere feature finché re-implementa male Vega-Lite intero

Oggi `MAX_SERIES = 2` hard-coded e nessun supporto a layer/facet/stack/dual-axis. Bene per un *editorial chart tool*. Non regge se il roadmap assume "charts per analisti".

**2. Due semantiche "Vega-Lite" divergeranno.** Prima o poi un utente aprirà la stessa spec nel Vega editor e dirà "qui è diverso". Sort, `nice()`, `axis.format`, wrapping dei titoli, legend layout — tutti punti di deriva. Servono o un **conformance test suite** contro il reference Vega, o un **rebranding onesto** ("grammatica *ispirata* a Vega-Lite per la stampa") che toglie l'aspettativa. La seconda è più sana.

**3. Scalabilità per complessità, non per numero.** Il costo di un chart cresce con la complessità, non con il numero. Layout corretto (etichette non sovrapposte, legende che wrappano, assi ruotati, small multiples) è letteratura di ricerca. Oggi: costanti di gap + collision check reattivo. Funziona per bar/line/point semplici, non per i casi che la gente poi vuole davvero.

**4. Volume dati.** `loadRows` carica il CSV in memoria, i check fanno inspect round-trip. Va bene per decine o qualche centinaio di punti (ambito stampa). Oltre, serve **limite esplicito con errore chiaro** invece di degrado silenzioso.

**5. Il ciclo update è "clear + redraw".** Per report con tanti chart agganciati a dati live, ogni refresh è N round-trip a DesignCraft. Scalabile solo batchando l'intero refresh (non il singolo chart) o, se diventa un bottleneck, diffando plan vecchio/nuovo. Prematuro ora, da tenere a mente.

**6. Semantica del "merge intelligente" sulle modifiche a mano.** Quali edit sopravvivono a un cambio dati? Testo label → sì. Posizione label → probabilmente sì. Colori override → sì. Annotazioni aggiunte → sì. Altezze bar → ovviamente no. Questa semantica **va documentata con esempi espliciti** o i designer perderanno lavoro e daranno la colpa al tool. È il problema più sottile e il più insidioso.

**7. "Style contract" implicito col template.** La forza (stili del documento guidano l'aspetto) è anche vincolo: se il template non prevede palette divergente o scala continua di colori, il chart non la materializza. Serve un **contratto di stile dichiarato** — "per usare questo tool il template deve avere questi paragraph style e questi object style" — validato all'apertura del documento.

## Cosa mancherà presto

- **Visual regression tests**: `test:foundations:live` verifica che il tool giri, non che il risultato *sembri giusto*. Un viz tool senza render-diff su spec di riferimento è un cantiere.
- **Versioning esplicito della grammatica**: `spec_version: 1` dentro la spec, errore chiaro quando la versione cambia.
- **Limiti espliciti che falliscono rumorosamente**: numero di serie, numero di punti, lunghezza label.

## Verdetto

Per l'ambito dichiarato — **AI-assisted editorial print reports con un vocabolario ristretto di chart** — l'architettura è *pensata bene*. Il trio *native items + post-render check + hand-change preservation* è dove sta l'ingegneria vera, e punta nella direzione giusta.

**Non scala a essere un general-purpose data-viz layer.** Se il prodotto va in quella direzione, entro ~6 mesi sbatte sul soffitto Vega-Lite-subset e deve scegliere: (a) implementare una vera compilazione Vega-Lite → DesignCraft, enorme; (b) restare esplicitamente "chart per stampa editoriale" e dirottare le dashboard da analisti altrove. Il fallimento sarebbe fingere di essere entrambi.

La differenza tra un buon tool e uno mediocre non sarà `d3-scale` — sarà quanto chiaramente dicono *"questo sì, questo no"*.
