from dash import Dash, html

app = Dash(__name__)
app.layout = html.Div([
    html.H1("Scale-to-Zero Test — Dash"),
    html.P("Strategy: IDLE_ONLY (no telemetry → skipped_no_telemetry)"),
])
server = app.server  # expose Flask server

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8050)
