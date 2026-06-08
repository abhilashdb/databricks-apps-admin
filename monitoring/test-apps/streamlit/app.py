import sys
import logging

# Redirect Tornado access logs to stdout so Databricks otel telemetry captures them.
# By default Tornado logs to stderr which is NOT captured by otel_logs.
for _name in ("tornado.access", "tornado.application", "tornado.general"):
    _log = logging.getLogger(_name)
    if not any(isinstance(h, logging.StreamHandler) and h.stream is sys.stdout
               for h in _log.handlers):
        _log.addHandler(logging.StreamHandler(sys.stdout))
    _log.setLevel(logging.INFO)

import streamlit as st

st.set_page_config(page_title="Scale-to-Zero Test — Streamlit")
st.title("Scale-to-Zero Test — Streamlit")
st.write("Telemetry test app. Access logs are redirected to stdout for otel capture.")
