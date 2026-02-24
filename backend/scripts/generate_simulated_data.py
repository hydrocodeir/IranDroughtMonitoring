import csv
import math
import random
from datetime import date
from pathlib import Path

random.seed(42)
PROVINCES = ["Tehran", "Isfahan", "Fars", "Khorasan Razavi", "Khuzestan", "Mazandaran"]


def month_iter(start_year=2016, months=120):
    y, m = start_year, 1
    for _ in range(months):
        yield date(y, m, 1)
        m += 1
        if m == 13:
            m = 1
            y += 1


def stats(values):
    mean = sum(values) / len(values)
    std = (sum((v - mean) ** 2 for v in values) / len(values)) ** 0.5
    return mean, std or 1.0


def build_region(name):
    phase = random.uniform(0, 2 * math.pi)
    climate_factor = random.gauss(1.0, 0.15)
    dates = list(month_iter())
    precip, temp = [], []
    for i, d in enumerate(dates):
        seasonal_rain = 55 + 35 * math.cos((2 * math.pi * (d.month - 1) / 12) + phase)
        seasonal_temp = 19 + 12 * math.sin((2 * math.pi * (d.month - 1) / 12) + phase)
        p = max(2, seasonal_rain * climate_factor + random.gauss(0, 8))
        t = seasonal_temp + random.gauss(0, 1.6)
        precip.append(p)
        temp.append(t)

    p_mean, p_std = stats(precip)
    t_mean, t_std = stats(temp)
    rows = []
    for i, d in enumerate(dates):
        spi3 = (precip[i] - p_mean) / p_std
        spei3 = spi3 - ((temp[i] - t_mean) / t_std) * 0.28
        rows.append([
            name,
            d.isoformat(),
            round(spi3, 3),
            round(spei3, 3),
            round(precip[i], 2),
            round(temp[i], 2),
        ])
    return rows


def main():
    output = Path(__file__).resolve().parents[2] / "data" / "simulated_timeseries.csv"
    with output.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["region_name", "date", "spi3", "spei3", "precip", "temp"])
        for province in PROVINCES:
            writer.writerows(build_region(province))
    print(f"Wrote {output}")


if __name__ == "__main__":
    main()
