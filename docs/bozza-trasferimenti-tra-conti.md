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
2. **Abbinamento e conferma.** L'utente conferma una coppia; l'abbinamento resta valido anche dopo le sync.
3. **Effetto sul calcolo.** Una coppia confermata non è più né vendita né acquisto: il costo medio passa dal conto
   che invia a quello che riceve e la differenza di quantità diventa una commissione.
4. **Liquidità.** Anche i bonifici tra conti propri, abbinati, non contano più come versamento o prelievo nel report.
5. **Unificazione degli strumenti.** Rendere uguale BTC di Scalable a BTC di TR/OKX.
