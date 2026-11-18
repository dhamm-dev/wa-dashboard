import './instance-lock.js';
import './db.js';
import { createServer } from 'node:http';

createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'GET' && req.url === '/api/health') {
    res.writeHead(200).end(JSON.stringify({ safeBoot: true }));
    return;
  }
  res.writeHead(503).end(JSON.stringify({ error: 'Unavailable' }));
}).listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () => console.log('Safe boot health listener ready'));
