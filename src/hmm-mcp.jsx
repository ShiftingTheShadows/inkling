// hmm-mcp.jsx — in-app guide for connecting the Inkling MCP server (see mcp/)
// to Claude Code, Claude Desktop, Cursor, VS Code and friends. Pre-fills the
// user's Railway sync URL/token and generates copy-paste configs per client.
const { useState, useContext } = React;
const { AppCtx } = window;

const MCP_REPO = 'https://github.com/ShiftingTheShadows/inkling';
const MCP_CLIENTS = [
  ['code', 'CLAUDE CODE'], ['desktop', 'CLAUDE DESKTOP'], ['cursor', 'CURSOR'],
  ['vscode', 'VS CODE'], ['other', 'OTHER'],
];

function CodeBlock({ text, shown, label, onCopy }) {
  return (
    <div style={{ position: 'relative', margin: '6px 0 10px' }}>
      <pre style={{ margin: 0, padding: '10px 70px 10px 12px', background: 'var(--bg)', border: '1px solid var(--border2)', fontSize: 11, lineHeight: 1.6, overflowX: 'auto', whiteSpace: 'pre', color: 'var(--text)' }}>{shown ?? text}</pre>
      <button className="btn-secondary btn-sm" style={{ position: 'absolute', top: 6, right: 6 }} onClick={() => onCopy(text, label)}>COPY</button>
    </div>
  );
}

function McpStep({ n, title, children }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', color: 'var(--text)', marginBottom: 4 }}>
        <span style={{ color: 'var(--accent)', marginRight: 8 }}>{n}.</span>{title}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text2)', lineHeight: 1.7 }}>{children}</div>
    </div>
  );
}

