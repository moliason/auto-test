import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Deliberately deterministic, disposable demo service. The token is demo data, not a credential.
export function createDemoServer() {
  return createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 64000) {
        res.writeHead(413);
        res.end('{}');
        return;
      }
    }
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/login' && req.method === 'POST') {
      let input;
      try {
        input = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end('{"error":"invalid JSON"}');
        return;
      }
      if (input.username === 'demo' && input.password === 'demo-password') {
        res.end(JSON.stringify({ token: 'demo-token', user: { id: 7 } }));
      } else {
        res.writeHead(401);
        res.end('{"error":"invalid credentials"}');
      }
    } else if (url.pathname === '/profile') {
      if (req.headers.authorization !== 'Bearer demo-token') {
        res.writeHead(401);
        res.end('{"error":"unauthorized"}');
      } else res.end(JSON.stringify({ id: 7, name: 'Demo user' }));
    } else if (url.pathname === '/broken-total') {
      res.end('{"total":90}'); // The demo requirement says 100: an intentional, observable defect.
    } else if (url.pathname === '/echo') {
      res.end(
        JSON.stringify({
          body: body ? JSON.parse(body) : null,
          query: Object.fromEntries(url.searchParams),
          method: req.method,
        })
      );
    } else if (url.pathname === '/slow') {
      const timer = setTimeout(() => res.end('{"ok":true}'), 2000);
      res.on('close', () => clearTimeout(timer));
    } else if (url.pathname === '/disconnect') {
      req.socket.destroy();
    } else if (url.pathname === '/redirect') {
      res.writeHead(302, { Location: '/profile' });
      res.end('{}');
    } else if (url.pathname === '/large') {
      res.end('x'.repeat(1024 * 1024 + 1));
    } else if (url.pathname === '/plain') {
      res.setHeader('Content-Type', 'text/plain');
      res.end('healthy');
    } else {
      res.writeHead(404);
      res.end('{"error":"not found"}');
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.DEMO_PORT || 4010);
  createDemoServer().listen(port, '127.0.0.1', () => console.log(`Demo API: http://127.0.0.1:${port}`));
}
