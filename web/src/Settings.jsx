import { useState } from 'react'
import Accounts from './Accounts.jsx'
import Mcp from './Mcp.jsx'
import Permissions from './Permissions.jsx'
import Pairing from './Pairing.jsx'

/**
 * Settings: the things the deck needs in order to see anything.
 *
 * Tabs rather than separate screens because they are one subject: what this
 * machine will let a session do. Accounts and MCP answer "is this capability
 * actually available", and both fail the same silent way. Permissions answers
 * the other half — what it may do without stopping to ask you.
 *
 * Each tab owns its own data and its own Re-check, and is handed the tab bar
 * to render inside its header. That keeps one header on screen instead of
 * two, without either panel having to know the other exists.
 */

const TABS = [
  { key: 'accounts', label: 'Accounts' },
  { key: 'mcp', label: 'MCP servers' },
  { key: 'permissions', label: 'Permissions' },
  { key: 'pairing', label: 'Pairing' },
]

export default function Settings() {
  const [tab, setTab] = useState('accounts')

  const bar = (
    <div className="seg seg-tabs" role="tablist" aria-label="Settings sections">
      {TABS.map((item) => (
        <button
          key={item.key}
          role="tab"
          aria-selected={tab === item.key}
          className={`seg-btn${tab === item.key ? ' is-on' : ''}`}
          onClick={() => setTab(item.key)}
        >
          {item.label}
        </button>
      ))}
    </div>
  )

  // Mounted one at a time on purpose: each tab health-checks real tools on
  // mount, and paying for both when you asked for one would be rude.
  if (tab === 'accounts') return <Accounts tabs={bar} />
  if (tab === 'mcp') return <Mcp tabs={bar} />
  if (tab === 'permissions') return <Permissions tabs={bar} />
  return <Pairing tabs={bar} />
}
