#!/usr/bin/env python3
"""
Simulates Grafana Faro / browser OTel SDK metrics sent via OTLP HTTP.

Produces realistic Web Vitals (LCP, FCP, CLS, INP, TTFB), JS error counts,
and page load durations so the Frontend tab has data to display.
"""

import json
import time
import random
import sys
import urllib.request
import os

OTLP_ENDPOINT = os.environ.get("OTLP_ENDPOINT", "http://localhost:4318/v1/metrics")
INTERVAL_SEC = int(os.environ.get("INTERVAL_SEC", "15"))

# Emit browser metrics for the two existing frontend services
SERVICES = [
    {"name": "frontend", "namespace": "opentelemetry-demo"},
    {"name": "frontend", "namespace": "demo"},
]

PAGES = ["/", "/products", "/cart", "/checkout", "/product/123"]
BROWSERS = ["Chrome", "Firefox", "Safari", "Edge"]


def now_ns():
    return str(int(time.time() * 1e9))


def ago_ns(seconds):
    return str(int((time.time() - seconds) * 1e9))


def gauge_dp(value, page, browser):
    return {
        "timeUnixNano": now_ns(),
        "asDouble": value,
        "attributes": [
            {"key": "page.url", "value": {"stringValue": page}},
            {"key": "browser.name", "value": {"stringValue": browser}},
        ],
    }


def gauge_metric(name, description, unit, data_points):
    return {
        "name": name,
        "description": description,
        "unit": unit,
        "gauge": {"dataPoints": data_points},
    }


def histogram_metric(name, description, unit, values):
    boundaries = [100, 500, 1000, 2000, 3000, 5000, 10000]
    counts = [0] * (len(boundaries) + 1)
    for v in values:
        placed = False
        for i, b in enumerate(boundaries):
            if v <= b:
                counts[i] += 1
                placed = True
                break
        if not placed:
            counts[-1] += 1

    return {
        "name": name,
        "description": description,
        "unit": unit,
        "histogram": {
            "dataPoints": [
                {
                    "startTimeUnixNano": ago_ns(INTERVAL_SEC),
                    "timeUnixNano": now_ns(),
                    "count": str(len(values)),
                    "sum": sum(values),
                    "min": min(values) if values else 0,
                    "max": max(values) if values else 0,
                    "bucketCounts": [str(c) for c in counts],
                    "explicitBounds": [float(b) for b in boundaries],
                }
            ],
            "aggregationTemporality": 2,
        },
    }


def counter_metric(name, description, unit, value):
    return {
        "name": name,
        "description": description,
        "unit": unit,
        "sum": {
            "dataPoints": [
                {
                    "startTimeUnixNano": ago_ns(INTERVAL_SEC),
                    "timeUnixNano": now_ns(),
                    "asDouble": value,
                }
            ],
            "aggregationTemporality": 2,
            "isMonotonic": True,
        },
    }


def build_payload():
    resource_metrics = []
    for svc in SERVICES:
        resource_metrics.append(build_service_metrics(svc["name"], svc["namespace"]))
    return {"resourceMetrics": resource_metrics}


def build_service_metrics(service_name, service_namespace):
    # Simulate several page views with realistic Web Vitals
    lcp_points = []
    fcp_points = []
    cls_points = []
    inp_points = []
    ttfb_points = []
    page_load_values = []

    num_views = random.randint(3, 8)
    for _ in range(num_views):
        page = random.choice(PAGES)
        browser = random.choice(BROWSERS)

        lcp_points.append(gauge_dp(max(50, random.gauss(2200, 600)), page, browser))
        fcp_points.append(gauge_dp(max(50, random.gauss(1400, 400)), page, browser))
        cls_points.append(gauge_dp(max(0, random.gauss(0.08, 0.04)), page, browser))
        inp_points.append(gauge_dp(max(10, random.gauss(150, 60)), page, browser))
        ttfb_points.append(gauge_dp(max(20, random.gauss(400, 150)), page, browser))
        page_load_values.append(max(200, random.gauss(3000, 800)))

    js_errors = random.choices([0, 0, 0, 1, 1, 2, 3], k=1)[0]

    metrics = [
        gauge_metric("browser.web_vitals.lcp", "Largest Contentful Paint", "ms", lcp_points),
        gauge_metric("browser.web_vitals.fcp", "First Contentful Paint", "ms", fcp_points),
        gauge_metric("browser.web_vitals.cls", "Cumulative Layout Shift", "", cls_points),
        gauge_metric("browser.web_vitals.inp", "Interaction to Next Paint", "ms", inp_points),
        gauge_metric("browser.web_vitals.ttfb", "Time to First Byte", "ms", ttfb_points),
        histogram_metric("browser.page_load.duration", "Page load duration", "ms", page_load_values),
        counter_metric("browser.errors", "JavaScript error count", "{errors}", js_errors),
    ]

    return {
        "resource": {
            "attributes": [
                {"key": "service.name", "value": {"stringValue": service_name}},
                {"key": "service.namespace", "value": {"stringValue": service_namespace}},
                {"key": "telemetry.sdk.language", "value": {"stringValue": "webjs"}},
                {"key": "telemetry.sdk.name", "value": {"stringValue": "@grafana/faro-web-sdk"}},
                {"key": "browser.platform", "value": {"stringValue": "web"}},
                {"key": "deployment.environment", "value": {"stringValue": "production"}},
            ]
        },
        "scopeMetrics": [
            {
                "scope": {"name": "faro-web-sdk", "version": "1.0.0"},
                "metrics": metrics,
            }
        ],
    }


def send_metrics():
    payload = build_payload()
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        OTLP_ENDPOINT,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status
    except Exception as e:
        return str(e)


if __name__ == "__main__":
    svc_list = ", ".join(f'{s["name"]}@{s["namespace"]}' for s in SERVICES)
    print(f"Faro simulator -> {OTLP_ENDPOINT} every {INTERVAL_SEC}s")
    print(f"Services: {svc_list}")
    sys.stdout.flush()

    while True:
        status = send_metrics()
        print(f"[{time.strftime('%H:%M:%S')}] sent — {status}")
        sys.stdout.flush()
        time.sleep(INTERVAL_SEC)
