#!/usr/bin/env python3
"""Local dev/production server for the Inquisitor app.

Drop-in replacement for `python -m http.server` that also serves
GET /api/setup-file by reading InquisitorSetup.txt straight from the
operator's Documents folder. This lets the page auto-load match setup
with a plain fetch() on every launch -- no File System Access permission
prompt, no manual step, and it survives a full browser restart (unlike
a browser-granted file handle, which Chrome forgets once the browser
closes).
"""
import ctypes
import os
import pathlib
import socketserver
import sys
from http.server import SimpleHTTPRequestHandler

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 3334


def documents_folder():
    # home() / 'Documents' is only a guess -- OneDrive's "Known Folder Move" (and similar
    # tools) redirects the real Documents folder elsewhere (e.g. .../OneDrive/Documents)
    # by updating the registry, not by moving/symlinking the default path. Ask Windows for
    # the actual location (CSIDL_PERSONAL = 5) instead of guessing.
    if sys.platform == 'win32':
        buf = ctypes.create_unicode_buffer(260)
        if ctypes.windll.shell32.SHGetFolderPathW(None, 5, None, 0, buf) == 0:
            return pathlib.Path(buf.value)
    return pathlib.Path.home() / 'Documents'


SETUP_FILE = documents_folder() / 'InquisitorSetup.txt'

# Without an explicit Cache-Control, Chrome may serve sw.js from its plain HTTP cache on the
# next page load instead of asking the server -- so a CACHE-version bump in sw.js can go
# completely unnoticed (the update check never even sees the new bytes). index.html gets the
# same treatment so a browser tab never runs a stale copy of the page shell either.
NO_STORE_PATHS = {'/sw.js', '/', '/index.html'}


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        if self.path in NO_STORE_PATHS:
            self.send_header('Cache-Control', 'no-store, must-revalidate')
        super().end_headers()

    def do_GET(self):
        if self.path == '/api/setup-file':
            if SETUP_FILE.is_file():
                data = SETUP_FILE.read_bytes()
                self.send_response(200)
                self.send_header('Content-Type', 'text/plain; charset=utf-8')
                self.send_header('Content-Length', str(len(data)))
                self.send_header('Cache-Control', 'no-store')
                self.end_headers()
                self.wfile.write(data)
            else:
                self.send_response(404)
                self.send_header('Content-Length', '0')
                self.end_headers()
            return
        super().do_GET()


class Server(socketserver.TCPServer):
    # No allow_reuse_address: on Windows, SO_REUSEADDR lets a second process bind the same
    # port a first one is already listening on, and incoming requests then land on whichever
    # process the OS happens to pick -- silently split-brained, some serving old code, some
    # new. Better to fail loudly below than to let that happen.
    pass


if __name__ == '__main__':
    os.chdir(pathlib.Path(__file__).resolve().parent)
    try:
        httpd = Server(('', PORT), Handler)
    except OSError as e:
        print(f'Could not start on port {PORT}: {e}')
        print('An Inquisitor server may already be running -- close its console window first.')
        sys.exit(1)
    with httpd:
        print(f'Inquisitor server running at http://localhost:{PORT}')
        print(f'Setup file location: {SETUP_FILE}')
        httpd.serve_forever()
