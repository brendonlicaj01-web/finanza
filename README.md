# Finanza

App web per gestire le proprie posizioni finanziarie: conti, strumenti, transazioni, rendimenti e allocazione.
I dati restano **solo nel browser** (localStorage): nessun server, nessun account.

## Funzionalità

- **Panoramica**: patrimonio totale, guadagno complessivo, P&L latente e realizzato, dividendi e interessi,
  imposte stimate sulle plusvalenze latenti, grafico dell'andamento nel tempo, allocazione per tipo e per conto.
- **Posizioni**: quantità, prezzo medio di carico (costo medio ponderato, commissioni incluse), valore di mercato,
  peso in portafoglio, P&L latente/realizzato e proventi, aggregati per strumento o per singolo conto.
- **Transazioni**: acquisti, vendite, dividendi/cedole, interessi, depositi, prelievi, commissioni/imposte, con
  filtri e controllo che non si venda più di quanto posseduto.
- **Strumenti**: azioni, ETF, obbligazioni, fondi, crypto, materie prime; aggiornamento rapido dei prezzi e aliquota
  fiscale per strumento (26% o 12,5% per titoli di Stato).
- **Conti**: broker, banche e wallet con saldo investito e liquidità.
- **Report annuale**: plus/minusvalenze realizzate, proventi, costi, versamenti e prelievi per anno.
- **Collegamenti**: sincronizzazione automatica di operazioni, dividendi, depositi, saldi e prezzi da
  **Interactive Brokers** (Flex Web Service), **eToro** (API pubblica), **Scalable Capital** (CLI ufficiale),
  **Binance**, **Kraken**, **Coinbase**,
  **Bitpanda** (chiavi API di sola lettura) e dei **conti bancari** via open banking (Enable Banking).
  Parte da sola all'apertura dell'app.
- **Impostazioni**: valuta di riferimento, tema chiaro/scuro, tracciamento della liquidità, backup/ripristino JSON,
  esportazione CSV delle transazioni (compatibile con Excel italiano), dati di esempio.

## Avvio rapido (doppio clic)

