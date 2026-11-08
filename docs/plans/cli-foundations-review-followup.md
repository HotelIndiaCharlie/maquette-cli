# CLI foundations UX — follow-up delle revisioni

7 novembre 2026, branch locale `codex/cli-foundations-ux`.

Letti tutti i commenti delle cinque issue con etichetta **CLI foundations UX**, incluse le cinque revisioni senior del 7 novembre. Questa consegna applica sia i bloccanti sia i miglioramenti consigliati, comprese le note minori. Le modifiche locali preesistenti al resize, ai suoi test e alla dipendenza `string-width` sono state conservate.

Nessun messaggio, cambio di stato, push, PR, merge o rilascio su Linear/GitHub è incluso in questa operazione.

## HOT-54 — MCP e runtime condiviso

[Revisione e discussione](https://linear.app/hotelindiajuliet/issue/HOT-54/mcp-connections-external-app-tools-and-a-shared-maquette-stdio-bridge).

| Punto | Implementazione |
| --- | --- |
| 1 | Lock per root canonica; pid/porta nel lock; discovery consulta il proprietario e rifiuta una seconda porta prima di lanciare un engine. |
| 2 | `.reap` registra pid/token. Un reaper morto viene superato con un successore deterministico esclusivo, senza cancellare un guard che un altro starter potrebbe avere appena acquisito; un file incompleto recente ha dieci secondi per inizializzarsi. |
| 3 | Stdio eredita `getDefaultEnvironment()` e `env` esplicito. `inheritEnv: true` abilita l'eredità completa per il singolo server. |
| 4 | EOF/close di stdin chiudono bridge, runtime posseduto ed engine; il cleanup rimuove i listener e resta idempotente. |
| 5 | Protocollo runtime v2: `POST /session` assegna credenziali opache; `/call` ignora `caller` e `source` nel body. Il feed espone etichette pubbliche e `own`, calcolato sul token autenticato. Ogni conversazione collegata ha identità distinta; registrazioni concorrenti condividono la stessa promessa. |
| 6 | Deadline server per le chiamate in coda: una richiesta scaduta non viene eseguita. Il timeout del client comprende il massimo di coda più esecuzione. Nessun retry automatico. |
| 7 | Errori JSON-RPC espliciti mostrati come contenuto esterno; chiusura connessione e timeout SDK restano incerti, anche se rappresentati da `McpError`. Progress resetta il timeout inattivo entro dieci minuti totali. |
| 8 | Buffer stderr in memoria, massimo 200 righe/64 KiB per server, consultabile con `/mcp logs <name>`. Output effimero escluso da journal, cronologia del provider e trace. |
| 9 | Hash del contenuto degli eseguibili relativi alla root incluso nella fiducia. Il prompt esplicita che PATH/comandi assoluti autorizzano il percorso, non i contenuti. |
| 10 | Polling del bridge su `/revision`, senza rileggere il catalogo completo o MAQUETTE.md ogni secondo. |
| 11 | Errori `OwnershipError` e `PortInUseError`; nessuna regex sul testo per decidere se collegarsi. |
| 12 | `byName` memorizzata e ricostruita solo al refresh. |
| 13 | `config set/unset mcpServers.<nome>` conserva gli altri server. Provenienza registrata per mappa e singola voce; output sempre redatto. |
| 14 | Un nuovo built-in espelle l'intera connessione esterna in collisione, con stato `failed` e diagnostica, prima di pubblicare il catalogo. |

Anche il commento precedente sulla ricerca web è rispettato: ricetta MCP nel README, risultati esterni non fidati e prima lettura esterna soggetta a permesso in ask mode anche con `trustedReadOnly`.

## HOT-55 — skill

[Revisione e discussione](https://linear.app/hotelindiajuliet/issue/HOT-55/skills-shared-catalogue-on-demand-loading-and-init-integration).

| Punto | Implementazione |
| --- | --- |
| 1 | Nome inesistente: exit 1 con una sola riga, senza stack trace. |
| 2 | Description/body/reference di chart descrivono il guard e lo scarto confermato; nessuna promessa di preservazione non implementata. |
| 3 | Cache delle entry per path/mtime/ctime/size e delle directory per metadati; `readSkill` accetta un catalogo già risolto. Il contenimento viene rivalidato prima della lettura. |
| 4 | La skill chart nomina la risorsa `references/working-with-charts.md`; test per tutte le risorse bundled. |
| 5 | Slash sconosciuto: elenco comprensivo delle skill e suggerimento del nome vicino. |
| 6 | Refresh prima del caricamento slash; notice con nomi added/removed/changed. |
| 7 | Description nel prompt limitate a 200 caratteri, JSON esplicitamente non fidato; notice per le nuove skill di progetto. |
| 8 | Risorsa assente: diagnostica relativa alla skill, senza errore ENOENT con la home completa. |
| 9 | Titoli senza elenco hardcoded dei quattro nomi bundled; metadati strutturati per le nuove invocazioni e fallback legacy. |
| 10 | Un solo stat per ogni accesso a un'entry. |

Coperti anche il symlink del file SKILL.md e il fallback dopo una skill a precedenza maggiore invalida.

## HOT-63 — mappa cartella e /init

[Revisione e discussione](https://linear.app/hotelindiajuliet/issue/HOT-63/folder-aware-init-bounded-tree-survey-map-and-supporting-files).

| Punto | Implementazione |
| --- | --- |
| 1 | Visita breadth-first. Cartelle con oltre 20 voci: massimo 200 entry immediate campionate, nessuna ricorsione interna; brief e guide sorelle rimangono raggiungibili. |
| 2 | Contenimento lessicale prima di stat; assenza del path riportata come `No such folder` relativo. I symlink di directory restano non attraversabili. |
| 3 | Errori della mappa diventano `folder.error`; il survey del documento continua. |
| 4 | Tool tree: righe di testo semplice seguite dal riepilogo JSON; survey mantiene la struttura. Uguaglianza verificata sul contenuto formattato. |
| 5 | Contatore di byte incrementale per le righe; riepilogo limitato prima dell'emissione. |
| 6 | Readdir con Dirent e stat dei file in gruppi di 16; budget complessivi mantenuti. |
| 7 | Sia survey con documento sia senza documento includono `folder` e `documents` nel blocco JSON. |
| 8 | La skill init dichiara che in plan mode il PDF resta non letto e va chiesta la guida mancante, senza provare bash/pdftotext. |

## HOT-56 — sessioni, contesto e UI

[Revisione e discussione](https://linear.app/hotelindiajuliet/issue/HOT-56/sessions-and-context-durable-resume-safe-compaction-and-change-notices).

| Punto | Implementazione |
| --- | --- |
| 1 | Immagini fuori dal JSONL: snapshot indirizzati dal contenuto, hash SHA-256 verificato al restore, fallback testuale se assenti/modificati. Il risultato raw MCP e la copia normalized duplicata non entrano nei nuovi record call_result. |
| 2 | Guard limitato ai cambiamenti DesignCraft, tramite helper di scope condiviso con il runtime. `open_document` ammesso; failure dedicata `policy.inspect_required`. |
| 3 | Un solo `clearsInspection` per prompt e modello; documentato il bypass dei comandi diretti richiesti dalla persona. |
| 4 | Riepilogo richiesto con una rappresentazione solo testuale, senza tool_use/tool_result o thinking nativi storici. Checklist Anthropic live aggiunta. |
| 5 | Provider registrato solo se cambia; data ricavata dall'ultimo messaggio. |
| 6 | Marker `.recovered`, riutilizzo della copia, originali esclusi da latest/menu e marcati in `/sessions`; catene cicliche rifiutate. |
| 7 | Le due entry di compatibilità condividono selezione, filtri, validazione dei record e risoluzione del recupero. La UI usa `SessionJournal.open` asincrono con stato preparato; il costruttore sincrono resta per gli utilizzatori interni esistenti. Eliminata la divergenza empty/locked/recovered che motivava il rilievo. |
| 8 | Latest salta i writer occupati; se restano solo quelli spiega terminale/pid e suggerisce `/resume`. |
| 9 | Indice `Map<callId, {start, result}>` aggiornato all'append e al restore, senza scansioni per ogni evento UI. |
| 10 | Solo errori di rete/abort sono diagnosticati come connessione persa. Errori locali diventano errori del tool con risultati appaiati. |
| 11 | Registrazione idempotente dell'interruzione, una sola per input anche con Ctrl-C ripetuti. |
| 12 | Troncamento UTF-8 senza lasciare il carattere multibyte spezzato. |
| 13 | Notice accodata al messaggio user esistente con un record append durevole, anziché creare due messaggi user consecutivi. |
| 14 | `compactBoundary(..., 0)` protetto. |
| 15 | Origini direct/shell/skill/notice e comando visibile strutturati nei nuovi messaggi; regex solo per journal legacy. |
| 16 | Adattatore resize opzionale: diagnostica e prosecuzione della UI se Ink/versione/renderer non corrispondono. Conservate le correzioni locali del frame e le prove sui terminali alti. |
| 17 | Stima incrementale del contesto con costo fisso per immagine, senza serializzare la cronologia completa a ogni step. |

Gli snapshot delle immagini sono immutabili e riutilizzabili, anziché dipendere da un file di render che potrebbe venire sovrascritto. I vecchi journal rimangono leggibili e non vengono riscritti retroattivamente.

## HOT-108 — sicurezza chart

[Revisione e discussione](https://linear.app/hotelindiajuliet/issue/HOT-108/protect-chart-update-validate-first-stage-replacement-and-keep-the).

| Punto | Implementazione |
| --- | --- |
| 1 | Render restituisce immagini o avviso; create registra il chart prima del render. Preview pulita in finally. |
| 2 | `discard_hand_changes: true` solo come booleano esplicito; schema/skill richiedono elenco e conferma della persona. Resta un normale cambiamento soggetto ai permessi. Successo elenca i ritocchi scartati. |
| 3 | Se la pulizia dopo la finalizzazione fallisce, diagnostica di item e label definitive potenzialmente duplicate; stato incerto mantenuto, senza retry. |
| 4 | Registro e chart_list mostrano l'esito incerto anche se mancano entrambi i gruppi; un update successivo lo segnala. |
| 5 | Failure injection semantica sulla prima label definitiva, dopo aver applicato l'effetto; indipendente dal numero di batch. |
| 6 | Catalogo skill coerente con il guard. |

Note minori incluse: clone dello spec precedente e delle nuove proprietà prima del merge; schema dichiara che `encoding` parziale sostituisce l'intero oggetto; messaggio sui ritocchi reso condizionale.

## Verifica

- `npm run typecheck` e `npm run build`: passati; `dist/` aggiornato, inclusi i due nuovi moduli di ownership/scope.
- `node --test --test-concurrency=1 test/unit/*.test.ts`: **163/163 passati**, zero skip/failure. Le nuove prove includono venti immagini con journal sotto 1 MB, recupero dell'immagine prima del commit di un gruppo risultati, reaper orfani, identità non falsificabili, EOF con arresto del pid engine, collisioni di catalogo e fallback resize.
- `npm run smoke`: passato, 18 tool, 8 turni modello e 8 chiamate.
- `npm test`: cinque chart creati, documento riaperto e due aggiornamenti con DesignCraft reale. Artefatti: `/var/folders/y_/ph41165j66j4hzn0n77vbg040000gn/T/maquette-test-vrGOpJ`.
- `npm run test:foundations:live`: passato con runtime condiviso terminale/MCP, cinque render, save/restart/resume e nessun replay. Artefatti: `/private/var/folders/y_/ph41165j66j4hzn0n77vbg040000gn/T/maquette-foundations-live-ysfuna`.
- `npm run test:chart-safety:live`: passato con guasti nativi parziali, confronto dell'originale, spostamento, render fallito e guard dei ritocchi. Artefatti: `/private/var/folders/y_/ph41165j66j4hzn0n77vbg040000gn/T/maquette-chart-safety-live-TnMx5d`.
- `npm run test:package`: passato, tarball installato senza dipendenze dev, CLI/skill/risorsa/tree/adattatore Ink e facade DesignCraft reali. Artefatti: `/var/folders/y_/ph41165j66j4hzn0n77vbg040000gn/T/maquette-package-D99QQ9`.
- `git diff --check`: passato.

I test che aprono server HTTP/MCP locali sono stati eseguiti fuori dal sandbox dopo che il sandbox aveva rifiutato il bind loopback con EPERM. Non sono state usate credenziali SaaS o provider live.

Limiti: provider scriptati nelle prove automatiche; checklist Anthropic live predisposta, senza dichiarare una prova con credenziali reali. Il test terminale usa xterm headless; la lettura personale in Terminal.app resta una prova distinta. Conservazione arbitraria dei ritocchi, reset/detach e watch restano nelle issue dedicate.
