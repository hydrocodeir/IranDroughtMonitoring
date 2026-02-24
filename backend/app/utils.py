import pymannkendall as mk


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
    result = mk.original_test(values)
    return {
        "tau": float(result.Tau),
        "p_value": float(result.p),
        "sen_slope": float(result.slope),
        "trend": str(result.trend),
    }
