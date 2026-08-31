"""P1 graph read-path (issue #4): Kiseki backend ← Konnektr Graph.

This package is the ONLY place that talks to the graph-client-sdk-python. The
backend serves trips from the graph (source of truth) while keeping the P0
``GET /api/trips/{token}`` contract byte-stable — the frontend never knows the
swap happened.

- ``client`` — ``GraphReadClient``: live Konnektr Graph adapter.
- ``convert`` — ``graph_to_trip``: rebuild a ``Trip`` from an ADT-shaped graph
  dict (the *inverse* of ``scripts/trip_to_graph.py``).

When the graph is not configured (no endpoint/token), the store falls back to
the baked ``trip.json`` files — graceful first boot and zero-downtime rollout.
"""
