'use strict';
const http = require('http');

function escapeHtml(x) {
  return String(x ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function createDashboard({ port = 8787, getSnapshot, getContacts }) {
  let server;
  async function start() {
    if (server) return;
    server = http.createServer(async (req, res) => {
      try {
        if (req.url === '/api/metrics') {
          const body = JSON.stringify(await getSnapshot(), null, 2);
          res.writeHead(200, {'content-type':'application/json; charset=utf-8', 'cache-control':'no-store'});
          return res.end(body);
        }
        if (req.url === '/api/contacts') {
          const body = JSON.stringify(await getContacts(), null, 2);
          res.writeHead(200, {'content-type':'application/json; charset=utf-8', 'cache-control':'no-store'});
          return res.end(body);
        }
        const snap = await getSnapshot();
        const contacts = await getContacts();
        const cards = [
          ['Status', snap.status], ['Uptime', `${snap.telemetry.uptimeSeconds}s`],
          ['Replies', snap.telemetry.counters.repliesSent || 0], ['AI failures', snap.telemetry.counters.generationFailures || 0],
          ['Contacts', snap.store.knownChats], ['Memory turns', snap.store.memoryTurns],
          ['Voice notes', snap.telemetry.counters.voiceTranscribed || 0], ['Quality repairs', snap.telemetry.counters.qualityRepairs || 0]
        ].map(([k,v]) => `<div class="card"><small>${escapeHtml(k)}</small><strong>${escapeHtml(v)}</strong></div>`).join('');
        const rows = contacts.slice(0, 20).map(c => `<tr><td>${escapeHtml(c.name)}</td><td>${c.messages}</td><td>${c.ownerReplies}</td><td>${escapeHtml(c.activeHours.join(', '))}</td></tr>`).join('');
        const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>EVERBEST Control Center</title><style>body{font-family:system-ui;background:#0b1020;color:#eef2ff;max-width:1100px;margin:40px auto;padding:0 20px}h1{margin-bottom:4px}.muted{color:#9aa4bd}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:24px 0}.card{background:#141b31;border:1px solid #28314f;border-radius:14px;padding:16px}.card small{display:block;color:#9aa4bd}.card strong{font-size:25px}table{width:100%;border-collapse:collapse;background:#141b31;border-radius:14px;overflow:hidden}th,td{text-align:left;padding:12px;border-bottom:1px solid #28314f}code{color:#8ee6c9}</style></head><body><h1>EVERBEST Control Center</h1><div class="muted">Local observability dashboard • no message text stored here</div><div class="grid">${cards}</div><h2>Learned contacts</h2><table><thead><tr><th>Contact</th><th>Incoming</th><th>Owner replies</th><th>Active hours</th></tr></thead><tbody>${rows || '<tr><td colspan="4">No contact data yet</td></tr>'}</tbody></table><p class="muted">JSON endpoints: <code>/api/metrics</code> and <code>/api/contacts</code></p></body></html>`;
        res.writeHead(200, {'content-type':'text/html; charset=utf-8'}); res.end(html);
      } catch (e) { res.writeHead(500, {'content-type':'text/plain'}); res.end(`Dashboard error: ${e.message}`); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    return `http://127.0.0.1:${port}`;
  }
  async function stop() { if (!server) return; await new Promise(resolve => server.close(resolve)); server = null; }
  return { start, stop };
}
module.exports = { createDashboard };
