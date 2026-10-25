"""Local QA server. Delayed catalogue endpoint tests non-blocking startup."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from time import sleep
import sys
import json

class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith('/qa/download/ch-'):
            number = self.path.split('ch-')[1].split('.')[0]
            data = {'id': 'ch-' + number, 'book_id': 'qa-download-fixture', 'language': 'fr', 'version': 1, 'title': {'target': 'Bonjour', 'english': 'Hello'}, 'pairs': [{'target': 'Bonjour.', 'english': 'Hello.', 'alignment': []}]}
            payload = json.dumps(data).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        if self.path.startswith('/qa/slow-library.json'):
            sleep(8)
            self.path = '/content/library.json'
        super().do_GET()

ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1]) if len(sys.argv) > 1 else 8791), Handler).serve_forever()