function McpSetupModal({ onClose }) {
  const ctx = useContext(AppCtx);
  const url = (localStorage.getItem('hmm_railway_url') || '').trim().replace(/\/+$/, '');
  const token = (localStorage.getItem('hmm_railway_token') || '').trim();
  const [client, setClient] = useState('code');
  const [dir, setDir] = useState(() => localStorage.getItem('hmm_mcp_path') || '');
  const [reveal, setReveal] = useState(false);
  const [useFile, setUseFile] = useState(false);

  const setPath = v => { setDir(v); try { localStorage.setItem('hmm_mcp_path', v); } catch {} };
  const copy = (text, label) => {
    navigator.clipboard?.writeText(text).then(
      () => ctx.addToast(`${label || 'Copied'} copied`, 'success'),
      () => ctx.addToast('Copy failed — select the text manually', 'error'));
  };

  // Accept either the mcp/ folder or the full path to index.js
  const raw = dir.trim().replace(/^["']|["']$/g, '');
  const sep = raw.includes('\\') ? '\\' : '/';
  const indexPath = !raw ? '<ABS_PATH>/index.js' : /index\.js$/.test(raw) ? raw : raw.replace(/[\\/]+$/, '') + sep + 'index.js';

  const U = url || 'https://your-app.up.railway.app';
  const T = token || 'your-sync-token';
  const MASK = '••••••••';
  const hide = t => (reveal || !token ? t : t.split(token).join(MASK));

  const env = { INKLING_SYNC_URL: U, INKLING_SYNC_TOKEN: T };
  const server = useFile
    ? { command: 'node', args: [indexPath] }
    : { command: 'node', args: [indexPath], env };
  const json = o => JSON.stringify(o, null, 2);

  const configs = {
    code: {
      where: <>Run this in any terminal. <code>-s user</code> makes it available in every project; use <code>-s project</code> to share it with a repo instead.</>,
      text: `claude mcp add inkling -s user${useFile ? '' : ` -e INKLING_SYNC_URL=${U} -e INKLING_SYNC_TOKEN=${T}`} -- node "${indexPath}"`,
      after: <>Check it with <code>claude mcp list</code>, or type <code>/mcp</code> inside Claude Code — <code>inkling</code> should show as connected. Start a new session if you added it mid-chat.</>,
    },
    desktop: {
      where: <>Open <b>Settings → Developer → Edit Config</b> in Claude Desktop (or edit the file directly) and merge this into <code>mcpServers</code>. Config file:<br />
        macOS: <code>~/Library/Application Support/Claude/claude_desktop_config.json</code><br />
        Windows: <code>%APPDATA%\Claude\claude_desktop_config.json</code><br />
        Linux: <code>~/.config/Claude/claude_desktop_config.json</code></>,
      text: json({ mcpServers: { inkling: server } }),
      after: <>Fully <b>quit</b> Claude Desktop (system tray / menu bar, not just the window) and relaunch — it only reads the config at startup.
        On the Microsoft Store build, the live file is under <code>%LOCALAPPDATA%\Packages\Claude_&lt;id&gt;\LocalCache\Roaming\Claude\</code>; a copy in <code>%APPDATA%</code> does nothing.</>,
    },
    cursor: {
      where: <>Save as <code>~/.cursor/mcp.json</code> (all projects) or <code>.cursor/mcp.json</code> inside a project. Or use <b>Settings → MCP → Add new MCP server</b>.</>,
      text: json({ mcpServers: { inkling: server } }),
      after: <>Toggle the server on under <b>Settings → MCP</b>; it should show a green dot and the 6 tools.</>,
    },
    vscode: {
      where: <>Save as <code>.vscode/mcp.json</code> in your workspace (note the key is <code>servers</code>, not <code>mcpServers</code>), or run <b>MCP: Add Server</b> from the command palette.</>,
      text: json({ servers: { inkling: { type: 'stdio', ...server } } }),
      after: <>Click <b>Start</b> above the server entry in the file, then use it from Copilot Chat in agent mode.</>,
    },
    other: {
      where: <>Anything that speaks MCP over stdio (Windsurf: <code>~/.codeium/windsurf/mcp_config.json</code>, Zed, Cline, …) takes the same three pieces — a command, its args, and env vars. Most use the <code>mcpServers</code> shape:</>,
      text: json({ mcpServers: { inkling: server } }),
      after: <>If a client wants a transport, it's <code>stdio</code>. Restart the client after saving.</>,
    },
  };
  const cfg = configs[client];

  const fileText = json({ url: U, token: T });
  const ready = url && token;

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-lg">
        <div className="modal-header">
          <span className="modal-title">CONNECT CLAUDE (MCP)</span>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div style={{ background: 'var(--surface2)', border: '1px solid var(--border2)', padding: '12px 16px', marginBottom: 18, fontSize: 11, color: 'var(--text2)', lineHeight: 1.8 }}>
            The MCP server lets Claude <b style={{ color: 'var(--text)' }}>create, edit and delete characters</b> straight from a conversation (Claude Code, Claude Desktop, Cursor…).
            It can't reach this tab directly — it goes through your <b style={{ color: 'var(--text)' }}>Railway sync server</b>, and the app pulls the changes in about a minute (or hit Sync now).
          </div>

          <McpStep n={1} title="Turn on Railway sync">
            <div style={{ color: ready ? 'var(--accent2)' : 'var(--warning)' }}>
              {ready ? '✓ Railway URL and token found — they\'re filled into the snippets below.' : '✗ No Railway URL/token saved yet. Set them in Sync → Railway (see server/README.md to deploy), then reopen this guide.'}
            </div>
            {ready && localStorage.getItem('hmm_railway_autosync') !== 'true' && (
              <div style={{ color: 'var(--warning)' }}>Auto-sync is off, so new characters only appear after you press Pull. Turn it on in Sync → Railway to get them automatically.</div>
            )}
            <div>GitHub Gist sync does not work with MCP. If you deployed the server before the MCP existed, redeploy it — it needs the <code>revision</code> column.</div>
          </McpStep>

          <McpStep n={2} title="Get the MCP server (Node 18+)">
            <CodeBlock text={`git clone ${MCP_REPO}\ncd inkling/mcp\nnpm install`} label="Commands" onCopy={copy} />
          </McpStep>

          <McpStep n={3} title="Tell me where it lives">
            Paste the <b>absolute</b> path to the <code>mcp</code> folder (or straight to <code>index.js</code>). In that folder run <code>pwd</code> (macOS/Linux) or <code>Resolve-Path .</code> (PowerShell).
            <input className="form-input" style={{ marginTop: 6 }} value={dir} onChange={e => setPath(e.target.value)}
              placeholder="/home/you/inkling/mcp   or   C:\Users\you\inkling\mcp" />
          </McpStep>

          <McpStep n={4} title="Add it to your client">
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 10 }}>
              {MCP_CLIENTS.map(([id, label]) => (
                <button key={id} className={`filter-btn${client === id ? ' active' : ''}`} style={{ flex: '0 0 auto', padding: '5px 10px' }} onClick={() => setClient(id)}>{label}</button>
              ))}
            </div>
            <div>{cfg.where}</div>
            <CodeBlock text={cfg.text} shown={hide(cfg.text)} label="Config" onCopy={copy} />
            <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', fontSize: 11, marginBottom: 8 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input type="checkbox" checked={reveal} onChange={e => setReveal(e.target.checked)} style={{ width: 14, height: 14, accentColor: 'var(--accent)', flexShrink: 0 }} /> Show token
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input type="checkbox" checked={useFile} onChange={e => setUseFile(e.target.checked)} style={{ width: 14, height: 14, accentColor: 'var(--accent)', flexShrink: 0 }} /> Keep the token out of client configs
              </label>
            </div>
            {useFile && (
              <>
                <div>Save this once as <code>~/.inkling-mcp.json</code> (<code>%USERPROFILE%\.inkling-mcp.json</code> on Windows). The server reads it when the env vars aren't set, so every client shares one copy.</div>
                <CodeBlock text={fileText} shown={hide(fileText)} label="~/.inkling-mcp.json" onCopy={copy} />
              </>
            )}
            <div>{cfg.after}</div>
            <div style={{ color: 'var(--warning)', marginTop: 6 }}>The token grants full read/write access to your whole backup and sits in plaintext in that config. Treat it like a password and never commit it.</div>
          </McpStep>

          <McpStep n={5} title="Test it">
            Ask Claude: <i>"Run inkling_status."</i> You should get a connection check plus your character count. Then try <i>"Make me a grumpy lighthouse keeper named Odd."</i>
            <div style={{ marginTop: 6 }}>Tools: <code>inkling_status</code>, <code>inkling_list_characters</code>, <code>inkling_get_character</code>, <code>inkling_create_character</code>, <code>inkling_update_character</code>, <code>inkling_delete_character</code>, plus personas, chats, folders and scripts (<code>inkling_list_personas</code>, <code>inkling_get_chat</code>, <code>inkling_create_folder</code>, <code>inkling_create_script</code> and friends).</div>
          </McpStep>

          <McpStep n={6} title="If it doesn't work">
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              <li>Server not showing up → the path must be absolute, <code>node -v</code> must be 18+, and you ran <code>npm install</code> in <code>mcp/</code>. Restart the client fully.</li>
              <li><code>inkling_status</code> errors → wrong URL/token, or the sync server isn't reachable. Open the URL in a browser; it should respond.</li>
              <li>Writes rejected with 400 → redeploy the sync server (older versions lack the revision column).</li>
              <li>Changes don't appear in the app → press Sync now, or enable Auto-sync.</li>
            </ul>
          </McpStep>
        </div>
        <div className="modal-footer">
          <button className="btn-primary" onClick={onClose}>DONE</button>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { McpSetupModal });
