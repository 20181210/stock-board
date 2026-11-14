"""Local-only chart server. Run: python server.py"""
import argparse
import datetime as dt
import json
import mimetypes
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from market import aggregate, load_market, fetch, HTTP
import urllib.parse


def cn_suggest(query):
    """Return a small public A-share name/code suggestion list."""
    query = query.strip()[:32]
    if not query:
        return []
    url = "https://searchapi.eastmoney.com/api/suggest/get?" + urllib.parse.urlencode({
        "input": query, "type": 14, "token": "0c7e8b6f5b8c0c4f8b3e6a8c7d9e0f1a",
    })
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Referer": "https://quote.eastmoney.com/"})
    with HTTP.open(request, timeout=12) as response:
        raw = json.loads(response.read().decode("utf-8"))
    rows = raw.get("QuotationCodeTable", {}).get("Data", []) if isinstance(raw, dict) else []
    return [dict(symbol=str(row.get("Code", "")), name=str(row.get("Name", "")), market="cn")
            for row in rows if row.get("Code") and row.get("Name") and row.get("Classify") == "AStock"][:10]

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / "data" / "cache"
LOCKS = {}
LOCK = threading.Lock()


def history(market, symbol, refresh=False):
    # Never use an untrusted symbol as a path.
    import hashlib
    identity = market + ":" + symbol
    key = hashlib.sha256(identity.encode()).hexdigest()
    path = CACHE / (key + ".json")
    with LOCK:
        gate = LOCKS.setdefault(key, threading.Lock())
    with gate:
        saved = None
        if path.exists():
            try:
                saved = json.loads(path.read_text(encoding="utf-8"))
            except (ValueError, OSError):
                pass
        if saved and saved.get("schema") == 2 and not refresh and time.time() - saved["fetchedAt"] < 300:
            return dict(saved, cached=True, stale=False)
        try:
            bars, meta = load_market(market, symbol)
            if not bars:
                raise ValueError("数据源未返回有效K线，请检查代码")
            # Each response is kept intact, so adjustment changes cannot mix
            # historical price bases. Multi-day grouping uses an explicit anchor.
            result = dict(bars=bars, meta=meta, fetchedAt=time.time(), schema=2)
            CACHE.mkdir(parents=True, exist_ok=True)
            temporary = path.with_suffix(".tmp")
            temporary.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
            temporary.replace(path)
            return dict(result, cached=False, stale=False)
        except Exception as error:
            if saved:
                return dict(saved, cached=True, stale=True, warning="数据源连接失败，正在显示上次缓存：" + str(error))
            raise


class Handler(BaseHTTPRequestHandler):
    def send_json(self, payload, status=200):
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            return self.send_json({"ok": True, "app": "free-chart"})
        if parsed.path == "/api/cn-search":
            args = parse_qs(parsed.query)
            try:
                return self.send_json({"data": cn_suggest(args.get("q", [""])[0])})
            except Exception:
                return self.send_json({"data": [], "warning": "A股名称搜索暂时不可用"})
        if parsed.path == "/api/history":
            args = parse_qs(parsed.query)
            get = lambda key, default: args.get(key, [default])[0]
            market, symbol = get("market", "us"), get("symbol", "AAPL").strip()[:32]
            if market not in ("us", "cn", "fx", "crypto"):
                return self.send_json({"error": "不支持的市场"}, 400)
            try:
                result = history(market, symbol, get("refresh", "0") == "1")
                period, anchor = get("period", "1"), get("anchor", "2025-01-01")
                result["data"] = aggregate(result["bars"], period, anchor)
                result["meta"] = dict(result["meta"], firstDate=dt.datetime.fromtimestamp(result["bars"][0]["timestamp"] / 1000, dt.timezone.utc).strftime("%Y-%m-%d"),
                    lastDate=dt.datetime.fromtimestamp(result["bars"][-1]["timestamp"] / 1000, dt.timezone.utc).strftime("%Y-%m-%d"),
                    rawCount=len(result["bars"]), period=period, anchor=anchor)
                del result["bars"]
                return self.send_json(result)
            except ValueError as error:
                return self.send_json({"error": str(error)}, 400)
            except Exception as error:
                return self.send_json({"error": "免费数据源暂时不可用，请稍后重试或导入CSV。" + str(error)}, 502)
        relative = "index.html" if parsed.path == "/" else parsed.path.lstrip("/")
        path = (ROOT / "public" / relative).resolve()
        if (ROOT / "public").resolve() not in path.parents or not path.is_file():
            self.send_error(404)
            return
        raw = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", (mimetypes.guess_type(str(path))[0] or "application/octet-stream") + "; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print("Free Chart: http://127.0.0.1:%s" % args.port, flush=True)
    server.serve_forever()
