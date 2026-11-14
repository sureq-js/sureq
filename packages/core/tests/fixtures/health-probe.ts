// The README "Health checks" probe, verbatim between the markers (checked by tests/unit/readme.test.ts)
// and type-checked with the package. Not run: it starts a server.
// --- snippet start
import { createServer } from 'node:http'
import { Queue } from '@sureq/core'

const queue = new Queue('emails')

createServer(async (req, res) => {
  if (req.url !== '/livez' && req.url !== '/readyz') return void res.writeHead(404).end()
  const report = await queue.health() // never rejects; the store check is bounded (2 s)
  const ok = req.url === '/livez' ? report.live : report.ready
  res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' }).end(JSON.stringify(report))
}).listen(8080)
// --- snippet end
