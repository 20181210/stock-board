import datetime as dt
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from market import aggregate, clean, load_market, timestamp
import server


def fixture():
    days = ['2024-12-26', '2024-12-27', '2024-12-30', '2024-12-31',
            '2025-01-02', '2025-01-03', '2025-01-06', '2025-01-07', '2025-01-08']
    return [dict(timestamp=timestamp(day), open=10+i, high=13+i, low=8+i, close=12+i, volume=100+i)
            for i, day in enumerate(days)]


class AggregationTests(unittest.TestCase):
    def test_ohlcv_skips_holidays_and_uses_anchor(self):
        bars = aggregate(fixture(), '3', '2025-01-01')
        self.assertEqual([b['count'] for b in bars], [1, 3, 3, 2])
        self.assertEqual(bars[2], dict(timestamp=timestamp('2025-01-02'), open=14, high=19, low=12,
                                     close=18, volume=315, count=3, endTimestamp=timestamp('2025-01-06')))

    def test_earlier_history_does_not_shift_post_anchor_bars(self):
        full = aggregate(fixture(), '3', '2025-01-01')
        shorter = aggregate(fixture()[2:], '3', '2025-01-01')
        self.assertEqual(full[2:], shorter[1:])

    def test_five_sessions_differs_from_calendar_week(self):
        five = aggregate(fixture(), '5', '2025-01-01')
        week = aggregate(fixture(), 'W')
        self.assertNotEqual([b['count'] for b in five], [b['count'] for b in week])
        self.assertEqual([b['count'] for b in week], [2, 4, 3])

    def test_calendar_months(self):
        self.assertEqual([b['count'] for b in aggregate(fixture(), 'M')], [4, 5])

    def test_multiple_calendar_months(self):
        dates = ['2024-12-30', '2025-01-02', '2025-03-31', '2025-04-01', '2025-06-30', '2025-07-01', '2026-01-02']
        bars = [dict(timestamp=timestamp(day), open=10+i, high=20+i, low=9+i, close=12+i, volume=100+i) for i, day in enumerate(dates)]
        self.assertEqual([b['count'] for b in aggregate(bars, '3M', 'invalid')], [1, 2, 2, 1, 1])
        self.assertEqual([b['count'] for b in aggregate(bars, '6M', 'invalid')], [1, 4, 1, 1])
        self.assertEqual([b['count'] for b in aggregate(bars, '12M', 'invalid')], [1, 5, 1])
        self.assertEqual(aggregate(bars, '3M')[1], dict(bars[1], high=22, close=14, volume=203, count=2, endTimestamp=bars[2]['timestamp']))

    def test_multiweek_stability(self):
        dates = ['2024-12-30', '2025-01-03', '2025-01-06', '2025-01-12', '2025-01-13']
        bars = [dict(timestamp=timestamp(day), open=10, high=12, low=9, close=11, volume=1) for day in dates]
        full = aggregate(bars, '2W', 'invalid')
        self.assertEqual([b['count'] for b in full], [2, 3])
        self.assertEqual(aggregate(bars[2:], '2W', 'invalid'), full[1:])

    def test_rejects_invalid_or_out_of_range_anchor(self):
        for period in ['0', '251', '2.5', 'no', '0M', '121M', '53W', '2.5M', '1H']:
            with self.assertRaises(ValueError): aggregate(fixture(), period)
        with self.assertRaises(ValueError): aggregate(fixture(), '3', '2020-01-01')
        with self.assertRaises(ValueError): aggregate(fixture(), '3', '2030-01-01')

    def test_clean_deduplicates_sorts_and_rejects_invalid_prices(self):
        data = fixture()
        invalid = dict(data[0], high=1)
        nan = dict(data[0], open=float('nan'))
        self.assertEqual(clean([data[1], data[0], data[1], invalid, nan]), data[:2])