1. Installa [Node.js](https://nodejs.org) (versione LTS), una volta sola.
2. Fai doppio clic sul file di avvio:
   - **Windows**: `Avvia Finanza.bat`
   - **macOS**: `Avvia Finanza.command` (la prima volta: clic destro → Apri, per autorizzarlo)
   - **Linux**: `./avvia.sh`
3. Si apre il browser su http://localhost:3210. Lascia aperta la finestra del terminale mentre usi l'app.

Lo script installa le dipendenze da solo al primo avvio (e dopo ogni aggiornamento) e, se l'app è già in
esecuzione, apre semplicemente il browser.

## Collegamenti automatici

Apri la pagina **Collegamenti**, scegli la fonte e segui la guida passo-passo nella finestra. Serve l'app avviata
sul tuo computer (file "Avvia Finanza" o `npm start`): un piccolo server locale custodisce le chiavi e parla con
broker ed exchange.

- **Sicurezza**: le chiavi sono salvate solo in `~/.finanza/connections.json` (permessi 600, fuori dal progetto) e
  non vengono mai rimandate al browser. Usa **sempre chiavi di sola lettura**. Il server ascolta solo su `localhost`
  e rifiuta le richieste provenienti da altri siti.
- **Nessun duplicato**: ogni operazione importata ha un identificativo della fonte; le sincronizzazioni successive
  aggiungono solo le novità e non toccano le transazioni modificate a mano.
- **Saldi allineati**: alla prima sincronizzazione, ciò che possedevi prima del periodo scaricato viene registrato
  come "Saldo iniziale" (con il prezzo di carico del broker, se disponibile); in seguito eventuali differenze con i
  saldi reali diventano un "Allineamento al saldo".
- **Crypto**: gli scambi crypto/crypto (es. ETH/USDT) diventano acquisto + vendita della contropartita, valorizzati
  in euro al cambio del giorno. Su Binance lo storico si legge coppia per coppia: vengono lette le monete possedute
  più quelle indicate nel campo facoltativo.

- **eToro**: posizioni reali (acquisti senza leva, anche delle copie CopyTrader), operazioni chiuse, liquidità e
  prezzi. Gli importi eToro sono in dollari e vengono convertiti in euro al cambio del giorno; le posizioni con leva
  o short (CFD) sono escluse.

### Scalable Capital (CLI ufficiale)

1. Sul sito Scalable (web): Profilo → Sicurezza → **Agentic Investing** → attiva **Scalable CLI**.
2. Installa il CLI ufficiale da [github.com/ScalableCapital/scalable-cli](https://github.com/ScalableCapital/scalable-cli)
   (Releases, o `brew install scalable-cli` su Mac).
3. Nel terminale: `sc login --local-read-only` e completa tu l'accesso.
4. In Finanza → Collegamenti → Scalable Capital → Collega. L'app esegue solo comandi di lettura (`holdings`,
   `transactions`, `transaction details`, `cash-breakdown`, `search`) da un elenco fisso nel codice, senza shell:
   non può inviare ordini.

Il riepilogo delle transazioni di Scalable non contiene nome del titolo, prezzo, commissioni e imposte: l'app legge il
**dettaglio** di ogni operazione (prezzo di esecuzione, commissioni di transazione/sede/spread crypto, imposte, lordo e
ritenuta dei dividendi) e lo conserva in `~/.finanza/cache`, così dalla seconda sincronizzazione chiede al CLI solo i
dettagli delle operazioni nuove. A ogni sincronizzazione rilegge comunque tutto lo storico (è veloce): le operazioni
importate in passato senza dettaglio vengono **corrette** (prezzo, commissioni, imposte), senza doppioni, e i saldi
iniziali/allineamenti automatici vengono ricalcolati. Le transazioni che hai modificato a mano non vengono toccate.
Gli strumenti importati prima con l'ISIN come nome ricevono nome e tipo corretti.

### Conti bancari (Enable Banking)

1. Registrati gratis su [enablebanking.com](https://enablebanking.com) → Control Panel → nuova applicazione
   in ambiente **Production**, con redirect URL `http://localhost:3210/api/oauth/callback` (se l'app gira su un'altra
   porta, usa quella). Genera la chiave nel browser: viene scaricato un file `.pem`.
2. Premi **"Activate by linking accounts"** e collega i tuoi conti: in questa modalità gratuita l'app legge solo i
   conti collegati da te.
3. In Finanza → Collegamenti → Conti bancari: incolla ID applicazione e contenuto del `.pem`, scegli se importare
   solo il saldo (consigliato) o anche i singoli movimenti, poi **Autorizza banca**: si apre il sito della banca e,
   al termine, la sincronizzazione parte da sola. Se la pagina finale non torna all'app, puoi incollarne l'indirizzo.
4. Il consenso dura fino a 180 giorni: l'app avvisa quando sta per scadere e propone **Rinnova consenso**.

Per provare il flusso senza account reali: `FINANZA_MOCK=1 npm run dev` aggiunge un "Broker di prova" e una
"Banca di prova" con autorizzazione simulata.

## Import da file

In **Collegamenti → Importa da file** (o dal pulsante in Transazioni) trascina l'export del tuo broker: il file
viene letto solo nel browser, l'app riconosce il formato e mostra un'anteprima (nuove transazioni, già presenti,
nuovi strumenti) prima di importare. Reimportare lo stesso file, o un export più recente che lo include, aggiunge
solo le novità.

| Broker | File da esportare |
|---|---|
| **Fineco** (consigliato) | Account → Movimenti del conto: filtro dall'apertura del conto a oggi → Esporta Excel. Contiene liquidità, imposte, compravendite, rimborsi e proventi. |
| Fineco (alternativa) | Account → Report → Ordini e contabili → Titoli → Ricerca avanzata → Esporta in Excel ("Movimenti Dossier Titoli", con ISIN e commissioni ma senza liquidità). |
| **OKX** | Cronologia del conto **Trading** e del conto **Funding** (due CSV): trascinali insieme. Le compravendite spot sono aggregate per ordine; i trasferimenti interni (Trading ↔ Funding, staking, Simple Earn) non vengono contati; le crypto depositate da wallet esterni entrano al valore in euro del giorno; i rendimenti (yield, staking, premi) sono proventi e la moneta ricevuta entra a quel valore; OKSOL è contato come SOL. |
| **Trade Republic** | App o sito → Profilo → Transazioni → Esporta (CSV). Acquisti e piani di accumulo, dividendi, interessi, Saveback e bonus (proventi), imposte, commissioni, bonifici e trasferimenti di crypto. **Privacy**: i pagamenti con carta sono esclusi (o, a scelta nell'anteprima, ridotti a un totale mensile anonimo) e dei bonifici non vengono letti nomi, IBAN o causali. |
| **DEGIRO** | Attività → Estratto conto: dall'apertura del conto a oggi → Esporta (CSV o Excel), in italiano o inglese. Le righe di uno stesso ordine (esecuzione, commissioni, Tobin tax, cambio valuta) vengono unite; i "Cash Sweep" verso flatex sono interni e ignorati; ogni prelievo è contato una volta sola; la liquidità è allineata al saldo finale. |
| **Qualsiasi altro broker** (es. Directa) | Un CSV/Excel con almeno le colonne *Data*, *Tipo operazione* e *Importo* (o *Quantità* e *Prezzo*). Riconosciute anche *Descrizione*, *ISIN* (anche tra parentesi nella descrizione), *Commissioni*, *ID operazione* e *Saldo*: se c'è il saldo progressivo, la liquidità viene allineata. Tipi riconosciuti: acquisto/compra/buy, vendita/vendi/sell, dividendo/cedola, ritenuta, interessi, commissioni/imposte/bollo, bonifico/versamento/prelievo. |

Obbligazioni e titoli di Stato usano quantità nominale e prezzo in percentuale (come nel portafoglio Fineco).
I file non contengono i prezzi correnti: aggiornali nella pagina Strumenti.

I CSV vengono letti come testo: le date italiane (gg/mm/aaaa) restano tali, i numeri possono usare la virgola o il
punto decimale e i file salvati da Excel con codifica Windows sono supportati. Nell'anteprima puoi scegliere il conto
di destinazione o crearne uno nuovo (per il CSV generico il nome parte dal nome del file).

Scalable Capital si collega in automatico tramite il suo CLI ufficiale (vedi sopra).

## Avvio da terminale

Richiede Node.js 20.19 o successivo.

```bash
npm install
npm run dev        # sviluppo su http://localhost:3210 (si apre da solo nel browser)
npm run build      # build di produzione in dist/
npm run preview    # anteprima della build su http://localhost:3211
npm test           # test dei calcoli
npm run typecheck
```

La cartella `dist/` è statica: si può pubblicare su qualsiasi hosting (GitHub Pages, Netlify, ecc.).

## Struttura

```
src/
  lib/portfolio.ts   calcolo di posizioni, liquidità, riepiloghi e report (funzioni pure, testate)
  lib/types.ts       modello dati
  lib/storage.ts     salvataggio locale e validazione dei backup
  lib/csv.ts         esportazione CSV
  lib/importers/     lettura dei file dei broker (SheetJS) e formati riconosciuti
  lib/sync.ts        unione dei dati sincronizzati (conti, strumenti, transazioni, allineamento saldi)
  store.tsx          stato dell'app (React context + reducer), fotografia giornaliera del patrimonio
  sync.tsx           collegamenti e sincronizzazione automatica lato browser
  pages/             Panoramica, Posizioni, Transazioni, Strumenti, Conti, Report, Impostazioni
  components/        componenti UI e grafici SVG
server/
  plugin.ts          monta l'API locale /api dentro il server di Vite
  api.ts             endpoint: fonti, collegamenti, sincronizzazione, autorizzazione bancaria
  store.ts           archivio locale delle credenziali (~/.finanza)
  providers/         Interactive Brokers, eToro, Scalable (CLI), exchange crypto (ccxt), Bitpanda, Enable Banking
```

## Note

- Tutti gli importi sono espressi in un'unica valuta di riferimento; i prezzi si aggiornano manualmente.
- Il grafico dell'andamento usa una fotografia del patrimonio salvata ogni giorno in cui apri l'app.
- Le cifre fiscali sono indicative e non sostituiscono la certificazione dell'intermediario.
