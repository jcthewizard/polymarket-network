"""
Tests for the HFT TradingExecutor.

Covers:
  - Position sizing by confidence score (all bands + boundaries)
  - Dynamic TP math (midpoint, extremes $0.05 / $0.95, edges $0.01 / $0.99)
  - Exit-level calculation (TP and SL prices)

Run:  python -m pytest test_trading.py -v
"""

import pytest
from execution import TradingExecutor


# ═══════════════════════════════════════════════════════════════════════
# Position Sizing
# ═══════════════════════════════════════════════════════════════════════
class TestPositionSizing:
    """get_position_size must return the correct USDC amount per band."""

    # ---- Explicit band checks ----
    def test_band_40_60(self):
        assert TradingExecutor.get_position_size(50) == 0.50

    def test_band_60_80(self):
        assert TradingExecutor.get_position_size(70) == 1.00

    def test_band_80_100(self):
        assert TradingExecutor.get_position_size(90) == 1.50

    # ---- Boundary values ----
    def test_lower_boundary_40(self):
        """40 is IN the 40-60 band."""
        assert TradingExecutor.get_position_size(40) == 0.50

    def test_upper_boundary_59(self):
        """59.99 is still in the 40-60 band (< 60)."""
        assert TradingExecutor.get_position_size(59.99) == 0.50

    def test_boundary_60(self):
        """60 is IN the 60-80 band."""
        assert TradingExecutor.get_position_size(60) == 1.00

    def test_boundary_79(self):
        """79.99 is still in the 60-80 band (< 80)."""
        assert TradingExecutor.get_position_size(79.99) == 1.00

    def test_boundary_80(self):
        """80 is IN the 80-100 band."""
        assert TradingExecutor.get_position_size(80) == 1.50

    def test_boundary_100(self):
        """100 is the top of the 80-100 band (inclusive)."""
        assert TradingExecutor.get_position_size(100) == 1.50

    # ---- Default / out-of-range ----
    def test_below_range(self):
        """Score < 40 → default $1.00."""
        assert TradingExecutor.get_position_size(20) == 1.00

    def test_above_range(self):
        """Score > 100 → default $1.00."""
        assert TradingExecutor.get_position_size(120) == 1.00

    def test_negative_score(self):
        assert TradingExecutor.get_position_size(-5) == 1.00

    def test_zero_score(self):
        assert TradingExecutor.get_position_size(0) == 1.00


