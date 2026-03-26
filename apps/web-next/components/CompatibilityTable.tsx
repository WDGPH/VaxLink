import { compatibilityRows } from '@/content/site'

const STATUS_CLASS: Record<(typeof compatibilityRows)[number]['status'], string> = {
  supported: 'status-supported',
  planned: 'status-planned',
  limited: 'status-limited',
}

export function CompatibilityTable() {
  return (
    <div className="table-shell">
      <table className="info-table">
        <thead>
          <tr>
            <th>Browser</th>
            <th>CHR / EMR</th>
            <th>Status</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {compatibilityRows.map((row) => (
            <tr key={`${row.browser}-${row.chr}`}>
              <td>{row.browser}</td>
              <td>{row.chr}</td>
              <td>
                <span className={`status-pill ${STATUS_CLASS[row.status]}`}>{row.status}</span>
              </td>
              <td>{row.notes}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
