# Current chart contract

Read the live chart_create/chart_update schemas for arguments. The packaged specs are in examples/specs, copied into example/specs by `maquette example`. They cover revenue bars, regional deliveries, two-series prices, scatter values, and positive/negative operating results.

chart_create targets a frame label or ID, accepts a spec with data/mark/encoding and returns validation plus a render. preview: true draws and then removes the preview. chart_update uses the chart ID or frame and may take replacement data. The current engine refuses updates when internal hand changes are detected, preserving the original; keeping these changes is HOT-66. Only pass discard_hand_changes: true after showing the reported changes and receiving explicit confirmation. Partial spec fields replace whole top-level objects, including encoding. A whole-chart move is retained. chart_list returns the tracked charts and specs; saving/reopening the document retains chart sidecars.
