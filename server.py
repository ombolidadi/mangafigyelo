#!/usr/bin/env python3
"""Mangafigyelő – helyi kiszolgáló.

Kiszolgálja a docs/ mappát, és két közvetítő végpontot ad a webappnak:
  /api/fetch?url=…&ref=…   egy oldal (HTML / JSON / RSS) letöltése
  /api/img?url=…&ref=…     egy kép letöltése (a megfelelő Referer fejléccel)

Indítás:  python3 server.py [port] [--allow-local]
Opcionális jelszó:  ACCESS_KEY=titok python3 server.py
"""
import gzip
import ipaddress
import json
import os
import shutil
import socket
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
import zlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "docs")
ACCESS_KEY = os.environ.get("ACCESS_KEY", "")
ALLOW_LOCAL = "--allow-local" in sys.argv or os.environ.get("ALLOW_LOCAL") == "1"
MAX_PAGE = 8 * 1024 * 1024
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
      "(KHTML, like Gecko) Version/17.5 Safari/605.1.15")


class Refused(Exception):
    pass


def check_url(url):
    """Csak nyilvános http(s) címeket engedünk, hogy a proxy ne lásson be a helyi hálózatba."""
    p = urllib.parse.urlsplit(url)
    if p.scheme not in ("http", "https") or not p.hostname:
        raise Refused("Érvénytelen cím.")
    if ALLOW_LOCAL:
        return
    try:
        infos = socket.getaddrinfo(p.hostname, None)
    except socket.gaierror:
        raise Refused("A forrásoldal címe nem található.")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global:
            raise Refused("Helyi hálózati cím nem tölthető le.")


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        check_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def make_opener():
    ctx = ssl.create_default_context()
    # A python.org-os macOS telepítés gyakran tanúsítványok nélkül érkezik.
    if not ctx.cert_store_stats().get("x509_ca") and os.path.exists("/etc/ssl/cert.pem"):
        ctx.load_verify_locations("/etc/ssl/cert.pem")
    return urllib.request.build_opener(SafeRedirect, urllib.request.HTTPSHandler(context=ctx))


OPENER = make_opener()


def upstream(url, ref, accept):
    url = urllib.parse.quote(url, safe=":/?#[]@!$&'()*+,;=%~")
    check_url(url)
    headers = {
        "User-Agent": UA,
        "Accept": accept,
        "Accept-Language": "en-US,en;q=0.9,hu;q=0.8",
        "Accept-Encoding": "gzip, deflate",
    }
    if ref:
        headers["Referer"] = urllib.parse.quote(ref, safe=":/?#[]@!$&'()*+,;=%~")
    return OPENER.open(urllib.request.Request(url, headers=headers), timeout=25)


def decode(body, encoding):
    if encoding == "gzip":
        return gzip.decompress(body)
    if encoding == "deflate":
        try:
            return zlib.decompress(body)
        except zlib.error:
            return zlib.decompress(body, -zlib.MAX_WBITS)
    return body


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self):
        parts = urllib.parse.urlsplit(self.path)
        if parts.path in ("/api/fetch", "/api/img"):
            self.api(parts.path == "/api/img", urllib.parse.parse_qs(parts.query))
        else:
            super().do_GET()

    def fail(self, status, message):
        body = json.dumps({"error": message}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def api(self, is_img, query):
        arg = lambda name: (query.get(name) or [""])[0]
        if ACCESS_KEY and arg("k") != ACCESS_KEY:
            return self.fail(401, "Hibás vagy hiányzó hozzáférési kulcs (Beállítások).")
        url = arg("url")
        if not url:
            return self.fail(400, "Hiányzó cím.")
        accept = ("image/avif,image/webp,image/png,image/jpeg,*/*;q=0.5" if is_img
                  else "text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8")
        try:
            resp = upstream(url, arg("ref"), accept)
        except Refused as e:
            return self.fail(400, str(e))
        except urllib.error.HTTPError as e:
            return self.fail(502, f"A forrásoldal hibát adott ({e.code}).")
        except Exception:
            return self.fail(502, "Nem sikerült elérni a forrásoldalt.")
        with resp:
            ctype = resp.headers.get("Content-Type", "application/octet-stream")
            encoding = (resp.headers.get("Content-Encoding") or "").lower()
            try:
                if is_img:
                    if not ctype.startswith(("image/", "application/octet-stream", "binary/")):
                        return self.fail(502, "A forrás nem képet adott vissza.")
                    self.send_response(200)
                    self.send_header("Content-Type", ctype)
                    self.send_header("Cache-Control", "public, max-age=604800")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    if encoding in ("gzip", "deflate"):
                        body = decode(resp.read(), encoding)
                        self.send_header("Content-Length", str(len(body)))
                        self.end_headers()
                        self.wfile.write(body)
                    else:
                        if resp.headers.get("Content-Length"):
                            self.send_header("Content-Length", resp.headers["Content-Length"])
                        self.end_headers()
                        shutil.copyfileobj(resp, self.wfile)
                else:
                    body = decode(resp.read(MAX_PAGE), encoding)
                    self.send_response(200)
                    self.send_header("Content-Type", ctype)
                    self.send_header("Content-Length", str(len(body)))
                    self.send_header("X-Final-Url", resp.geturl())
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.send_header("Access-Control-Expose-Headers", "X-Final-Url")
                    self.end_headers()
                    self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def log_message(self, fmt, *args):
        if self.path.startswith("/api/"):
            super().log_message(fmt, *args)


if __name__ == "__main__":
    ports = [a for a in sys.argv[1:] if a.isdigit()]
    port = int(ports[0]) if ports else 8787
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"Mangafigyelő: http://localhost:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
