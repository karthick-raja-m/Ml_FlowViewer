#!/usr/bin/env python3
import os
from app import app, socketio

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5001))
    print(f"""
╔══════════════════════════════════════════════════════════════╗
║        MLflow ETK Results Viewer                              ║
║        http://localhost:{port}                                 ║
╠══════════════════════════════════════════════════════════════╣
║  1. Run 'sso-credentials' in terminal panel                  ║
║  2. Select: commercial → standard → ml-models-dev (27)       ║
║  3. Enter JOB_ID and click 'Fetch Results'                   ║
╚══════════════════════════════════════════════════════════════╝
    """)
    socketio.run(app, debug=True, host='0.0.0.0', port=port, allow_unsafe_werkzeug=True)
