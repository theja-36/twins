import io
import json
import os
import unittest

from twins_capture.liveguard import LIVE_GUARD_EXIT_CODE, enforce_live_trading_guard, evaluate_live_guard

CONTRACT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "tests", "fixtures", "liveGuard", "contract.json")


class Exited(Exception):
    def __init__(self, code):
        Exception.__init__(self, code)
        self.code = code


def raise_exit(code):
    raise Exited(code)


class LiveGuardConformance(unittest.TestCase):
    def setUp(self):
        with open(CONTRACT) as handle:
            self.contract = json.load(handle)

    def test_exit_code_matches_the_contract(self):
        self.assertEqual(LIVE_GUARD_EXIT_CODE, self.contract["exitCode"])

    def test_every_contract_case(self):
        for case in self.contract["cases"]:
            ok, reasons = evaluate_live_guard(case["env"])
            self.assertEqual(ok, case["ok"], case["name"])
            self.assertEqual(reasons, case["reasons"], case["name"])

    def test_enforce_exits_with_the_code_and_prints_reason_codes_only(self):
        for case in self.contract["cases"]:
            stream = io.StringIO()
            env = dict(case["env"])
            if case["ok"]:
                enforce_live_trading_guard("capture", env, exit_fn=raise_exit, stream=stream)
                self.assertEqual(stream.getvalue(), "", case["name"])
                continue
            with self.assertRaises(Exited) as caught:
                enforce_live_trading_guard("capture", env, exit_fn=raise_exit, stream=stream)
            self.assertEqual(caught.exception.code, 81, case["name"])
            line = json.loads(stream.getvalue())
            self.assertEqual(line["reasons"], case["reasons"], case["name"])
            for value in env.values():
                if value:
                    self.assertNotIn('"%s"' % value, stream.getvalue(), case["name"])


if __name__ == "__main__":
    unittest.main()
