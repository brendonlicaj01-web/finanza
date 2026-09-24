import { useStore } from '../store';
import { money } from '../lib/format';
import { Card, Delta, Empty, PageHead } from '../components/ui';

export function Reports() {
  const { result } = useStore();
  const years = result.years;

  return (
    <div className="stack">
      <PageHead
        title="Report annuale"
        sub="Riepilogo per anno di plusvalenze/minusvalenze realizzate, proventi e costi."
      />
      <Card>
        {years.length === 0 ? (
          <Empty title="Nessun dato">
            <p>Il report si popola man mano che registri le transazioni.</p>
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Anno</th>
                  <th className="num">Plus/minus realizzate</th>
                  <th className="num">Dividendi / cedole</th>
                  <th className="num">Interessi</th>
                  <th className="num">Commissioni e imposte</th>
                  <th className="num hide-mobile">Versamenti</th>
                  <th className="num hide-mobile">Prelievi</th>
                </tr>
              </thead>
              <tbody>
                {years.map((y) => (
                  <tr key={y.year}>
                    <td className="cell-title">{y.year}</td>
                    <td className="num">
                      <Delta value={y.realized} />
                    </td>
                    <td className="num">{money(y.income)}</td>
                    <td className="num">{money(y.interest)}</td>
                    <td className="num">{money(y.fees)}</td>
                    <td className="num hide-mobile">{money(y.deposits)}</td>
                    <td className="num hide-mobile">{money(y.withdrawals)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="small muted">
        Le cifre sono indicative e calcolate con il costo medio ponderato. Non sostituiscono la certificazione
        fiscale del tuo intermediario né il parere di un commercialista (es. per regime dichiarativo, compensazione
        delle minusvalenze o redditi diversi vs. di capitale).
      </p>
    </div>
  );
}
