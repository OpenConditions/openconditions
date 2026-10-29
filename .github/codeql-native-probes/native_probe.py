# Inert native CodeQL qualification data; never imported or instantiated.
from http.server import BaseHTTPRequestHandler


class NativeMedium(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_header("Location", self.path)