# ═══════════════════════════════════════════════════════════════════════
# Dynamic Take-Profit Math
# ═══════════════════════════════════════════════════════════════════════
class TestDynamicTP:
    """
    Formula: dynamic_tp = 0.05 * (1 - (|entry - 0.50| / 0.50))

    At entry = 0.50  →  dynamic_tp = 0.05 * (1 - 0)       = 0.05  (5 %)
    At entry = 0.05  →  dynamic_tp = 0.05 * (1 - 0.9)     = 0.005 (0.5 %)
    At entry = 0.95  →  dynamic_tp = 0.05 * (1 - 0.9)     = 0.005 (0.5 %)
    At entry = 0.01  →  dynamic_tp = 0.05 * (1 - 0.98)    = 0.001 (0.1 %)
    At entry = 0.99  →  dynamic_tp = 0.05 * (1 - 0.98)    = 0.001 (0.1 %)
    At entry = 0.00  →  dynamic_tp = 0.05 * (1 - 1.0)     = 0.0   (0 %)
    At entry = 1.00  →  dynamic_tp = 0.05 * (1 - 1.0)     = 0.0   (0 %)
    """

    def test_midpoint_050(self):
        """Maximum TP at the midpoint."""
        assert TradingExecutor.calculate_dynamic_tp(0.50) == pytest.approx(0.05)

    def test_extreme_low_005(self):
        """TP shrinks at price extremes."""
        expected = 0.05 * (1 - (0.45 / 0.50))   # 0.005
        assert TradingExecutor.calculate_dynamic_tp(0.05) == pytest.approx(expected)

    def test_extreme_high_095(self):
        """Symmetric with low extreme."""
        expected = 0.05 * (1 - (0.45 / 0.50))   # 0.005
        assert TradingExecutor.calculate_dynamic_tp(0.95) == pytest.approx(expected)

    def test_near_zero_001(self):
        expected = 0.05 * (1 - (0.49 / 0.50))   # 0.001
        assert TradingExecutor.calculate_dynamic_tp(0.01) == pytest.approx(expected)

    def test_near_one_099(self):
        expected = 0.05 * (1 - (0.49 / 0.50))   # 0.001
        assert TradingExecutor.calculate_dynamic_tp(0.99) == pytest.approx(expected)

    def test_edge_zero(self):
        """At price 0, TP modifier is exactly 0."""
        assert TradingExecutor.calculate_dynamic_tp(0.00) == pytest.approx(0.0)

    def test_edge_one(self):
        """At price 1.00, TP modifier is exactly 0."""
        assert TradingExecutor.calculate_dynamic_tp(1.00) == pytest.approx(0.0)

    def test_symmetry(self):
        """Dynamic TP is symmetric around 0.50."""
        assert TradingExecutor.calculate_dynamic_tp(0.30) == pytest.approx(
            TradingExecutor.calculate_dynamic_tp(0.70)
        )

    def test_quarter_025(self):
        expected = 0.05 * (1 - (0.25 / 0.50))   # 0.025
        assert TradingExecutor.calculate_dynamic_tp(0.25) == pytest.approx(expected)


# ═══════════════════════════════════════════════════════════════════════
# Exit Levels  (TP and SL prices)
# ═══════════════════════════════════════════════════════════════════════
class TestExitLevels:
    """
    TP = entry * (1 + dynamic_tp)
    SL = entry * (1 - 0.05)
    """

    def test_exit_at_050(self):
        tp, sl = TradingExecutor.calculate_exit_levels(0.50)
        # dynamic_tp = 0.05 → TP = 0.50 * 1.05 = 0.525
        assert tp == pytest.approx(0.525)
        # SL = 0.50 * 0.95 = 0.475
        assert sl == pytest.approx(0.475)

    def test_exit_at_005(self):
        tp, sl = TradingExecutor.calculate_exit_levels(0.05)
        dynamic_tp = 0.05 * (1 - (0.45 / 0.50))   # 0.005
        expected_tp = 0.05 * (1 + dynamic_tp)       # 0.05 * 1.005 = 0.05025
        expected_sl = 0.05 * 0.95                   # 0.0475
        assert tp == pytest.approx(expected_tp)
        assert sl == pytest.approx(expected_sl)

    def test_exit_at_095(self):
        tp, sl = TradingExecutor.calculate_exit_levels(0.95)
        dynamic_tp = 0.05 * (1 - (0.45 / 0.50))   # 0.005
        expected_tp = 0.95 * (1 + dynamic_tp)       # 0.95 * 1.005 = 0.95475
        expected_sl = 0.95 * 0.95                   # 0.9025
        assert tp == pytest.approx(expected_tp)
        assert sl == pytest.approx(expected_sl)

    def test_sl_always_below_entry(self):
        """Stop-loss must always be below entry price."""
        for price in [0.01, 0.05, 0.25, 0.50, 0.75, 0.95, 0.99]:
            tp, sl = TradingExecutor.calculate_exit_levels(price)
            assert sl < price, f"SL {sl} not below entry {price}"

    def test_tp_always_above_entry(self):
        """Take-profit must always be above entry (except at extreme 0)."""
        for price in [0.05, 0.25, 0.50, 0.75, 0.95]:
            tp, sl = TradingExecutor.calculate_exit_levels(price)
            assert tp > price, f"TP {tp} not above entry {price}"
