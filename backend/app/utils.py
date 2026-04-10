import math
import warnings
import pymannkendall as mk


DEFAULT_TREND_ALPHA = 0.05


def _safe_finite_float(value, fallback: float) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return fallback
    return out if math.isfinite(out) else fallback


def drought_class(value: float) -> str:
    if value >= 0:
        return "Normal/Wet"
    if value >= -0.8:
        return "D0"
    if value >= -1.3:
        return "D1"
    if value >= -1.6:
        return "D2"
    if value >= -2.0:
        return "D3"
    return "D4"


def mann_kendall_and_sen(values):
    finite_values = []
    for v in values or []:
        try:
            fv = float(v)
        except (TypeError, ValueError):
            continue
        if math.isfinite(fv):
            finite_values.append(fv)

    if len(finite_values) < 2:
        return {
            "tau": 0.0,
            "p_value": 1.0,
            "sen_slope": 0.0,
            "trend": "no trend",
            **classify_trend(0.0, 1.0, alpha=DEFAULT_TREND_ALPHA),
        }

    # hamed_rao_modification_test can fail for very short series (n < 3)
    # and some degenerate inputs. In those cases we gracefully fall back
    # to the classic Mann-Kendall test.
    result = None
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", category=RuntimeWarning)
            if len(finite_values) >= 3:
                result = mk.hamed_rao_modification_test(finite_values)
            else:
                result = mk.original_test(finite_values)
    except (ZeroDivisionError, FloatingPointError, ValueError):
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", category=RuntimeWarning)
            result = mk.original_test(finite_values)

    out = {
        "tau": _safe_finite_float(getattr(result, "Tau", None), 0.0),
        "p_value": _safe_finite_float(getattr(result, "p", None), 1.0),
        "sen_slope": _safe_finite_float(getattr(result, "slope", None), 0.0),
        "trend": str(result.trend),
    }

    # Normalize to the dashboard's 3-class trend categorization.
    out.update(classify_trend(out["sen_slope"], out["p_value"], alpha=DEFAULT_TREND_ALPHA))
    return out


def classify_trend(sen_slope: float | None, p_value: float | None, *, alpha: float = DEFAULT_TREND_ALPHA):
    """Classify trend into exactly 3 categories used across the dashboard."""

    slope = float(sen_slope) if sen_slope is not None else 0.0
    p = float(p_value) if p_value is not None else 1.0
    if not math.isfinite(p):
        p = 1.0

    if p > alpha:
        return {
            "trend_category": "none",
            "trend_label_en": "No Significant Trend",
            "trend_label_fa": "بدون روند معنی\u200cدار",
            "trend_symbol": "—",
        }
    if slope > 0:
        return {
            "trend_category": "inc",
            "trend_label_en": "Increasing Trend (Wetter)",
            "trend_label_fa": "روند افزایشی (مرطوب\u200cتر)",
            "trend_symbol": "↑",
        }
    if slope < 0:
        return {
            "trend_category": "dec",
            "trend_label_en": "Decreasing Trend (Drier)",
            "trend_label_fa": "روند کاهشی (خشک\u200cتر)",
            "trend_symbol": "↓",
        }

    # Edge case: p<=alpha but slope==0 => show as not meaningful for the UI.
    return {
        "trend_category": "none",
        "trend_label_en": "No Significant Trend",
        "trend_label_fa": "بدون روند معنی\u200cدار",
        "trend_symbol": "—",
    }
