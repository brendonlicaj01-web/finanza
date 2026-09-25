# Bozza — Trasferimenti tra conti

Stato: **bozza, da riprendere**. Analisi dei conflitti tra i dati dei conti quando sposti liquidità, titoli o crypto
da un tuo conto a un altro (es. BTC da Trade Republic a OKX). Oggi l'app non ha il concetto di "trasferimento tra
conti tuoi": ogni conto vede solo la sua metà del movimento.

## A. Titoli e crypto (es. BTC da Trade Republic a OKX)

Ogni fonte descrive l'uscita e l'entrata a modo suo:

| Fonte | Titoli/crypto in uscita | Titoli/crypto in entrata |
|---|---|---|
| Trade Republic (`FREE_DELIVERY` / `FREE_RECEIPT`) | **vendita** al prezzo del giorno + prelievo di pari valore | **acquisto** al prezzo del giorno + deposito |
| OKX (Funding: withdrawal / deposit) | **vendita** al valore del giorno + prelievo | **acquisto** al valore del giorno + deposito |
| Scalable (transazioni non-trade) | vendita + prelievo | acquisto + deposito |
| Exchange via API, IBKR, eToro, Bitpanda | nessuna transazione: dopo la sync compare un "**Allineamento al saldo**" (vendita datata oggi) | nessuna transazione: compare un "**Saldo iniziale**" (acquisto datato prima della prima operazione) |

Conflitti:

1. **Plusvalenza finta su chi invia.** La "vendita" chiude la posizione al prezzo del giorno contro il costo medio:
   il guadagno finisce nei realizzati e nel report annuale, ma fiscalmente non c'è stata alcuna vendita.
2. **Costo di carico perso su chi riceve.** L'"acquisto" riparte dal prezzo del giorno del trasferimento, oppure dal
   prezzo del broker o da quello attuale ("da verificare"). Il guadagno latente è sbagliato e la data del primo
   acquisto va persa.
3. **Quantità diverse.** Esce 0,0101 BTC ed entra 0,0100 BTC: la differenza è una commissione di rete, non una
   vendita.
4. **Date diverse.** Uscita e arrivo cadono in giorni diversi (conferme blockchain, trasferimenti titoli di qualche
   giorno). Nel frattempo il titolo non è in nessun conto e il patrimonio ha un buco.
5. **Stesso strumento con due nomi.** TR e OKX chiamano il Bitcoin "BTC" e l'app li unisce. Scalable invece lo
   registra con ISIN (`XF000BTC0017`) e nome "Bitcoin", quindi per l'app è un altro strumento e l'abbinamento non
   riesce.

## B. Liquidità (es. bonifico Fineco → Scalable, banca → OKX)

6. **Versamenti e prelievi gonfiati.** Il conto che invia registra un prelievo e quello che riceve un deposito. Il
   patrimonio e il capitale versato totale tornano, perché i due movimenti si annullano, ma nel report annuale le
   colonne Versamenti e Prelievi contano due volte lo stesso bonifico.
7. **Importi e date che non coincidono.** Bonifico ordinario da D a D+1/D+2, costi del bonifico, cambio valuta
   (es. USD su IBKR).

## C. Casi di contorno

8. **Metà senza controparte.** Invii a un wallet personale o a un conto non collegato: l'app non può distinguerlo da
   una vendita o da un pagamento.
9. **Conflitto con i meccanismi esistenti.**
   - Se un trasferimento viene sistemato dopo che un "Allineamento" l'ha già compensato, la quantità viene contata
     due volte.
   - Una transazione riscritta dalla sync (aggiornamento per `rev`, vedi Scalable) non deve perdere l'abbinamento.

## Piano proposto, un passo alla volta

1. ✅ **Riconoscimento (sola lettura).** Pagina "Trasferimenti" (`src/lib/transfers.ts`, `src/pages/Transfers.tsx`):
   - coppie uscita/entrata di titoli e crypto: stesso strumento (per le crypto basta il simbolo), conti diversi,
     quantità in arrivo tra 80% e 100% di quella partita, entrata tra 2 giorni prima e 10 dopo. Almeno una metà
     deve essere indicata dalla fonte come trasferimento (movimento speculare `:cash` o descrizione) oppure essere
     una rettifica automatica al saldo;
   - bonifici tra conti: prelievo e deposito di importo uguale o poco minore (fino a 2 € o 1%), entro 5 giorni;
   - abbinamento uno a uno, affidabilità (probabile / possibile / da verificare) con i motivi;
   - plusvalenza che oggi viene registrata sulla falsa vendita, e invii senza controparte.
   ✅ **Etichetta "Trasferimento crypto interno"** (`trasf_uscita` / `trasf_entrata`): Trade Republic, OKX e
   Scalable registrano così le crypto inviate/ricevute, senza movimento di liquidità speculare. Il calcolo abbina
   le due metà etichettate con le stesse regole (`transferLinks`) e sposta il costo medio; un'entrata senza
   controparte usa il valore del giorno. I dati importati prima si convertono reimportando i file (TR, OKX) o alla
   prossima sincronizzazione (Scalable): la transazione si aggiorna per `rev` e il movimento `:cash` si elimina
   (`SyncResult.remove`).
2. ✅ **Abbinamento e conferma.** Nella pagina Trasferimenti ogni coppia proposta si conferma o si scarta
   ("Non è un trasferimento"); i movimenti senza controparte si abbinano a mano scegliendo l'altra metà
   (`counterparts`: verso opposto, stesso strumento o liquidità, altro conto, dal più vicino nel tempo).
   Le decisioni sono in `AppData.transferLinks` e agganciano le transazioni per identificativo della fonte
   (`TxRef`), quindi valgono anche dopo sincronizzazioni e reimport; sono incluse nei backup e vengono tolte
   eliminando un conto. Una coppia confermata vale sempre (e le sue metà non vengono proposte altrove), una
   scartata non viene più proposta (si può ripristinare). Per le coppie etichettate "Trasferimento crypto
   interno" la decisione cambia già il calcolo; per vendita + acquisto e bonifici l'effetto arriva al passo 3.
3. ✅ **Effetto sul calcolo.** Una coppia di titoli/crypto confermata non è più né vendita né acquisto
   (`transferPlan`): la "vendita" toglie le quantità al costo medio senza plusvalenza, l'"acquisto" riceve quel
   costo (anche per la parte persa in commissioni di rete, che resta sul costo delle quantità arrivate), e i
   movimenti di liquidità speculari creati dagli import (`:cash`) non contano più, né in liquidità né nei report.
   Le coppie solo proposte non cambiano il calcolo; annullare la conferma ripristina tutto. Nell'elenco
   Transazioni le righe coinvolte sono indicate come trasferimento o movimento non conteggiato.
4. ✅ **Liquidità.** Un bonifico tra conti propri confermato (`TransferPlan.giroconti`) sposta la liquidità ma non
   conta come versamento né prelievo (report annuale, capitale versato, grafico); la parte non arrivata (costo del
   bonifico) è una commissione. I bonifici solo proposti non cambiano nulla.
5. **Unificazione degli strumenti.** Rendere uguale BTC di Scalable a BTC di TR/OKX.
