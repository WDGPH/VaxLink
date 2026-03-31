import { permissions } from '@/content/site'

export function PermissionsTable() {
  return (
    <div className="table-shell">
      <table className="info-table">
        <thead>
          <tr>
            <th>Permission</th>
            <th>Reason</th>
            <th>Optional</th>
            <th>Leaves Browser</th>
          </tr>
        </thead>
        <tbody>
          {permissions.map((row) => (
            <tr key={row.permission}>
              <td className="font-mono text-xs">{row.permission}</td>
              <td>{row.reason}</td>
              <td>{row.optional ? 'Yes' : 'No'}</td>
              <td>{row.leavesBrowser ? 'Yes' : 'No'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
