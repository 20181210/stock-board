"""Public daily market feeds and deterministic session-based aggregation."""
import bisect
import datetime as dt
import json
import math
import os
import shutil
import subprocess
import re
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
HTTP = urllib.request.build_opener(urllib.request.ProxyHandler(
    {"https": os.environ["MARKET_PROXY"], "http": os.environ["MARKET_PROXY"]}
    if os.environ.get("MARKET_PROXY") else {}))


def fetch(url):
    request = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0", "Referer": "https://finance.sina.com.cn/"})
    with HTTP.open(request, timeout=12) as response:
        return response.read().decode("utf-8", errors="replace")


def timestamp(day):
    return int(dt.datetime.strptime(day[:10], "%Y-%m-%d").replace(tzinfo=dt.timezone.utc).timestamp() * 1000)


def clean(rows):
    result = {}
    for row in rows:
        try:
            bar = {k: float(row[k]) for k in ("open", "high", "low", "close", "volume")}
            bar["timestamp"] = int(row["timestamp"])
            if not all(math.isfinite(v) for v in bar.values()):
                continue
            if min(bar[k] for k in ("open", "high", "low", "close")) <= 0 or bar["volume"] < 0:
                continue
            if bar["high"] < max(bar["open"], bar["close"], bar["low"]) or bar["low"] > min(bar["open"], bar["close"]):
                continue
            result[bar["timestamp"]] = bar
        except (KeyError, ValueError, TypeError):
            continue
    return sorted(result.values(), key=lambda b: b["timestamp"])


def tencent(symbol, us=False):
    endpoint = "usfqkline" if us else "fqkline"
    count = 640 if us else 1500
    url = "https://web.ifzq.gtimg.cn/appstock/app/%s/get?" % endpoint
    payload = json.loads(fetch(url + urllib.parse.urlencode({"param": "%s,day,,,%s,qfq" % (symbol, count)})))
    data = payload.get("data", {}).get(symbol, {}) if isinstance(payload.get("data"), dict) else {}
    # qfqday is adjusted; do not silently mix adjusted and unadjusted history.
    key = "qfqday" if data.get("qfqday") else "day"
    bars = clean([dict(timestamp=timestamp(r[0]), open=r[1], close=r[2], high=r[3], low=r[4], volume=r[5])
                  for r in data.get(key, [])])
    quote = data.get("qt", {}).get(symbol, [])
    name = quote[1] if len(quote) > 1 else symbol
    return bars, name, "前复权" if key == "qfqday" else "原始价格（接口返回）"


def assigned_json(text):
    """Parse a JSON assignment without executing remote JavaScript."""
    start = text.find("{")
    if start < 0:
        raise ValueError("数据源没有返回有效JSON")
    return json.JSONDecoder().raw_decode(text[start:])[0]