class ProviderTests(unittest.TestCase):
    @patch('market.fetch')
    def test_forex_column_order(self, fetch):
        fetch.return_value = '/* comment */ var _fx=("2025-01-02,1.1,1.0,1.3,1.2,|2025-01-03,1.2,1.1,1.4,1.3");'
        bars, meta = load_market('fx', 'EUR/USD')
        self.assertEqual((bars[0]['open'], bars[0]['high'], bars[0]['low'], bars[0]['close']), (1.1, 1.3, 1.0, 1.2))
        self.assertEqual(bars[0]['volume'], 0)
        self.assertEqual(meta['symbol'], 'EURUSD')

    @patch('market.sina_stock')
    def test_a_share_full_history(self, sina):
        sina.return_value = (fixture(), '比例前复权')
        bars, meta = load_market('cn', '600519')
        sina.assert_called_once_with('sh600519')
        self.assertEqual(len(bars), len(fixture()))
        self.assertEqual(meta['adjustment'], '比例前复权')

    @patch('market.fetch')
    def test_gold_uses_spot_feed(self, fetch):
        fetch.return_value = 'var _gold=([{"date":"2006-11-10","open":"630","high":"640","low":"620","close":"635"}]);'
        bars, meta = load_market('fx', 'XAUUSD')
        self.assertEqual(bars[0]['close'], 635)
        self.assertEqual(meta['symbol'], 'XAUUSD')
        self.assertIn('symbol=XAU', fetch.call_args[0][0])

    @patch('market.fetch')
    def test_crypto_paginates_until_end(self, fetch):
        from market import crypto_history
        page = [[timestamp('2017-08-17') + i * 86400000, '10', '14', '9', '12', '100'] for i in range(1000)]
        fetch.side_effect = [json.dumps(page), json.dumps([[page[-1][0] + 86400000, '10', '14', '9', '12', '100']])]
        bars = crypto_history('BTCUSDT')
        self.assertEqual(len(bars), 1001)
        self.assertIn('startTime=' + str(page[-1][0] + 86400000), fetch.call_args[0][0])

    @patch('market.subprocess.run')
    @patch('market.fetch')
    def test_stock_factor_applies_without_negative_cash_back_adjustment(self, fetch, run):
        from market import sina_stock
        run.return_value.returncode = 0
        run.return_value.stdout = json.dumps([{'date':'2000-01-01', 'open':100,'high':120,'low':90,'close':110,'volume':1000}, {'date':'2020-01-01','open':30,'high':35,'low':25,'close':32,'volume':2000}])
        fetch.side_effect = ['var K="encoded";', 'var f={"data":[{"d":"1900-01-01","f":"0.25","c":"-100"},{"d":"2010-01-01","f":"1","c":"0"}]}']
        bars, meta = sina_stock('AAPL', True)
        self.assertEqual([bar['close'] for bar in bars], [27.5, 32])

    @patch('market.fetch')
    def test_crypto_columns_and_error(self, fetch):
        fetch.return_value = json.dumps([[timestamp('2025-01-02'), '10', '14', '9', '12', '100']])
        bars, _ = load_market('crypto', 'BTC/USDT')
        self.assertEqual(bars[0]['close'], 12)
        fetch.return_value = '{"code":-1121,"msg":"Invalid symbol."}'
        with self.assertRaisesRegex(ValueError, 'Invalid symbol'): load_market('crypto', 'FOOUSDT')

    def test_invalid_symbols_rejected_before_network(self):
        for market, symbol in [('us', '../secret'), ('cn', 'hello'), ('fx', 'EURUSD&x=1'), ('crypto', '../USDT')]:
            with self.assertRaises(ValueError): load_market(market, symbol)


class CacheTests(unittest.TestCase):
    def test_upstream_failure_uses_explicitly_marked_cache(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(server, 'CACHE', Path(directory)):
            with patch.object(server, 'load_market', return_value=(fixture(), {'source': 'fixture'})):
                result = server.history('us', 'FIXTURE')
            self.assertFalse(result['stale'])
            with patch.object(server, 'load_market', side_effect=OSError('offline')):
                cached = server.history('us', 'FIXTURE', refresh=True)
            self.assertTrue(cached['stale'])
            self.assertIn('offline', cached['warning'])
            self.assertEqual(cached['bars'], fixture())

    def test_corrupt_cache_does_not_block_fresh_fetch(self):
        import hashlib
        with tempfile.TemporaryDirectory() as directory, patch.object(server, 'CACHE', Path(directory)):
            key = hashlib.sha256(b'us:FIXTURE').hexdigest()
            (Path(directory) / (key + '.json')).write_text('{broken', encoding='utf-8')
            with patch.object(server, 'load_market', return_value=(fixture(), {'source': 'fixture'})):
                self.assertFalse(server.history('us', 'FIXTURE')['cached'])


if __name__ == '__main__': unittest.main()
