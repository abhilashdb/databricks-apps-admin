from flask import Flask
app = Flask(__name__)

@app.route("/")
def index():
    return "<h1>Scale-to-Zero Test — Flask</h1><p>Strategy: SCHEDULED (in-window)</p>"

@app.route("/health")
def health():
    return "ok"

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8050)