def sina_stock(symbol, us=False):
    node = shutil.which("node")
    if not node:
        raise ValueError("完整历史解码需要Node.js，请安装Node.js后重启")
    url = ("https://finance.sina.com.cn/staticdata/us/" + symbol if us else
           "https://finance.sina.com.cn/realstock/company/" + symbol + "/hisdata/klc_kl.js")
    match = re.search(r'=\s*"([^"\n]+)"', fetch(url))
    if not match:
        raise ValueError("未找到该代码的历史数据")
    process = subprocess.run([node, str(ROOT / "sina-decoder.cjs")], input=json.dumps(match.group(1)),
                             capture_output=True, text=True, encoding="utf-8", timeout=30,
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if process.returncode:
        raise ValueError("历史行情解码失败")
    rows = json.loads(process.stdout)
    if not rows:
        raise ValueError("该品种没有历史行情")
    factors = []
    if us and not symbol.startswith("."):
        factors = assigned_json(fetch("https://finance.sina.com.cn/us_stock/company/reinstatement/" + symbol + "_qfq.js")).get("data", [])
    elif not us:
        factors = assigned_json(fetch("https://finance.sina.com.cn/realstock/company/" + symbol + "/hfq.js")).get("data", [])
    factors = sorted([(item["d"], float(item["f"])) for item in factors])
    dates = [factor[0] for factor in factors]
    latest = factors[-1][1] if factors else 1
    bars = []
    for row in rows:
        date = row["date"][:10]
        index = bisect.bisect_right(dates, date) - 1
        factor = factors[max(0, index)][1] if factors else 1
        scale = factor if us else factor / latest
        bars.append(dict(timestamp=timestamp(date), volume=row.get("volume", 0),
                         **{key: float(row[key]) * scale for key in ("open", "high", "low", "close")}))
    return clean(bars), ("拆股复权（不含现金分红）" if factors and us else "比例前复权" if factors else "原始价格 / 指数点位")


def crypto_history(code):
    bars, cursor = [], timestamp("2010-01-01")
    for _ in range(30):
        query = urllib.parse.urlencode(dict(symbol=code, interval="1d", limit=1000, startTime=cursor))
        rows = json.loads(fetch("https://data-api.binance.vision/api/v3/klines?" + query))
        if not isinstance(rows, list):
            raise ValueError(rows.get("msg", "币安未返回K线"))
        if not rows:
            return clean(bars)
        bars.extend(dict(timestamp=r[0], open=r[1], high=r[2], low=r[3], close=r[4], volume=r[5]) for r in rows)
        next_cursor = int(rows[-1][0]) + 86400000
        if next_cursor <= cursor:
            raise ValueError("加密历史分页未前进，请稍后重试")
        cursor = next_cursor
        if len(rows) < 1000:
            return clean(bars)
    raise ValueError("历史分页超过上限，未将部分数据标记为完整")


def load_market(market, symbol):
    if market == "cn":
        if not re.fullmatch(r"(?:(?:sh|sz|bj))?\d{6}", symbol.lower()):
            raise ValueError("A股请输入6位代码，例如600519、000001，也可加sh/sz/bj前缀")
        code = symbol.lower()
        if code.isdigit():
            code = ("sh" if code.startswith(("6", "5", "9")) else "bj" if code.startswith(("4", "8", "92")) else "sz") + code
        bars, adjustment = sina_stock(code)
        names = {"sh600519": "贵州茅台", "sz000001": "平安银行", "sh000001": "上证指数"}
        name = names.get(code)
        if not name:
            try:
                name = (realtime_quote("cn", code) or {}).get("name") or code.upper()
            except Exception:
                name = code.upper()
        return bars, dict(name=name, symbol=code.upper(), source="新浪财经完整历史", currency="CNY", adjustment=adjustment,
                          notice="已加载接口全部可用历史；成交量为股。比例前复权以最新价格为基准，可能与其他软件的复权算法不同。")
    if market == "us":
        code = symbol.upper()
        if not re.fullmatch(r"\.?[A-Z][A-Z0-9.\-]{0,19}", code):
            raise ValueError("美股请输入代码，例如AAPL、NVDA、NDX")
        raw = re.sub(r"\.(OQ|N|A)$", "", code)
        raw = {"NDX": ".NDX", "IXIC": ".IXIC", "SPX": ".INX", "DJI": ".DJI"}.get(raw, raw)
        bars, adjustment = sina_stock(raw, True)
        names = {"AAPL": "苹果", "NVDA": "英伟达", "SPY": "标普500 ETF", ".NDX": "纳斯达克100指数", ".IXIC": "纳斯达克综合指数", "TSLA": "特斯拉"}
        return bars, dict(name=names.get(raw, raw), symbol=code, source="新浪财经完整历史", currency="USD", adjustment=adjustment,
                         notice="已加载接口全部可用日线，不同品种起始日期不同，不含盘前盘后；可能延迟。股票按拆股比例复权，不回溯现金分红。")
    if market == "fx":
        code = symbol.upper().replace("/", "").replace("=X", "")
        if not re.fullmatch(r"[A-Z]{6}", code):
            raise ValueError("外汇请输入货币对，例如EURUSD、USDJPY")
        if code == "XAUUSD":
            text = fetch("https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_gold=/GlobalFuturesService.getGlobalFuturesDailyKLine?symbol=XAU")
            match = re.search(r"=\s*\((\[.*\])\)", text, re.S)
            if not match:
                raise ValueError("黄金数据源暂时不可用")
            rows = json.loads(match.group(1))
            bars = clean([dict(timestamp=timestamp(r["date"]), open=r["open"], high=r["high"], low=r["low"], close=r["close"], volume=0) for r in rows])
            return bars, dict(name="现货黄金", symbol="XAUUSD", source="新浪国际现货黄金 XAU", currency="USD/盎司", adjustment="不适用",
                             notice="现货黄金XAUUSD参考日线，已加载接口全部可用历史；非COMEX黄金期货，报价和日切可能与经纪商不同。")
        text = fetch("https://vip.stock.finance.sina.com.cn/forex/api/jsonp.php/var%20_fx=/NewForexService.getDayKLine?symbol=fx_s" + code.lower())
        match = re.search(r'\("(.*?)"\)', text, re.S)
        if not match:
            raise ValueError("新浪未返回该货币对的日线")
        rows = [r.split(",") for r in match.group(1).split("|")]
        bars = clean([dict(timestamp=timestamp(r[0]), open=r[1], low=r[2], high=r[3], close=r[4], volume=0)
                      for r in rows if len(r) >= 5])
        return bars, dict(name=code[:3] + " / " + code[3:], symbol=code, source="新浪财经", currency=code[3:],
            adjustment="不适用", notice="外汇参考日线；不同报价商的收盘时间和价格可能不同，无真实成交量。")
    if market == "crypto":
        code = symbol.upper().replace("/", "").replace("-", "")
        if not re.fullmatch(r"[A-Z0-9]{5,22}", code):
            raise ValueError("加密货币请输入交易对，例如BTCUSDT、ETHUSDT")
        bars = crypto_history(code)
        return bars, dict(name=code, symbol=code, source="Binance Public Data", currency="USDT" if code.endswith("USDT") else "报价币",
            adjustment="不适用", notice="现货日线，以UTC 00:00分日；最新一根可能尚未收盘；已分页加载交易对上线以来的全部可用历史。")
    raise ValueError("不支持的市场")


def _num(text):
    try:
        value = float(text)
        return value if math.isfinite(value) else None
    except (TypeError, ValueError):
        return None


def _sina_raw(url):
    """Fetch a Sina hq.sinajs.cn quote. These responses use GBK."""
    request = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0", "Referer": "https://finance.sina.com.cn/"})
    with HTTP.open(request, timeout=10) as response:
        return response.read().decode("gbk", errors="replace")


def _sina_fields(prefix, code):
    text = _sina_raw("https://hq.sinajs.cn/list=%s%s" % (prefix, code))
    match = re.search(r'="([^"]*)"', text)
    if not match or not match.group(1).strip():
        return None
    return match.group(1).split(",")


def realtime_quote(market, symbol):
    """Latest real-time quote from free public feeds.

    Returns a dict with price, prevClose, open, high, low, volume, change,
    changePercent, name, time, source. Returns None when the feed is empty.
    """
    if market == "cn":
        code = symbol.lower()
        if code.isdigit():
            code = ("sh" if code.startswith(("6", "5", "9")) else "bj" if code.startswith(("4", "8", "92")) else "sz") + code
        fields = _sina_fields("", code)
        if not fields or len(fields) < 32:
            return None
        open_price = _num(fields[1]); prev_close = _num(fields[2]); price = _num(fields[3])
        high = _num(fields[4]); low = _num(fields[5]); volume = _num(fields[8])
        if price is None or prev_close is None:
            return None
        change = price - prev_close
        return dict(name=fields[0] or code.upper(), price=price, prevClose=prev_close, open=open_price,
                    high=high, low=low, volume=volume, change=change,
                    changePercent=change / prev_close * 100 if prev_close else 0.0,
                    time="%s %s" % (fields[30], fields[31]) if len(fields) > 31 else "",
                    source="新浪财经实时行情")
    if market == "us":
        code = symbol.upper()
        raw = re.sub(r"\.(OQ|N|A)$", "", code)
        raw = {"NDX": ".NDX", "IXIC": ".IXIC", "SPX": ".INX", "DJI": ".DJI"}.get(raw, raw)
        fields = _sina_fields("gb_", raw.lower())
        if not fields or len(fields) < 27:
            return None
        # Sina US layout: [0] name [1] price [2] changePercent [3] time
        #                  [4] change [5] open [6] high [7] low [10] volume [26] prevClose
        price = _num(fields[1]); change = _num(fields[4]); prev_close = _num(fields[26])
        if price is None:
            return None
        if prev_close is None and change is not None:
            prev_close = price - change
        change_percent = _num(fields[2])
        if change_percent is None and prev_close:
            change_percent = (price - prev_close) / prev_close * 100
        if change is None and prev_close:
            change = price - prev_close
        return dict(name=fields[0] or code, price=price, prevClose=prev_close, open=_num(fields[5]),
                    high=_num(fields[6]), low=_num(fields[7]), volume=_num(fields[10]), change=change,
                    changePercent=change_percent, time=fields[3] if len(fields) > 3 else "",
                    source="新浪财经实时行情")
    if market == "fx":
        code = symbol.upper().replace("/", "").replace("=X", "")
        if code == "XAUUSD":
            fields = _sina_fields("hf_", "XAU")
            if not fields or len(fields) < 14:
                return None
            # Sina gold: [0] prevClose [1] price [2] open [3] sell [4] high
            #            [5] low [6] time [12] date [13] name
            price = _num(fields[1]); prev_close = _num(fields[0])
            if price is None:
                return None
            change = price - prev_close if prev_close else None
            time_str = "%s %s" % (fields[12], fields[6]) if len(fields) > 12 else fields[6]
            return dict(name=fields[13] if len(fields) > 13 else "现货黄金", price=price, prevClose=prev_close,
                        open=_num(fields[2]), high=_num(fields[4]), low=_num(fields[5]), volume=None,
                        change=change, changePercent=change / prev_close * 100 if prev_close else None,
                        time=time_str, source="新浪国际现货黄金")
        fields = _sina_fields("fx_s", code.lower())
        if not fields or len(fields) < 12:
            return None
        # Sina forex: [0] time [1] price [2] bid [3] ask [5] open
        #             [6] high [7] low [9] name [10] changePercent [11] change [17] date
        price = _num(fields[1])
        if price is None:
            return None
        change = _num(fields[11]); change_percent = _num(fields[10])
        prev_close = price - change if change is not None else None
        date_str = fields[17] if len(fields) > 17 else ""
        time_str = ("%s %s" % (date_str, fields[0])) if date_str else fields[0]
        return dict(name=fields[9] or code, price=price, prevClose=prev_close, open=_num(fields[5]),
                    high=_num(fields[6]), low=_num(fields[7]), volume=None, change=change,
                    changePercent=change_percent, time=time_str, source="新浪外汇实时行情")
    if market == "crypto":
        code = symbol.upper().replace("/", "").replace("-", "")
        payload = json.loads(fetch("https://api.binance.com/api/v3/ticker/24hr?symbol=" + code))
        if not isinstance(payload, dict) or "lastPrice" not in payload:
            return None
        price = _num(payload.get("lastPrice"))
        if price is None:
            return None
        prev_close = _num(payload.get("openPrice"))
        change = _num(payload.get("priceChange"))
        change_percent = _num(payload.get("priceChangePercent"))
        return dict(name=code, price=price, prevClose=prev_close, open=prev_close,
                    high=_num(payload.get("highPrice")), low=_num(payload.get("lowPrice")),
                    volume=_num(payload.get("volume")), change=change,
                    changePercent=change_percent,
                    time="", source="Binance 24h Ticker")
    raise ValueError("不支持的市场")


def parse_period(period):
    match = re.fullmatch(r"([0-9]*)([WM]?)", str(period))
    if not match or not any(match.groups()):
        raise ValueError("无效周期")
    digits, suffix = match.groups()
    unit, size = suffix or "D", int(digits or "1")
    if not 1 <= size <= {"D": 250, "W": 52, "M": 120}[unit]:
        raise ValueError("周期范围：1–250日、1–52周、1–120月")
    return unit, size


def aggregate(bars, period="3", anchor="2025-01-01"):
    """N consecutive sessions, aligned to first session on/after a fixed anchor date.

    Bars before anchor are grouped backwards; adding earlier history never shifts
    the groups after anchor. Weekly/monthly bars use calendar periods instead.
    """
    unit, size = parse_period(period)
    bars = clean(bars)
    if not bars:
        return []
    if unit == "D":
        anchor_ts = timestamp(anchor)
        if anchor_ts > bars[-1]["timestamp"]:
            raise ValueError("对齐日期晚于最新数据，请选择更早日期")
        if size > 1 and anchor_ts < bars[0]["timestamp"]:
            raise ValueError("对齐日期早于当前数据范围，请选择首条数据日期或之后，以保证分组稳定")
        anchor_index = bisect.bisect_left([b["timestamp"] for b in bars], anchor_ts)
    grouped = {}
    for index, bar in enumerate(bars):
        date = dt.datetime.fromtimestamp(bar["timestamp"] / 1000, dt.timezone.utc)
        if unit == "W":
            # Fixed Monday origin keeps multi-week boundaries stable as history grows.
            key = (date.date() - dt.date(1970, 1, 5)).days // (size * 7)
        elif unit == "M":
            key = ((date.year - 1970) * 12 + date.month - 1) // size
        else:
            key = (index - anchor_index) // size
        if key not in grouped:
            grouped[key] = dict(bar, count=1, endTimestamp=bar["timestamp"])
        else:
            out = grouped[key]
            out.update(high=max(out["high"], bar["high"]), low=min(out["low"], bar["low"]),
                       close=bar["close"], volume=out["volume"] + bar["volume"],
                       count=out["count"] + 1, endTimestamp=bar["timestamp"])
    return list(grouped.values())
